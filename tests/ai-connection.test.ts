import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Only the provider transport is mocked, for both the official provider and compatible endpoints.
type Behaviour =
  | { type: "ok"; model?: string }
  | { type: "error"; message: string }
  | { type: "hang" };
const probe = vi.hoisted(() => ({
  behaviour: { type: "ok" } as Behaviour,
  calls: [] as {
    api: string;
    model: string;
    apiKey?: string;
    maxTokens?: number;
    fetch?: typeof fetch;
    reasoning?: unknown;
    payload?: unknown;
    context: string;
  }[],
  makeStream: undefined as unknown as (...args: any[]) => any,
}));
async function install() {
  if (probe.makeStream) return probe.makeStream;
  const { createAssistantMessageEventStream } =
    await import("@earendil-works/pi-ai");
  probe.makeStream = (model: any, context: any, options?: any) => {
    probe.calls.push({
      api: model.api,
      model: model.id,
      apiKey: options?.apiKey,
      maxTokens: options?.maxTokens,
      fetch: options?.fetch,
      reasoning: options?.reasoning,
      payload: options?.onPayload?.({ model: model.id }, model),
      context: JSON.stringify(context),
    });
    const events = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let ended = false;
    const fail = (reason: "error" | "aborted", errorMessage: string) => {
      if (ended) return;
      ended = true;
      events.push({
        type: "error",
        reason,
        error: { ...base, stopReason: reason, errorMessage },
      });
    };
    options?.signal?.addEventListener(
      "abort",
      () => fail("aborted", "Request was aborted."),
      { once: true },
    );
    const b = probe.behaviour;
    if (b.type === "hang") return events;
    setTimeout(() => {
      if (b.type === "error") return fail("error", b.message);
      if (ended) return;
      ended = true;
      const message: AssistantMessage = {
        ...base,
        model: b.model ?? model.id,
        content: [{ type: "text", text: "ok" }],
      };
      events.push({ type: "done", reason: "stop", message });
    }, 5);
    return events;
  };
  return probe.makeStream;
}
vi.mock("@earendil-works/pi-ai/providers/openai", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@earendil-works/pi-ai/providers/openai")
    >();
  const stream = await install();
  return {
    openaiProvider: () => ({
      ...actual.openaiProvider(),
      streamSimple: stream,
      stream,
    }),
  };
});
vi.mock("@earendil-works/pi-ai/api/openai-completions.lazy", async () => {
  const stream = await install();
  return {
    openAICompletionsApi: () => ({ streamSimple: stream, stream }),
  };
});

import { AIRuntime, classifyConnectionFailure } from "../electron/ai-runtime";

let directory: string;
let runtimes: AIRuntime[];
const createRuntime = () => {
  const runtime = new AIRuntime(directory, () => {});
  runtimes.push(runtime);
  return runtime;
};
const official = { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" };
const local = { model: "qwen2.5-7b", baseUrl: "http://127.0.0.1:1234/v1" };
beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  probe.behaviour = { type: "ok" };
  probe.calls.length = 0;
  directory = await mkdtemp(join(tmpdir(), "atlas-connection-test-"));
  runtimes = [];
});
afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("「测试连接」 probe", () => {
  it("rewrites profile prose through the configured provider with system fetch and thinking off", async () => {
    const runtime = createRuntime();
    await runtime.setSettings({ ...local, apiKey: "LOCAL" });
    expect(await runtime.rewriteProfile("旧文案与新证据")).toBe("ok");
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({ model: local.model, fetch: globalThis.fetch, reasoning: undefined, maxTokens: 1600 });
    expect(probe.calls[0].context).toContain("旧文案与新证据");
  });
  it("explicitly disables thinking for gateway-prefixed DeepSeek profile rewrites", async () => {
    const runtime = createRuntime();
    await runtime.setSettings({ ...local, model: "deepseek/deepseek-v4.1-flash", apiKey: "LOCAL" });
    await runtime.rewriteProfile("认知总结");
    expect(probe.calls[0].payload).toEqual({
      model: "deepseek/deepseek-v4.1-flash",
      thinking: { type: "disabled" },
    });
  });
  it("makes one minimal request with the unsaved settings and reports model + latency", async () => {
    const runtime = createRuntime();
    const result = await runtime.testConnection({
      ...official,
      apiKey: "SECRET_TEST_KEY",
    });
    expect(result).toMatchObject({ ok: true, model: "gpt-4o-mini" });
    expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({
      model: "gpt-4o-mini",
      apiKey: "SECRET_TEST_KEY",
      maxTokens: 16,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_TEST_KEY");
    // Nothing is saved: the session stays unconfigured and no settings file is written.
    expect(runtime.getSettings()).toMatchObject({ configured: false });
    await expect(
      readFile(join(directory, "ai/settings.json"), "utf8"),
    ).rejects.toThrow();
  });
  it("tests a compatible endpoint through the Chat Completions provider", async () => {
    const runtime = createRuntime();
    const result = await runtime.testConnection({ ...local, apiKey: "LOCAL" });
    expect(result).toMatchObject({ ok: true, model: "qwen2.5-7b" });
    expect(probe.calls[0]).toMatchObject({
      api: "openai-completions",
      model: "qwen2.5-7b",
      apiKey: "LOCAL",
    });
  });
  it("reuses the session key only for the same destination", async () => {
    const runtime = createRuntime();
    await runtime.setSettings({ ...official, apiKey: "SESSION_KEY" });
    await runtime.testConnection(official);
    expect(probe.calls[0].apiKey).toBe("SESSION_KEY");
    const other = await runtime.testConnection(local);
    expect(other).toMatchObject({ ok: false, kind: "config" });
    expect(probe.calls).toHaveLength(1);
    // The saved session is left exactly as it was.
    expect(runtime.getSettings()).toMatchObject({
      ...official,
      source: "session",
    });
  });
  it("fails without a key and without calling the provider", async () => {
    const result = await createRuntime().testConnection(official);
    expect(result).toMatchObject({ ok: false, kind: "config" });
    expect(probe.calls).toHaveLength(0);
  });
  it("rejects an official model the SDK does not know as a bad model", async () => {
    const result = await createRuntime().testConnection({
      model: "made-up-model",
      baseUrl: official.baseUrl,
      apiKey: "K",
    });
    expect(result).toMatchObject({ ok: false, kind: "model" });
    expect(probe.calls).toHaveLength(0);
  });
  it.each([
    ["401 Incorrect API key provided: SECRET_TEST_KEY", "auth", "鉴权失败"],
    ["404 The model `nope` does not exist", "model", "找不到这个模型"],
    ["Connection error.", "network", "连不上"],
    ["429 You exceeded your current quota", "rate", "限流"],
    ["500 upstream exploded", "unknown", "HTTP 500"],
  ])(
    "classifies %s as %s without echoing provider text",
    async (message, kind, text) => {
      probe.behaviour = { type: "error", message };
      const result = await createRuntime().testConnection({
        ...local,
        apiKey: "SECRET_TEST_KEY",
      });
      expect(result).toMatchObject({ ok: false, kind });
      expect(!result.ok && result.message).toContain(text);
      expect(JSON.stringify(result)).not.toContain("SECRET_TEST_KEY");
      expect(JSON.stringify(result)).not.toContain(message);
    },
  );
  it("times out a hanging provider", async () => {
    probe.behaviour = { type: "hang" };
    const result = await createRuntime().testConnection(
      { ...local, apiKey: "K" },
      40,
    );
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    expect(!result.ok && result.message).toContain("15 秒");
  });
  it("rejects malformed settings before any request", async () => {
    await expect(
      createRuntime().testConnection({
        model: "gpt-4o-mini",
        baseUrl: "http://example.com/v1",
        apiKey: "K",
      }),
    ).rejects.toThrow();
    expect(probe.calls).toHaveLength(0);
  });
});

describe("classifyConnectionFailure", () => {
  it("prefers the captured HTTP status over the message text", () => {
    expect(classifyConnectionFailure({ status: 403, message: "x" }).kind).toBe(
      "auth",
    );
    expect(classifyConnectionFailure({ message: "fetch failed" }).kind).toBe(
      "network",
    );
    expect(
      classifyConnectionFailure({ timedOut: true, message: "aborted" }).kind,
    ).toBe("timeout");
  });
});

describe("connection status line", () => {
  it("describes testing, success and failure", async () => {
    const { connectionStatusText } = await import("../src/model/connection");
    expect(connectionStatusText({ phase: "idle" })).toBe("");
    expect(connectionStatusText({ phase: "testing" })).toContain("正在测试");
    expect(
      connectionStatusText({
        phase: "done",
        result: { ok: true, model: "gpt-4o-mini", latencyMs: 1234 },
      }),
    ).toBe("连接成功 · 已连到 gpt-4o-mini · 用时 1.2 秒");
    expect(
      connectionStatusText({
        phase: "done",
        result: { ok: false, kind: "auth", message: "鉴权失败：…" },
      }),
    ).toBe("鉴权失败：…");
  });
});

describe("saved API key (safeStorage)", () => {
  // A stand-in for Electron's safeStorage: reversible, but never the plaintext on disk.
  const cipher = (available = true, backend?: string) => ({
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plain: string) =>
      Buffer.from(`ENC(${[...plain].reverse().join("")})`),
    ),
    decryptString: vi.fn((data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith("ENC(")) throw new Error("bad ciphertext");
      return [...text.slice(4, -1)].reverse().join("");
    }),
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  });
  const withCipher = (c: ReturnType<typeof cipher> | null) => {
    const runtime = new AIRuntime(directory, () => {}, c);
    runtimes.push(runtime);
    return runtime;
  };
  const KEY = "sk-proj-SECRET1234abcd";
  const keyFile = () => join(directory, "ai/key.json");

  it("keeps an independently encrypted search key across model destination changes and clears it separately", async () => {
    const c = cipher();
    const runtime = withCipher(c);
    const searchKey = "sk-SEARCH_SECRET_5678";
    await runtime.setSettings({
      ...official,
      apiKey: KEY,
      deepseekApiKey: searchKey,
    });
    expect(runtime.getSettings().searchKey).toMatchObject({
      source: "saved",
      keyHint: "sk-••••5678",
    });
    const searchFile = join(directory, "ai/search-key.json");
    expect(await readFile(searchFile, "utf8")).not.toContain(searchKey);
    expect(
      await readFile(join(directory, "ai/settings.json"), "utf8"),
    ).not.toContain(searchKey);
    await runtime.setSettings(local);
    await runtime.close();
    const reopened = withCipher(c);
    expect(reopened.getSettings()).toMatchObject({
      source: "none",
      searchKey: { source: "saved", keyHint: "sk-••••5678" },
    });
    await reopened.setSettings({ ...local, deepseekApiKey: "" });
    expect(reopened.getSettings().searchKey).toEqual({ source: "none" });
    await expect(readFile(searchFile)).rejects.toThrow();
  });

  it("keeps a search key only in memory without encryption", async () => {
    const runtime = withCipher(null);
    await runtime.setSettings({ ...official, deepseekApiKey: KEY });
    expect(runtime.getSettings().searchKey?.source).toBe("session");
    await expect(
      readFile(join(directory, "ai/search-key.json")),
    ).rejects.toThrow();
    await runtime.close();
    expect(withCipher(null).getSettings().searchKey?.source).toBe("none");
  });

  it("encrypts the key at rest and restores it after a restart, masked in settings", async () => {
    const c = cipher();
    const first = withCipher(c);
    const settings = await first.setSettings({ ...official, apiKey: KEY });
    expect(settings).toMatchObject({
      source: "saved",
      configured: true,
      keyHint: "sk-••••abcd",
      keyStorage: "encrypted",
    });
    expect(JSON.stringify(settings)).not.toContain("SECRET1234");
    const onDisk = await readFile(keyFile(), "utf8");
    expect(onDisk).not.toContain("SECRET1234");
    expect(JSON.parse(onDisk)).toMatchObject({
      v: 1,
      baseUrl: official.baseUrl,
    });
    const settingsFile = await readFile(
      join(directory, "ai/settings.json"),
      "utf8",
    );
    expect(settingsFile).not.toContain("SECRET1234");
    await first.close();

    const second = withCipher(c);
    expect(second.getSettings()).toMatchObject({
      source: "saved",
      configured: true,
      keyHint: "sk-••••abcd",
    });
    // The restored key is the one used for requests.
    await second.testConnection(official);
    expect(probe.calls.at(-1)?.apiKey).toBe(KEY);
  });

  it("clearing the key removes the saved copy", async () => {
    const c = cipher();
    const runtime = withCipher(c);
    await runtime.setSettings({ ...official, apiKey: KEY });
    const cleared = await runtime.setSettings({ ...official, apiKey: "" });
    expect(cleared).toMatchObject({ configured: false, source: "none" });
    expect(cleared.keyHint).toBeUndefined();
    await expect(readFile(keyFile(), "utf8")).rejects.toThrow();
    expect(withCipher(c).getSettings().configured).toBe(false);
  });

  it("keeps the saved key when other settings change, and drops it for a new endpoint", async () => {
    const c = cipher();
    const runtime = withCipher(c);
    await runtime.setSettings({ ...official, apiKey: KEY });
    await runtime.setSettings({ ...official, model: "gpt-4o" });
    expect(runtime.getSettings()).toMatchObject({ source: "saved" });
    await runtime.setSettings(local);
    expect(runtime.getSettings()).toMatchObject({ source: "none" });
    await expect(readFile(keyFile(), "utf8")).rejects.toThrow();
  });

  it("falls back to this session only when safeStorage is unavailable", async () => {
    for (const c of [cipher(false), cipher(true, "basic_text"), null]) {
      const runtime = withCipher(c);
      const settings = await runtime.setSettings({ ...official, apiKey: KEY });
      expect(settings).toMatchObject({
        source: "session",
        keyStorage: "unavailable",
        configured: true,
      });
      await expect(readFile(keyFile(), "utf8")).rejects.toThrow();
      if (c) expect(c.encryptString).not.toHaveBeenCalled();
      await runtime.setSettings({ ...official, apiKey: "" });
    }
  });

  it("ignores an unreadable saved key instead of failing to start", async () => {
    const c = cipher();
    await withCipher(c).setSettings({ ...official, apiKey: KEY });
    c.decryptString.mockImplementation(() => {
      throw new Error("keychain reset");
    });
    expect(withCipher(c).getSettings()).toMatchObject({ configured: false });
  });
});
