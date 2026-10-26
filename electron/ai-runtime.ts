import {
  CanvasDoc,
  newCanvasWork,
  publicRun,
  createCanvasExtension,
  retireCanvasWork,
  type CanvasHost,
  type CanvasWork,
} from "./canvas-agent.js";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { maskKey, SavedKeyStore, type SecretCipher } from "./secret-store.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Message,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  Harness,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  section,
  hook,
  GenerationTask,
  watchEvents,
  LiveDoc,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type MessageChange,
  type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createWebExtension, WebDoc } from "./web-tools.js";
import { DEEPSEEK_URL } from "./web-client.js";
import type {
  AIHistory,
  Board,
  CanvasRun,
  AIRequest,
  AISettings,
  AISettingsInput,
  AIConnectionResult,
  AIUpdate,
  ChatMessage,
  ContextBundle,
} from "../src/shared/types.js";
import {
  aiRequestSchema,
  aiSettingsInputSchema,
  contextBundleSchema,
  idSchema,
} from "../src/shared/validation.js";
import {
  conversationTransferSchema,
  transferMessageSchema,
  type BoardTransfer,
} from "../src/shared/transfer.js";

import {
  canvasBundle,
  canvasTutorInstructions,
  maxOutputTokens,
  modeTemperature,
  modeThinking,
  renderScopedContext,
  tutorInstructions,
} from "./prompts.js";
export { renderScopedContext, tutorInstructions };

const CTX = BACKGROUND_CONTEXT;
/** A configured model id can carry a per-mode temperature ("gpt-4o-mini@t=0.4"); the provider sees only the id. */
const TEMPERATURE_SUFFIX = /@t=(\d+(?:\.\d+)?)$/;
export function modelRef(model: string, temperature?: number): string {
  return temperature === undefined ? model : `${model}@t=${temperature}`;
}
export function parseModelRef(ref: string): {
  id: string;
  temperature?: number;
} {
  const match = TEMPERATURE_SUFFIX.exec(ref);
  return match
    ? { id: ref.slice(0, match.index), temperature: Number(match[1]) }
    : { id: ref };
}
const DEFAULT_MODEL = "gpt-4o-mini";
const OFFICIAL_URL = "https://api.openai.com/v1";
const PROVIDER_ERROR =
  "AI_PROVIDER_ERROR: 请求未完成，请检查模型、API Key 和网络后重试。";
const OUTPUT_LIMIT_ERROR =
  "AI_OUTPUT_LIMIT: 模型输出达到上限，未能生成完整结果，本次结果未应用到画布。请重试，或换用输出容量更大的模型。";
const MISSING_KEY =
  "AI_NOT_CONFIGURED: 请先在设置中输入 API Key，或使用无需 API Key 的内置体验。";
const BUSY = "AI_BUSY: 这张便利贴正在回答，请先停止或等它完成。";

// One stable, atomically allocated ownerless conversation per sticky, in its isolated storage file.
const StickyIndex = defineDoc({
  kind: "atlas.sticky-index",
  scope: "session",
  version: 1,
  initial: (): { conversations: Record<string, number> } => ({
    conversations: {},
  }),
});
type SavedContext = {
  requestId: string;
  mode: AIRequest["mode"];
  customInstructions?: string;
  bundle: ReturnType<typeof contextBundleSchema.parse>;
};
const RequestLedger = defineDoc({
  kind: "atlas.request-ledger",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { fingerprints: Record<string, string> } => ({
    fingerprints: {},
  }),
});
const ScopedContext = defineDoc({
  kind: "atlas.scoped-context",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): SavedContext => ({
    requestId: "",
    mode: "answer",
    bundle: { topic: "", summary: "", references: [] },
  }),
});

const tutor = defineExtension({
  name: "atlas.tutor",
  tools: [],
  hooks: [
    hook(GenerationTask, {
      async afterResponse(message, api, context) {
        const doc = await api.snapshot(CanvasDoc, api.conversationId, context);
        const canvas = doc?.runs[doc.activeId];
        const web = await api.snapshot(WebDoc, api.conversationId, context);
        // Provider diagnostic bodies sometimes echo authentication headers. Strip them before durable classification.
        if (
          message.stopReason === "error" ||
          ((!canvas || canvas.status !== "running") &&
            !web?.enabled &&
            (message.stopReason === "toolUse" ||
              message.content.some((block) => block.type === "toolCall")))
        ) {
          message.stopReason = "error";
          message.errorMessage = PROVIDER_ERROR;
          message.content = [];
          message.diagnostics = [];
        }
      },
    }),
  ],
  sections: [
    section(
      "atlas-custom-instructions",
      async ({ read, conversationId }, context) => {
        const saved = await read.snapshot(
          ScopedContext,
          conversationId,
          context,
        );
        return saved?.customInstructions
          ? `用户自定义指令（用于回答方式与学习偏好；应用的工具规则和输出格式要求仍须遵守）：\n${saved.customInstructions}`
          : "";
      },
    ),
    section("atlas-tutor", async ({ read, conversationId }, context) => {
      const saved = await read.snapshot(ScopedContext, conversationId, context);
      const doc = await read.snapshot(CanvasDoc, conversationId, context);
      const work = doc?.runs[doc.activeId];
      if (work?.status === "running") return canvasTutorInstructions();
      return tutorInstructions(saved?.mode ?? "answer");
    }),
    section(
      "atlas-selected-data",
      async ({ read, conversationId }, context) => {
        const saved = await read.snapshot(
          ScopedContext,
          conversationId,
          context,
        );
        return saved
          ? renderScopedContext(saved.bundle)
          : "没有选入其他白板内容。";
      },
    ),
  ],
});

export interface TextState {
  blocks: Record<number, string>;
  text: string;
  failed: boolean;
  aborted: boolean;
  truncated: boolean;
}
export function emptyTextState(): TextState {
  return {
    blocks: {},
    text: "",
    failed: false,
    aborted: false,
    truncated: false,
  };
}
function setMessage(state: TextState, message: AssistantMessage): TextState {
  const blocks: Record<number, string> = {};
  message.content.forEach((block, index) => {
    if (block.type === "text") blocks[index] = block.text;
  });
  return {
    blocks,
    text: Object.values(blocks).join(""),
    failed: message.stopReason === "error",
    aborted: message.stopReason === "aborted",
    truncated: message.stopReason === "length",
  };
}
export function reduceTextChanges(
  previous: TextState,
  changes: readonly MessageChange[],
): TextState {
  let state = { ...previous, blocks: { ...previous.blocks } };
  for (const change of changes) {
    if (change.type === "message") state = setMessage(state, change.message);
    else if (change.type === "text_delta")
      state.blocks[change.contentIndex] =
        (state.blocks[change.contentIndex] ?? "") + change.delta;
    else if (change.type === "text_start" || change.type === "block") {
      if (change.block.type === "text")
        state.blocks[change.contentIndex] = change.block.text;
      else delete state.blocks[change.contentIndex];
    }
  }
  return {
    ...state,
    text: Object.keys(state.blocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => state.blocks[i])
      .join(""),
  };
}
function assistantOf(entry: EntryRecord): AssistantMessage | undefined {
  return entry.model?.find(
    (message): message is AssistantMessage => message.role === "assistant",
  );
}
export function reduceAgentEvent(
  state: TextState,
  event: AgentEvent,
  afterEntry = -1,
): TextState {
  if (event.type === "message_update")
    return reduceTextChanges(state, event.changes);
  if (event.type === "message_start" && event.message.role === "assistant")
    return setMessage(state, event.message);
  if (event.type === "message_end" || event.type === "entry_appended") {
    const message =
      Number(event.entry.id) > afterEntry
        ? assistantOf(event.entry)
        : undefined;
    return message ? setMessage(state, message) : state;
  }
  if (event.type === "snapshot") {
    if (event.generation?.message)
      return setMessage(state, event.generation.message);
    const latest = [...event.entries]
      .reverse()
      .find((e) => Number(e.id) > afterEntry && assistantOf(e));
    return latest ? setMessage(state, assistantOf(latest)!) : state;
  }
  return event.type === "task_failed" ? { ...state, failed: true } : state;
}
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
export function historyFromEntries(
  entries: readonly EntryRecord[],
): ChatMessage[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "atlas.imported-message") {
      return [transferMessageSchema.parse(entry.data)];
    }
    return (entry.model ?? []).flatMap((message, index): ChatMessage[] => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      if (
        message.role === "assistant" &&
        (message.stopReason === "toolUse" ||
          message.content.some((block) => block.type === "toolCall"))
      )
        return [];
      if (
        entry.kind !== "pi.user" &&
        entry.kind !== "pi.assistant" &&
        entry.kind !== "atlas.canvas-summary"
      )
        return [];
      const text = messageText(message);
      if (!text) return [];
      return [
        {
          id: `durable-${entry.id}-${index}`,
          role: message.role,
          text,
          createdAt: new Date(
            Number.isFinite(message.timestamp) ? message.timestamp : 0,
          ).toISOString(),
        },
      ];
    });
  });
}

type ActiveRun = {
  request: AIRequest;
  state: TextState;
  baseline: number;
  cancelled: boolean;
  finished: boolean;
  conversation?: Conversation;
  watcher?: AgentEventStream;
  work?: Promise<void>;
  settled: Promise<void>;
  settle: () => void;
  canvasId?: string;
  /** Stall watchdog: last time any agent event arrived, and whether the run was aborted for silence. */
  lastProgress?: number;
  stallTimer?: ReturnType<typeof setInterval>;
  stalled?: boolean;
};

/**
 * A run with no agent event (no token, thinking delta or tool call) for this long is aborted.
 * The SDK timeout only covers the response headers; a provider can keep an SSE stream open with
 * keep-alives and nothing else for many minutes.
 */
export const STALL_TIMEOUT_MS = 180_000;
export const STALL_ERROR =
  "AI 服务超过 3 分钟没有返回任何内容，已停止等待。服务商可能繁忙，请稍后重试。";

/** Default limit for the settings connection probe. */
export const CONNECTION_TIMEOUT_MS = 15_000;
const normalizeUrl = (url: string) => (url || OFFICIAL_URL).replace(/\/$/, "");
const isOfficialUrl = (url: string) => normalizeUrl(url) === OFFICIAL_URL;

/** The provider used for real requests. Shared by `ask` and the settings connection probe. */
function buildProvider(baseUrl: string, model: string): Provider {
  const original = openaiProvider();
  if (isOfficialUrl(baseUrl)) return original;
  // Reasoning models share the output budget between reasoning and the visible answer;
  // a small cap can end the request before any answer is produced.
  // https://api-docs.deepseek.com/quick_start/pricing/
  const deepSeekV4 =
    model === "deepseek-flash" || model.startsWith("deepseek-v4-");
  // pi-ai's supported custom provider API explicitly selects Chat Completions for compatible endpoints.
  return createProvider({
    id: "openai",
    name: "User-configured OpenAI-compatible endpoint",
    baseUrl,
    auth: { apiKey: original.auth.apiKey! },
    api: openAICompletionsApi(),
    models: [
      {
        id: model,
        name: model,
        provider: "openai",
        api: "openai-completions",
        baseUrl,
        // DeepSeek V4 thinks by default; marking it a reasoning model lets pi-ai send
        // thinking:{type:"disabled"} when no thinking level is set (cheap structured modes).
        reasoning: deepSeekV4,
        input: ["text"],
        contextWindow: deepSeekV4 ? 1_000_000 : 32768,
        maxTokens: maxOutputTokens(model),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

const CONNECTION_MESSAGES: Record<
  Exclude<AIConnectionResult, { ok: true }>["kind"],
  string
> = {
  config: "还没有 API Key：请先填写密钥再测试。",
  auth: "鉴权失败：API Key 无效、已过期或没有这个模型的权限。",
  model: "找不到这个模型：请检查模型 ID 是否拼写正确、该服务商是否提供。",
  network: "连不上 API 地址：请检查地址、网络或代理设置。",
  timeout: "请求超时（15 秒内没有响应）：服务商可能繁忙，或地址不可达。",
  rate: "请求被限流或额度不足（429）：稍后再试，或检查账户余额。",
  unknown: "服务商返回了错误，连接未成功。",
};

/**
 * Map a failed probe to a user-facing category. Only the HTTP status and well-known
 * phrases are inspected; the raw provider text is never returned (it can echo credentials).
 */
export function classifyConnectionFailure(input: {
  status?: number;
  message?: string;
  timedOut?: boolean;
}): Exclude<AIConnectionResult, { ok: true }> {
  const text = input.message ?? "";
  const status = input.status ?? Number(/^\s*(\d{3})\b/.exec(text)?.[1] ?? NaN);
  const known = Number.isFinite(status) ? status : undefined;
  let kind: Exclude<AIConnectionResult, { ok: true }>["kind"];
  if (input.timedOut || /timed? ?out|timeout/i.test(text)) kind = "timeout";
  else if (
    known === 401 ||
    known === 403 ||
    /api key|unauthori[sz]ed|authentication/i.test(text)
  )
    kind = "auth";
  else if (
    known === 404 ||
    /model.*(not.*(found|exist)|does not exist|invalid|unknown)|(unknown|invalid) model|model_not_found/i.test(
      text,
    )
  )
    kind = "model";
  else if (known === 429) kind = "rate";
  else if (
    known === undefined &&
    /fetch failed|connection|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket/i.test(
      text,
    )
  )
    kind = "network";
  else kind = "unknown";
  const message =
    kind === "unknown" && known !== undefined
      ? `${CONNECTION_MESSAGES.unknown}（HTTP ${known}）`
      : CONNECTION_MESSAGES[kind];
  return {
    ok: false,
    kind,
    message,
    ...(known !== undefined ? { status: known } : {}),
  };
}

function classifyConnectionFailureConfig(): AIConnectionResult {
  return { ok: false, kind: "config", message: CONNECTION_MESSAGES.config };
}

/**
 * Main-process only. The key is never written to settings, SQLite or IPC results; with a usable
 * safeStorage it is kept encrypted at rest in ai/key.json, otherwise only in memory.
 */
export class AIRuntime {
  private readonly directory: string;
  private readonly settingsPath: string;
  private model = DEFAULT_MODEL;
  private baseUrl = OFFICIAL_URL;
  private customInstructions = "";
  private searchKey: string | undefined;
  private searchKeySaved = false;
  private readonly searchKeys: SavedKeyStore;
  private sessionKey: string | undefined;
  /** True when sessionKey came from (or was written to) the encrypted store. */
  private keySaved = false;
  private readonly savedKeys: SavedKeyStore;
  private readonly credentials = new InMemoryCredentialStore();
  private readonly models: MutableModels;
  private readonly owners = new Map<string, Promise<Harness>>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly writingCanvases = new Map<string, string>();
  private readonly canvasExtension;
  private readonly webExtension;
  private settingsWrite: Promise<void> = Promise.resolve();
  private closed = false;
  private quiescing: Promise<void> | undefined;

  constructor(
    userDataDir: string,
    private readonly emit: (update: AIUpdate) => void,
    cipher: SecretCipher | null = null,
    private readonly canvasHost?: CanvasHost,
    private readonly emitCanvas: (run: CanvasRun) => void = () => {},
  ) {
    this.webExtension = createWebExtension(
      () => this.searchKey,
      async (id, owner, change) => {
        const active = this.active.get(owner);
        if (!active?.conversation) throw new Error("联网任务已停止。");
        await active.conversation.commit(async (tx) => {
          change(await tx.doc(WebDoc, id));
        }, CTX);
      },
    );
    this.canvasExtension = canvasHost
      ? createCanvasExtension(
          {
            ...canvasHost,
            acquire: async (run, expected, signal) => {
              const owner = this.writingCanvases.get(run.boardId);
              if (
                (owner && owner !== run.id) ||
                [...this.active.values()].some(
                  (active) =>
                    active.request.boardId === run.boardId &&
                    ["map", "expand"].includes(active.request.mode),
                )
              )
                throw new Error("同一画布已有写任务。");
              this.writingCanvases.set(run.boardId, run.id);
              try {
                await canvasHost.acquire(run, expected, signal);
              } catch (error) {
                if (this.writingCanvases.get(run.boardId) === run.id)
                  this.writingCanvases.delete(run.boardId);
                throw error;
              }
            },
            release: (boardId, runId) => this.releaseCanvas(boardId, runId),
          },
          (run) => this.emitCanvas(run),
          async (id, change) => {
            const active = [...this.active.values()].find(
              (a) => a.conversation?.id === id,
            );
            if (!active?.conversation) throw new Error("画布任务已停止。");
            await active.conversation.commit(async (tx) => {
              const doc = await tx.doc(CanvasDoc, id);
              change(doc.runs[doc.activeId]);
            }, CTX);
          },
        )
      : undefined;
    this.directory = join(userDataDir, "ai");
    this.settingsPath = join(this.directory, "settings.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved: unknown = JSON.parse(
        readFileSync(this.settingsPath, "utf8"),
      );
      if (saved && typeof saved === "object") {
        const value = saved as Record<string, unknown>;
        const parsed = aiSettingsInputSchema.safeParse({
          model: value.model,
          baseUrl: value.baseUrl,
          customInstructions: value.customInstructions,
        });
        if (parsed.success) {
          this.model = parsed.data.model;
          this.baseUrl = parsed.data.baseUrl;
          this.customInstructions = parsed.data.customInstructions ?? "";
        }
      }
    } catch {
      /* Missing or invalid non-secret preferences use safe defaults. */
    }
    this.models = createModels({
      credentials: this.credentials,
      authContext: {
        env: async (name) =>
          name === "OPENAI_API_KEY" && this.isOfficial()
            ? process.env.OPENAI_API_KEY
            : undefined,
        fileExists: async () => false,
      },
    });
    this.savedKeys = new SavedKeyStore(
      join(this.directory, "key.json"),
      cipher,
    );
    this.searchKeys = new SavedKeyStore(
      join(this.directory, "search-key.json"),
      cipher,
    );
    const searchSaved = this.searchKeys.load();
    if (searchSaved?.baseUrl === DEEPSEEK_URL) {
      this.searchKey = searchSaved.key;
      this.searchKeySaved = true;
    }
    const saved = this.savedKeys.load();
    // A saved key belongs to the endpoint it was saved for; never forward it elsewhere.
    if (saved && normalizeUrl(saved.baseUrl) === normalizeUrl(this.baseUrl)) {
      this.sessionKey = saved.key;
      this.keySaved = true;
      this.settingsWrite = this.credentials
        .modify("openai", async () => ({ type: "api_key", key: saved.key }))
        .then(() => undefined);
    }
    this.installProvider();
  }

  private isOfficial(url = this.baseUrl): boolean {
    return !url || url.replace(/\/$/, "") === OFFICIAL_URL;
  }
  private keyFor(boardId: string, stickyId: string): string {
    return `${idSchema.parse(boardId)}:${idSchema.parse(stickyId)}`;
  }
  getSettings(): AISettings {
    const env = this.isOfficial() ? process.env.OPENAI_API_KEY?.trim() : "";
    const source = this.sessionKey
      ? this.keySaved
        ? "saved"
        : "session"
      : env
        ? "environment"
        : "none";
    const inUse = this.sessionKey ?? env;
    let searchSource: "saved" | "session" | "none" = "none";
    if (this.searchKey)
      searchSource = this.searchKeySaved ? "saved" : "session";
    return {
      model: this.model,
      baseUrl: this.baseUrl,
      customInstructions: this.customInstructions,
      searchKey: {
        source: searchSource,
        ...(this.searchKey ? { keyHint: maskKey(this.searchKey) } : {}),
      },
      configured: source !== "none",
      source,
      ...(inUse ? { keyHint: maskKey(inUse) } : {}),
      keyStorage: this.savedKeys.available() ? "encrypted" : "unavailable",
    };
  }

  setSettings(input: AISettingsInput): Promise<AISettings> {
    const parsed = aiSettingsInputSchema.parse(input);
    const operation = this.settingsWrite.then(async () => {
      if (this.closed) throw new Error("AI_CLOSED");
      if (this.active.size) throw new Error(BUSY);
      if (
        this.isOfficial(parsed.baseUrl) &&
        !openaiProvider()
          .getModels()
          .some((model) => model.id === parsed.model)
      ) {
        throw new Error(
          "AI_INVALID_MODEL: 当前 SDK 未收录这个 OpenAI 模型，请使用 gpt-4o-mini 或设置兼容端点。",
        );
      }
      // Changing destination requires a freshly supplied key. Never forward an old provider's key silently.
      const destinationChanged =
        (this.baseUrl || OFFICIAL_URL).replace(/\/$/, "") !==
        (parsed.baseUrl || OFFICIAL_URL).replace(/\/$/, "");
      const key =
        parsed.apiKey !== undefined
          ? parsed.apiKey.trim() || undefined
          : destinationChanged
            ? undefined
            : this.sessionKey;
      // Persist only allowlisted preferences; ignore even a malicious apiKey field in a file on load.
      const nextFile = `${this.settingsPath}.tmp`;
      await writeFile(
        nextFile,
        JSON.stringify({
          model: parsed.model,
          baseUrl: parsed.baseUrl,
          customInstructions:
            parsed.customInstructions ?? this.customInstructions,
        }),
        { mode: 0o600 },
      );
      await rename(nextFile, this.settingsPath);
      if (parsed.deepseekApiKey !== undefined) {
        const searchKey = parsed.deepseekApiKey.trim() || undefined;
        await this.searchKeys.clear();
        this.searchKeySaved = searchKey
          ? await this.searchKeys.save({
              key: searchKey,
              baseUrl: DEEPSEEK_URL,
            })
          : false;
        this.searchKey = searchKey;
      }
      // A new key is saved encrypted (when possible); a cleared key or a new destination
      // without one removes the saved copy.
      if (parsed.apiKey !== undefined || destinationChanged) {
        await this.savedKeys.clear();
        this.keySaved = key
          ? await this.savedKeys.save({ key, baseUrl: parsed.baseUrl })
          : false;
      }
      this.model = parsed.model;
      this.baseUrl = parsed.baseUrl;
      this.customInstructions =
        parsed.customInstructions ?? this.customInstructions;
      this.sessionKey = key;
      if (key)
        await this.credentials.modify("openai", async () => ({
          type: "api_key",
          key,
        }));
      else await this.credentials.delete("openai");
      this.installProvider();
    });
    this.settingsWrite = operation.catch(() => undefined);
    return operation.then(() => this.getSettings());
  }

  /** Background prose rewrite, without conversation history, tools or thinking. */
  async rewriteProfile(prompt: string): Promise<string> {
    await this.settingsWrite;
    if (this.closed || !this.getSettings().configured) throw new Error(MISSING_KEY);
    const model = this.models.getModel("openai", this.model);
    if (!model) throw new Error("Missing model");
    const reply = await this.models.completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        maxTokens: 1600,
        fetch: globalThis.fetch,
        signal: AbortSignal.timeout(90000),
        // Compatible gateways may prefix model ids (e.g. deepseek/deepseek-v4.1-flash),
        // which pi-ai does not recognize as DeepSeek for its automatic thinking-off payload.
        onPayload: (payload) =>
          /(?:^|\/)deepseek-/i.test(model.id)
            ? { ...(payload as Record<string, unknown>), thinking: { type: "disabled" } }
            : undefined,
      },
    );
    if (reply.stopReason !== "stop") throw new Error("Profile rewrite failed");
    return reply.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  private installProvider(): void {
    this.models.setProvider(buildProvider(this.baseUrl, this.model));
  }

  /**
   * Make one minimal real request with the entered (unsaved) settings. Nothing is saved and
   * the active session is untouched. An empty key reuses the current session key only for
   * the same destination (and the environment key only at the official endpoint), exactly
   * like saving would. The key never leaves the main process; only a category is returned.
   */
  async testConnection(
    input: AISettingsInput,
    timeoutMs = CONNECTION_TIMEOUT_MS,
  ): Promise<AIConnectionResult> {
    const parsed = aiSettingsInputSchema.parse(input);
    if (this.closed) throw new Error("AI_CLOSED");
    const sameDestination =
      normalizeUrl(this.baseUrl) === normalizeUrl(parsed.baseUrl);
    const key =
      parsed.apiKey?.trim() ||
      (sameDestination ? this.sessionKey : undefined) ||
      (isOfficialUrl(parsed.baseUrl)
        ? process.env.OPENAI_API_KEY?.trim()
        : undefined);
    if (!key) return classifyConnectionFailureConfig();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key }));
    const models = createModels({
      credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    models.setProvider(buildProvider(parsed.baseUrl, parsed.model));
    const model = models.getModel("openai", parsed.model);
    if (!model) return classifyConnectionFailure({ status: 404 });
    let status: number | undefined;
    const fetchWithStatus: typeof fetch = async (...args) => {
      const response = await fetch(...args);
      status = response.status;
      return response;
    };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const started = Date.now();
    try {
      const reply = await models.completeSimple(
        model,
        {
          messages: [
            { role: "user", content: "Reply with: ok", timestamp: Date.now() },
          ],
        },
        { maxTokens: 16, signal: controller.signal, fetch: fetchWithStatus },
      );
      const latencyMs = Date.now() - started;
      if (reply.stopReason === "error" || reply.stopReason === "aborted")
        return classifyConnectionFailure({
          status: status && status >= 400 ? status : undefined,
          message: reply.errorMessage,
          timedOut: timedOut || reply.stopReason === "aborted",
        });
      return { ok: true, model: reply.model || parsed.model, latencyMs };
    } catch (error) {
      return classifyConnectionFailure({
        status: status && status >= 400 ? status : undefined,
        message: error instanceof Error ? error.message : undefined,
        timedOut,
      });
    } finally {
      clearTimeout(timer);
      await credentials.delete("openai");
    }
  }

  private openBoard(boardId: string, stickyId: string): Promise<Harness> {
    const ownerKey = this.keyFor(boardId, stickyId);
    if (this.closed) return Promise.reject(new Error("AI_CLOSED"));
    const existing = this.owners.get(ownerKey);
    if (existing) return existing;
    const opening = (async () => {
      const boardDirectory = join(this.directory, "boards", boardId);
      await mkdir(boardDirectory, { recursive: true, mode: 0o700 });
      const storage = await openNodeSqliteStorage(
        join(boardDirectory, `${stickyId}.sqlite`),
      );
      const registry = createRegistry();
      registry.install(tutor);
      registry.install(this.webExtension);
      if (this.canvasExtension) registry.install(this.canvasExtension);
      const canvasHost = !!this.canvasHost;
      const models = new Proxy(this.models, {
        get: (target, prop) => {
          if (prop === "getModel")
            return (provider: string, modelId: string) => {
              const { id, temperature } = parseModelRef(modelId);
              const model = target.getModel(provider, id);
              if (!model) return undefined;
              const tuned =
                temperature === undefined
                  ? model
                  : {
                      ...model,
                      samplingParams: { ...model.samplingParams, temperature },
                    };
              return canvasHost
                ? {
                    ...tuned,
                    reasoning:
                      model.reasoning ||
                      model.id === "deepseek-flash" ||
                      model.id.startsWith("deepseek-v4-"),
                    contextWindow: Math.min(
                      model.contextWindow || 96_000,
                      96_000,
                    ),
                  }
                : tuned;
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        // Keep read-only history paused. Only an explicit user request enables scheduling below.
        return await Harness.open(
          storage,
          {
            models,
            registry,
            settings: {
              retry: { enabled: false },
              compaction: {
                enabled: !!this.canvasHost,
                reserveTokens: Math.min(
                  models.getModel("openai", this.model)?.maxTokens || 16384,
                  32768,
                ),
                keepRecentTokens: 8000,
                backgroundTokens: 8000,
              },
              stream: { timeoutMs: 90_000, maxRetries: 0 },
              progress: { partialIntervalMs: 70 },
            },
            onReport: () => {
              /* Provider errors can contain secrets. Never log them. */
            },
          },
          CTX,
        );
      } catch (error) {
        await storage.close(CTX);
        throw error;
      }
    })();
    this.owners.set(ownerKey, opening);
    void opening.catch(() => {
      if (this.owners.get(ownerKey) === opening) this.owners.delete(ownerKey);
    });
    return opening;
  }

  private async findConversation(
    harness: Harness,
    stickyId: string,
    create: boolean,
  ): Promise<Conversation | undefined> {
    idSchema.parse(stickyId);
    let id: ConversationId | undefined;
    if (create) {
      id = await harness.commit(async (tx) => {
        const index = await tx.doc(StickyIndex);
        const existing = Object.hasOwn(index.conversations, stickyId)
          ? index.conversations[stickyId]
          : undefined;
        if (existing !== undefined) return existing as ConversationId;
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        await configure(tx, conversation.id, {
          extensions: [tutor],
          tools: [],
          modelTools: [],
          model: { provider: "openai", modelId: this.model },
        });
        index.conversations[stickyId] = Number(conversation.id);
        return conversation.id;
      }, CTX);
    } else {
      const index = await harness.snapshot(StickyIndex, CTX);
      const value =
        index && Object.hasOwn(index.conversations, stickyId)
          ? index.conversations[stickyId]
          : undefined;
      id = value as ConversationId | undefined;
    }
    return id === undefined ? undefined : harness.conversation(id, CTX);
  }

  async ask(input: AIRequest): Promise<void> {
    const request = aiRequestSchema.parse(input);
    await this.settingsWrite;
    if (this.closed) throw new Error("AI_CLOSED");
    if (this.quiescing)
      throw new Error("AI_QUIESCING: 正在保存并停止回答，请稍后重试。");
    if (!this.getSettings().configured) throw new Error(MISSING_KEY);
    const key = this.keyFor(request.boardId, request.stickyId);
    if (this.active.has(key)) throw new Error(BUSY);
    if (
      this.writingCanvases.has(request.boardId) &&
      ["map", "expand"].includes(request.mode)
    )
      throw new Error("AI_CANVAS_ERROR: 画布正在修改，请等待当前任务完成。");
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveRun = {
      settled,
      settle,
      request,
      state: emptyTextState(),
      baseline: -1,
      cancelled: false,
      finished: false,
    };
    this.active.set(key, active);
    try {
      const harness = await this.openBoard(request.boardId, request.stickyId);
      const conversation = await this.findConversation(
        harness,
        request.stickyId,
        true,
      );
      if (!conversation) throw new Error("AI_STORAGE_ERROR");
      active.conversation = conversation;
      const useCanvas =
        !!this.canvasHost && (request.canvas || request.mode === "organize");
      if (useCanvas) {
        active.canvasId = request.canvasRunId ?? request.requestId;
        const priorDoc = await harness.snapshot(
          CanvasDoc,
          conversation.id,
          CTX,
        );
        if (!priorDoc || !Object.hasOwn(priorDoc.runs, active.canvasId)) {
          const board = await this.canvasHost!.load(request.boardId);
          if (!board) throw new Error("AI_CANVAS_ERROR: 找不到当前画布。");
          const work = newCanvasWork(board, request);
          await conversation.commit(async (tx) => {
            const doc = await tx.doc(CanvasDoc, conversation.id);
            doc.activeId = work.id;
            doc.runs[work.id] = work;
          }, CTX);
          this.emitCanvas(publicRun(work));
        }
      }
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            prompt: request.prompt,
            mode: request.mode,
            context: request.context,
          }),
        )
        .digest("hex");
      const admitted = await conversation.commit(async (tx) => {
        // Table reads precede document writes. Reserve request content before changing replayable context.
        const existing = await tx.submissionByRequest(
          conversation.id,
          request.requestId,
        );
        const ledger = await tx.doc(RequestLedger, conversation.id);
        const priorFingerprint = Object.hasOwn(
          ledger.fingerprints,
          request.requestId,
        )
          ? ledger.fingerprints[request.requestId]
          : undefined;
        if (
          priorFingerprint !== undefined &&
          priorFingerprint !== fingerprint
        ) {
          throw new Error(
            "AI_REQUEST_CONFLICT: 此请求编号已用于不同内容，请重新发送。",
          );
        }
        ledger.fingerprints[request.requestId] = fingerprint;
        return existing;
      }, CTX);
      if (admitted?.status === "done" && admitted.type === "input") {
        const answer = await conversation.commit(
          (tx) => tx.entry(admitted.answer),
          CTX,
        );
        if (answer && assistantOf(answer))
          active.state = setMessage(active.state, assistantOf(answer)!);
        const canvas = await this.settleCanvas(
          active,
          !active.state.failed && !active.state.truncated,
        );
        this.finish(
          key,
          active,
          canvas ??
            (active.state.text && !active.state.truncated ? "done" : "error"),
        );
        return;
      }
      if (admitted?.status === "unanswered") {
        this.finish(key, active, "error");
        return;
      }
      if (
        admitted &&
        (admitted.status === "queued" || admitted.status === "placed")
      ) {
        // An explicit replay resumes its own durable request; it does not append a duplicate user input.
        const watcher = await watchEvents(harness, conversation.id, CTX);
        active.watcher = watcher;
        active.baseline =
          admitted.status === "placed"
            ? Number(admitted.entry)
            : Math.max(
                -1,
                ...watcher.snapshot.entries.map((entry) => Number(entry.id)),
              );
        active.state = reduceAgentEvent(
          active.state,
          watcher.snapshot,
          active.baseline,
        );
        watcher.start(async (events) => {
          if (active.finished) return;
          active.lastProgress = Date.now();
          for (const event of events)
            active.state = reduceAgentEvent(
              active.state,
              event,
              active.baseline,
            );
          this.publish(active, "streaming");
        });
        this.watchStall(active);
        if (active.cancelled) {
          await conversation.abort(CTX);
          await watcher.stop();
          this.finish(key, active, "cancelled");
          return;
        }
        const submission = await harness.submission(admitted.id, CTX);
        if (!submission) throw new Error("AI_STORAGE_ERROR");
        harness.resume();
        this.publish(active, "streaming");
        active.work = this.complete(key, active, submission);
        if (active.cancelled) await conversation.abort(CTX);
        return;
      }
      const prior = await harness.snapshot(LiveDoc, conversation.id, CTX);
      // A new explicit send replaces only this note's interrupted run. Separate owners keep other notes paused.
      if (prior?.run) await conversation.abort(CTX);
      if (active.cancelled) {
        this.finish(key, active, "cancelled");
        return;
      }
      await conversation.commit(async (tx) => {
        const saved = await tx.doc(ScopedContext, conversation.id);
        saved.requestId = request.requestId;
        saved.mode = request.mode;
        saved.customInstructions = this.customInstructions;
        saved.bundle = structuredClone(
          useCanvas ? canvasBundle(request.context) : request.context,
        );
        const useWeb = useCanvas || request.mode === "answer";
        const web = await tx.doc(WebDoc, conversation.id);
        web.enabled = useWeb;
        web.requestId = request.requestId;
        web.owner = key;
        web.calls = {};
        web.startedAt = Date.now();
        web.rounds = 0;
        const tools = [
          ...(useCanvas ? this.canvasExtension!.tools! : []),
          ...(useWeb ? this.webExtension.tools! : []),
        ];
        await configure(tx, conversation.id, {
          model: {
            provider: "openai",
            modelId: modelRef(
              this.model,
              useCanvas ? undefined : modeTemperature(request.mode),
            ),
          },
          thinkingLevel: useCanvas ? "low" : modeThinking(request.mode),
          extensions: [
            tutor,
            ...(useCanvas ? [this.canvasExtension!] : []),
            ...(useWeb ? [this.webExtension] : []),
          ],
          tools,
          modelTools: tools,
        });
      }, CTX);
      const watcher = await watchEvents(harness, conversation.id, CTX);
      active.watcher = watcher;
      active.baseline = Math.max(
        -1,
        ...watcher.snapshot.entries.map((entry) => Number(entry.id)),
      );
      watcher.start(async (events) => {
        if (active.finished) return;
        active.lastProgress = Date.now();
        for (const event of events)
          active.state = reduceAgentEvent(active.state, event, active.baseline);
        this.publish(active, "streaming");
      });
      this.watchStall(active);
      if (active.cancelled) {
        await watcher.stop();
        this.finish(key, active, "cancelled");
        return;
      }
      // submit() also resumes. Explicit resume documents the scheduling boundary and supports recovery.
      harness.resume();
      const submission = await conversation.submit(
        {
          type: "input",
          content: request.prompt,
          requestId: request.requestId,
          whenBusy: "reject",
        },
        CTX,
      );
      this.publish(active, "streaming");
      active.work = this.complete(key, active, submission);
      if (active.cancelled) await conversation.abort(CTX);
    } catch (error) {
      await this.settleCanvas(active, false);
      await active.watcher?.stop();
      if (this.active.get(key) === active) this.active.delete(key);
      active.finished = true;
      active.settle();
      // Only application-owned messages escape IPC. Raw SDK errors may include request data or credentials.
      if (
        error instanceof Error &&
        /^AI_(BUSY|INTERRUPTED|CLOSED|NOT_CONFIGURED|INVALID_MODEL|REQUEST_CONFLICT|CANVAS_ERROR)/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(PROVIDER_ERROR);
    }
  }

  private async complete(
    key: string,
    active: ActiveRun,
    submission: Submission,
  ): Promise<void> {
    try {
      const receipt = await submission.wait(CTX);
      await active.conversation!.waitForIdle(CTX);
      // Reconcile from committed entries, not the delivery timing of the last event batch.
      const page = await active.conversation!.entries(
        { order: "descending" },
        32,
        undefined,
        CTX,
      );
      const answerId =
        receipt.type === "input" && receipt.status === "done"
          ? receipt.answer
          : undefined;
      const entry = page.items.find((item) =>
        answerId !== undefined
          ? item.id === answerId
          : Number(item.id) > active.baseline && assistantOf(item),
      );
      if (entry) active.state = setMessage(active.state, assistantOf(entry)!);
      // A committed answer wins a racing Stop/close request and must reach the renderer's final save.
      const status =
        receipt.status === "done" &&
        active.state.text &&
        !active.state.failed &&
        !active.state.truncated &&
        !active.state.aborted
          ? "done"
          : active.stalled
            ? "error"
            : active.cancelled || active.state.aborted
              ? "cancelled"
              : "error";
      const canvasStatus = await this.settleCanvas(
        active,
        status === "done" ||
          (!!active.canvasId &&
            !active.state.failed &&
            !active.state.truncated &&
            !active.state.aborted),
      );
      await active.watcher?.stop();
      this.finish(key, active, canvasStatus ?? status);
    } catch {
      await this.settleCanvas(active, false);
      await active.watcher?.stop();
      this.finish(
        key,
        active,
        !active.stalled && (active.cancelled || this.closed)
          ? "cancelled"
          : "error",
      );
    }
  }
  private releaseCanvas(boardId: string, runId: string): void {
    if (this.writingCanvases.get(boardId) === runId)
      this.writingCanvases.delete(boardId);
    this.canvasHost?.release(boardId, runId);
  }
  private async settleCanvas(
    active: ActiveRun,
    successful: boolean,
  ): Promise<AIUpdate["status"] | undefined> {
    if (!active.canvasId || !active.conversation || !this.canvasHost) return;
    const work = await active.conversation.commit(async (tx) => {
      const doc = await tx.doc(CanvasDoc, active.conversation!.id);
      const run = doc.runs[active.canvasId!];
      if (!run) return null;
      if (run.status === "running") {
        if (this.closed || this.quiescing) run.status = "paused";
        else if (active.cancelled) run.status = "cancelled";
        else if (successful && !run.changed && run.origin === "chat") {
          run.status = "applied";
          run.summary = active.state.text;
        } else {
          run.status = "failed";
          run.error = active.state.truncated
            ? OUTPUT_LIMIT_ERROR
            : "本轮未完成画布检查，修改未提交。";
        }
      } else if (run.status === "ready" && (!successful || active.cancelled))
        run.status = active.cancelled ? "cancelled" : "failed";
      if (
        ["ready", "applied"].includes(run.status) &&
        run.summary &&
        !active.state.text &&
        !run.summaryRecorded
      ) {
        await tx.appendEntry(active.conversation!.id, {
          kind: "atlas.canvas-summary",
          model: [
            {
              role: "assistant",
              api: "openai-completions",
              provider: "openai",
              model: this.model,
              stopReason: "stop",
              timestamp: Date.now(),
              content: [{ type: "text", text: run.summary }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          ],
        });
        run.summaryRecorded = true;
      }
      if (run.status !== "ready") run.hasLock = false;
      run.updatedAt = new Date().toISOString();
      if (["applied", "failed", "cancelled", "conflict"].includes(run.status))
        retireCanvasWork(run);
      return JSON.parse(JSON.stringify(run)) as CanvasWork;
    }, CTX);
    if (!work) return;
    if (work.status !== "ready") this.releaseCanvas(work.boardId, work.id);
    this.emitCanvas(publicRun(work));
    if (work.status === "ready" || work.status === "applied") {
      if (!active.state.text) active.state.text = work.summary;
      return "done";
    }
    return work.status === "paused" || work.status === "cancelled"
      ? "cancelled"
      : "error";
  }
  async startCanvasRun(boardId: string): Promise<CanvasRun> {
    if (!this.canvasHost)
      throw new Error("AI_CANVAS_ERROR: 当前环境不支持画布 Agent。");
    const board = await this.canvasHost.load(idSchema.parse(boardId));
    if (!board) throw new Error("AI_CANVAS_ERROR: 找不到画布。");
    const requestId = "run-" + crypto.randomUUID();
    const request: AIRequest = {
      boardId,
      stickyId: "canvas-" + requestId,
      requestId,
      mode: "organize",
      canvas: true,
      prompt:
        "以最初起点为主题中心，全面校对现有画布的内容、知识层级和跨卡关系。先查看结构，按需分批读取原文并局部修改，检查全部卡片当前版本后调用 canvas_finish。",
      context: { topic: board.topic, references: [], summary: "整理全画布" },
    };
    await this.ask(request);
    const run = await this.getCanvasRun(boardId, requestId);
    if (!run) throw new Error("AI_CANVAS_ERROR: 任务创建失败。");
    return run;
  }
  private async locateCanvasRun(boardId: string, runId: string) {
    idSchema.parse(boardId);
    idSchema.parse(runId);
    const directory = join(this.directory, "boards", boardId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const file of files.filter(
      (name) =>
        name.endsWith(".sqlite") &&
        idSchema.safeParse(name.slice(0, -7)).success,
    )) {
      const stickyId = file.slice(0, -7);
      const harness = await this.openBoard(boardId, stickyId);
      const conversation = await this.findConversation(
        harness,
        stickyId,
        false,
      );
      if (!conversation) continue;
      const doc = await harness.snapshot(CanvasDoc, conversation.id, CTX);
      const work =
        doc && Object.hasOwn(doc.runs, runId) ? doc.runs[runId] : undefined;
      if (work)
        return {
          harness,
          conversation,
          work: JSON.parse(JSON.stringify(work)) as CanvasWork,
        };
    }
    return null;
  }
  async getCanvasRun(
    boardId: string,
    runId: string,
  ): Promise<CanvasRun | null> {
    const found = await this.locateCanvasRun(boardId, runId);
    if (!found) return null;
    if (
      found.work.status === "running" &&
      ![...this.active.values()].some((a) => a.canvasId === runId)
    ) {
      await found.conversation.commit(async (tx) => {
        const doc = await tx.doc(CanvasDoc, found.conversation.id);
        doc.runs[runId].status = "paused";
        doc.runs[runId].hasLock = false;
      }, CTX);
      found.work.status = "paused";
      found.work.hasLock = false;
    }
    if (
      found.work.status === "ready" &&
      ![...this.active.values()].some((a) => a.canvasId === runId)
    ) {
      await found.conversation.commit(async (tx) => {
        (await tx.doc(CanvasDoc, found.conversation.id)).runs[runId].hasLock =
          false;
      }, CTX);
      found.work.hasLock = false;
    }
    return publicRun(found.work);
  }
  async listCanvasRuns(boardId: string): Promise<CanvasRun[]> {
    const directory = join(this.directory, "boards", idSchema.parse(boardId));
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ids = new Set<string>();
    for (const file of files.filter(
      (name) =>
        name.endsWith(".sqlite") &&
        idSchema.safeParse(name.slice(0, -7)).success,
    )) {
      const sticky = file.slice(0, -7);
      const harness = await this.openBoard(boardId, sticky);
      const conversation = await this.findConversation(harness, sticky, false);
      if (!conversation) continue;
      const doc = await harness.snapshot(CanvasDoc, conversation.id, CTX);
      for (const id of Object.keys(doc?.runs ?? {})) ids.add(id);
    }
    const runs = await Promise.all(
      [...ids].map((id) => this.getCanvasRun(boardId, id)),
    );
    return runs
      .filter((r): r is CanvasRun => !!r)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ draft: _draft, ...run }) => run);
  }
  async cancelCanvasRun(boardId: string, runId: string): Promise<void> {
    const found = await this.locateCanvasRun(boardId, runId);
    if (!found) return;
    if (found.work.status === "applied") return;
    await found.conversation.commit(async (tx) => {
      const run = (await tx.doc(CanvasDoc, found.conversation.id)).runs[runId];
      run.status = "cancelled";
      run.hasLock = false;
      run.updatedAt = new Date().toISOString();
    }, CTX);
    this.releaseCanvas(boardId, runId);
    this.emitCanvas(
      publicRun({ ...found.work, status: "cancelled", hasLock: false }),
    );
    await this.stop(boardId, found.work.stickyId);
  }
  async resumeCanvasRun(boardId: string, runId: string): Promise<void> {
    const found = await this.locateCanvasRun(boardId, runId);
    if (!found || found.work.status !== "paused")
      throw new Error("AI_CANVAS_ERROR: 只能继续暂停的任务。");
    const current = await this.canvasHost!.load(boardId);
    if (
      !current ||
      (await import("../src/shared/canvas.js")).canvasFingerprint(current) !==
        found.work.baseFingerprint
    )
      throw new Error("AI_CANVAS_ERROR: 原画布已更新，请重新开始。");
    if (this.active.has(this.keyFor(boardId, found.work.stickyId)))
      throw new Error(BUSY);
    await found.conversation.abort(CTX);
    await found.conversation.commit(async (tx) => {
      const doc = await tx.doc(CanvasDoc, found.conversation.id);
      const work = doc.runs[runId];
      doc.activeId = runId;
      work.status = "running";
      work.rounds = 0;
      work.elapsedMs = 0;
      work.sliceStartedAt = Date.now();
      work.hasLock = false;
    }, CTX);
    this.emitCanvas(
      publicRun({ ...found.work, status: "running", hasLock: false }),
    );
    const request: AIRequest = {
      boardId,
      stickyId: found.work.stickyId,
      requestId: "resume-" + crypto.randomUUID(),
      mode: found.work.origin === "organize" ? "organize" : "answer",
      canvas: true,
      prompt:
        "继续上次暂停的画布任务。通过工具重新读取进度与当前工作副本，完成未校对内容。",
      context: {
        topic: current.topic,
        references: [],
        summary: "继续画布任务",
      },
    };
    await this.ask({ ...request, canvasRunId: runId });
  }
  async commitCanvasRun(boardId: string, runId: string): Promise<Board> {
    const found = await this.locateCanvasRun(boardId, runId);
    if (!found || !this.canvasHost)
      throw new Error("AI_CANVAS_ERROR: 找不到任务。");
    if (found.work.status === "applied") {
      const board = await this.canvasHost.load(boardId);
      if (!board) throw new Error("找不到画布。");
      return board;
    }
    if (found.work.status !== "ready")
      throw new Error("AI_CANVAS_ERROR: 任务尚未完成校验。");
    let board: Board;
    try {
      const existing = await this.canvasHost.load(boardId);
      if (existing?.appliedCanvasRuns?.includes(runId)) board = existing;
      else {
        if (found.work.changed && !found.work.hasLock) {
          const locking = {
            ...found.work,
            status: "running" as const,
            phase: "locking" as const,
          };
          this.writingCanvases.set(boardId, runId);
          this.emitCanvas(publicRun(locking));
          await this.canvasHost.acquire(
            publicRun(locking),
            found.work.baseFingerprint,
          );
        }
        board = found.work.changed
          ? await this.canvasHost.commit(
              boardId,
              runId,
              found.work.baseFingerprint,
              found.work.operations,
            )
          : (await this.canvasHost.load(boardId))!;
      }
    } catch (error) {
      await found.conversation.commit(async (tx) => {
        (await tx.doc(CanvasDoc, found.conversation.id)).runs[runId].status =
          "conflict";
      }, CTX);
      this.releaseCanvas(boardId, runId);
      this.emitCanvas(
        publicRun({
          ...found.work,
          status: "conflict",
          error: "画布版本冲突，结果未提交。",
        }),
      );
      throw new Error("AI_CANVAS_ERROR: 画布版本冲突，结果未提交。");
    }
    await found.conversation.commit(async (tx) => {
      const work = (await tx.doc(CanvasDoc, found.conversation.id)).runs[runId];
      work.status = "applied";
      work.phase = "complete";
      work.hasLock = false;
      work.updatedAt = new Date().toISOString();
      if (
        ![...this.active.values()].some((active) => active.canvasId === runId)
      )
        retireCanvasWork(work);
    }, CTX);
    this.releaseCanvas(boardId, runId);
    this.emitCanvas(
      publicRun({
        ...found.work,
        status: "applied",
        phase: "complete",
        hasLock: false,
        draft: board,
      }),
    );
    return board;
  }
  private publish(active: ActiveRun, status: AIUpdate["status"]): void {
    if (active.finished) return;
    const { boardId, stickyId, requestId } = active.request;
    try {
      this.emit({
        boardId,
        stickyId,
        requestId,
        text: active.state.text,
        status,
        ...(status === "error"
          ? {
              error: active.stalled
                ? STALL_ERROR
                : active.state.truncated
                  ? OUTPUT_LIMIT_ERROR
                  : PROVIDER_ERROR,
            }
          : {}),
      });
    } catch {
      /* A detached renderer must not fail persistence. */
    }
  }
  /** Abort a run that has gone silent; it ends as an error the renderer can retry. */
  /** Silence limit for a run; tests shorten it. */
  stallTimeoutMs = STALL_TIMEOUT_MS;
  private watchStall(active: ActiveRun, limit = this.stallTimeoutMs): void {
    active.lastProgress = Date.now();
    if (active.stallTimer) clearInterval(active.stallTimer);
    active.stallTimer = setInterval(
      () => {
        if (active.finished || active.cancelled) {
          clearInterval(active.stallTimer);
          return;
        }
        if (Date.now() - (active.lastProgress ?? 0) < limit) return;
        clearInterval(active.stallTimer);
        active.stalled = true;
        void active.conversation?.abort(CTX).catch(() => {});
      },
      Math.min(5_000, limit),
    );
    active.stallTimer.unref?.();
  }
  private finish(
    key: string,
    active: ActiveRun,
    status: AIUpdate["status"],
  ): void {
    if (active.finished) return;
    if (active.stallTimer) clearInterval(active.stallTimer);
    this.publish(active, status);
    active.finished = true;
    if (this.active.get(key) === active) this.active.delete(key);
    active.settle();
  }

  async stop(boardId: string, stickyId: string): Promise<void> {
    const key = this.keyFor(boardId, stickyId);
    const active = this.active.get(key);
    if (active) {
      active.cancelled = true;
      try {
        if (active.conversation) await active.conversation.abort(CTX);
      } finally {
        await active.settled;
      }
      return;
    }
    // A cancelled/reopened interrupted request remains durable; abort is an explicit user action.
    const harness = await this.openBoard(boardId, stickyId);
    const conversation = await this.findConversation(harness, stickyId, false);
    if (conversation) await conversation.abort(CTX);
  }

  /** Restore passive transcript entries. This never resumes scheduling or calls a provider. */
  async importHistory(
    boardId: string,
    input: BoardTransfer["conversations"][number],
  ): Promise<void> {
    idSchema.parse(boardId);
    const { noteId, messages } = conversationTransferSchema.parse(input);
    const harness = await this.openBoard(boardId, noteId);
    const conversation = (await this.findConversation(harness, noteId, true))!;
    await conversation.commit(async (tx) => {
      const existing = await tx.scanEntries(
        { conversationId: conversation.id },
        1,
      );
      if (existing.items.some((entry) => entry.model?.length))
        throw new Error("不能覆盖已有对话。");
      for (const [index, message] of messages.entries()) {
        const timestamp = Date.parse(message.createdAt);
        const model: Message =
          message.role === "user"
            ? { role: "user", content: message.text, timestamp }
            : {
                role: "assistant",
                content: [{ type: "text", text: message.text }],
                api: "openai-completions",
                provider: "openai",
                model: "imported",
                stopReason: "stop",
                timestamp,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              };
        await tx.appendEntry(conversation.id, {
          kind: "atlas.imported-message",
          model: [model],
          data: {
            ...message,
            // Imported ids occupy a separate namespace from this database's durable entries.
            id: `imported-${index}`,
          },
        });
      }
    }, CTX);
  }

  /** Only used to roll back a failed import under its freshly allocated board id. */
  async discardImportedBoard(boardId: string): Promise<void> {
    idSchema.parse(boardId);
    for (const [key, owner] of this.owners) {
      if (!key.startsWith(`${boardId}:`)) continue;
      const harness = await owner;
      await harness.close(CTX);
      this.owners.delete(key);
    }
    await rm(join(this.directory, "boards", boardId), {
      recursive: true,
      force: true,
    });
  }

  async getHistory(boardId: string, stickyId: string): Promise<AIHistory> {
    const key = this.keyFor(boardId, stickyId);
    const harness = await this.openBoard(boardId, stickyId);
    const conversation = await this.findConversation(harness, stickyId, false);
    if (!conversation) return { messages: [], running: false };
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      const page = await conversation.entries(
        { order: "ascending" },
        200,
        cursor,
        CTX,
      );
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const live = await harness.snapshot(LiveDoc, conversation.id, CTX);
    return {
      messages: historyFromEntries(entries),
      running: this.active.has(key) || Boolean(live?.run),
    };
  }

  /**
   * Stop admitted and still-admitting requests, then drain their watchers before a renderer save handshake.
   * Credentials and storage owners remain usable if the user cancels closing after a save failure.
   */
  quiesce(): Promise<void> {
    if (this.quiescing) return this.quiescing;
    const runs = [...this.active.values()];
    for (const active of runs) active.cancelled = true;
    const operation = (async () => {
      const results = await Promise.allSettled(
        runs.map(async (active) => {
          try {
            if (active.conversation) await active.conversation.abort(CTX);
          } finally {
            // Covers initial SQLite opening and submission admission, not just an existing work promise.
            await active.settled;
          }
        }),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error(
          "AI_QUIESCE_ERROR: 停止回答时出现问题，请检查保存状态后重试。",
        );
      }
    })();
    this.quiescing = operation;
    const clear = () => {
      if (this.quiescing === operation) this.quiescing = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.canvasHost) await this.quiesce();
    for (const [boardId, runId] of this.writingCanvases)
      this.releaseCanvas(boardId, runId);
    this.closed = true;
    await this.settingsWrite;
    for (const active of this.active.values()) {
      active.cancelled = true;
      await active.watcher?.stop();
    }
    const owners = await Promise.allSettled(this.owners.values());
    await Promise.all(
      owners.map((owner) =>
        owner.status === "fulfilled" ? owner.value.close(CTX) : undefined,
      ),
    );
    // Closing storage cancels waiting tasks; drain their adapter callbacks before forgetting the owners.
    await Promise.all(
      [...this.active.values()].map((active) => active.settled),
    );
    this.active.clear();
    this.owners.clear();
    this.sessionKey = undefined;
    this.searchKey = undefined;
    await this.credentials.delete("openai");
  }
}

/** Offline smoke used by the packaged Electron build; no submission, provider refresh or credential lookup. */
export async function smokeDurableStorage(
  directory: string,
): Promise<{ ok: true; conversationId: number }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "durable-smoke.sqlite");
  const options = {
    models: createModels({
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    }),
    registry: createRegistry(),
  };
  let owner = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    CTX,
  );
  let id: ConversationId;
  try {
    id = await owner.commit(async (tx) => {
      const index = await tx.doc(StickyIndex);
      if (Object.hasOwn(index.conversations, "smoke"))
        return index.conversations.smoke as ConversationId;
      const record = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      index.conversations.smoke = Number(record.id);
      return record.id;
    }, CTX);
  } finally {
    await owner.close(CTX);
  }
  owner = await Harness.open(await openNodeSqliteStorage(path), options, CTX);
  try {
    const stored = await owner.snapshot(StickyIndex, CTX);
    const conversation = await owner.conversation(id!, CTX);
    if (stored?.conversations.smoke !== Number(id!) || !conversation)
      throw new Error("DURABLE_SMOKE_FAILED");
    return { ok: true, conversationId: Number(id!) };
  } finally {
    await owner.close(CTX);
  }
}
