import type { Page } from "@playwright/test";

/**
 * Installs a scripted stand-in for the Electron preload bridge (window.atlas) so web e2e can
 * drive configured-AI flows. Nothing reaches a model; answers are canned per request mode.
 */
export async function installFakeAtlas(
  page: Page,
  configured = true,
  platform = "web",
  /** Boards on "disk": kept in localStorage so they survive a reload, like the Electron files. */
  seed?: unknown[],
) {
  await page.addInitScript(
    ([isConfigured, os, seeded]: [boolean, string, string | null]) => {
      const fullscreen = new Set<(value: boolean) => void>();
      (window as any).__setFullscreen = (value: boolean) =>
        fullscreen.forEach((l) => l(value));
      const DISK = "fake-atlas-disk";
      if (seeded && localStorage.getItem(DISK) === null)
        localStorage.setItem(DISK, seeded);
      const boards = new Map<string, any>(
        (JSON.parse(localStorage.getItem(DISK) ?? "[]") as any[]).map((b) => [
          b.id,
          b,
        ]),
      );
      const persist = () =>
        localStorage.setItem(DISK, JSON.stringify([...boards.values()]));
      const listeners = new Set<(update: any) => void>();
      const asks: any[] = [];
      (window as any).__atlasAsks = asks;
      // Ghost-hint requests are recorded apart so flows that count asks stay exact.
      const hints: any[] = [];
      // Gate judge, regenerate and check-marking calls: recorded apart so ask counts stay exact.
      const gates: any[] = [];
      (window as any).__atlasGates = gates;
      /**
       * Test answers are written as plain cards; give them the gate's internal fields so they pass
       * the new-knowledge gate's cheap checks (set __atlasRawCards to send them as written).
       */
      const gateFill = (text: string) => {
        if ((window as any).__atlasRawCards) return text;
        try {
          const j = JSON.parse(text);
          if (!Array.isArray(j.nodes)) return text;
          j.nodes = j.nodes.map((n: any) => ({
            newIdea: n.title,
            substance: [{ kind: "mechanism", text: n.body || n.title }],
            addsBeyond: "比父卡多了一个具体机制",
            claims: [n.title],
            check: { q: "假如换到一个完全不同的场景里，这一点还会照样成立吗？说出理由。", keyPoints: [n.title] },
            ...n,
          }));
          return JSON.stringify(j);
        } catch {
          return text;
        }
      };
      (window as any).__atlasHints = hints;
      // So are the quiet diagram/overview follow-ups after new cards land.
      const enriches: any[] = [];
      (window as any).__atlasEnriches = enriches;
      // The learning-plan request before the first level.
      const plans: any[] = [];
      (window as any).__atlasPlans = plans;
      const answer = (request: any) => {
        // The post-probe chat: queued replies (with an optional ```json proposal tail), else a plain answer.
        if (request.mode === "chat")
          return (
            (window as any).__atlasChatAnswers?.shift() ??
            "等待期是合同生效后的一段观察时间，这段时间里首次确诊的重疾通常不赔，只退保费。"
          );
        if (request.mode === "plan")
          return (
            (window as any).__atlasPlanAnswers?.shift() ??
            (/重疾/.test(request.prompt) ? JSON.stringify({
              intent: "decision",
              goal: "学完后，能看懂一份重疾险合同里决定赔不赔、赔多少的关键条款。",
              learner: "知道重疾险确诊给钱，不熟条款",
              blocks: [
                { id: "b1", title: "哪些病算重疾？", why: "能不能赔的前提", parent: null, prerequisites: [], core: true },
                { id: "b2", title: "等待期和健康告知怎么影响理赔？", why: "最常见的拒赔原因", parent: null, prerequisites: ["b1"], core: true },
                { id: "b3", title: "多次赔付和分组怎么取舍？", why: "产品选择", parent: null, prerequisites: ["b2"], core: true },
              ],
              outOfScope: ["保险公司财务"],
            }) : null) ??
            JSON.stringify({
              intent: "mechanism",
              goal: "学完后，能解释彩虹为什么是一道有固定颜色顺序的弧。",
              learner: "知道折射，不懂为什么会弯",
              blocks: [
                { id: "b1", title: "阳光里有哪些颜色？", why: "色散的前提", parent: null, prerequisites: [], core: true },
                { id: "b2", title: "水滴怎样让光拐弯？", why: "核心机制", parent: null, prerequisites: ["b1"], core: true },
                { id: "b2a", title: "折射率为什么随颜色变？", why: "颜色分开的原因", parent: "b2", prerequisites: [], core: true },
                { id: "b3", title: "为什么是一道弧？", why: "几何角度", parent: null, prerequisites: ["b2"], core: true },
                { id: "b3a", title: "副虹从哪来？", why: "常见追问", parent: "b3", prerequisites: [], core: false },
              ],
              outOfScope: ["光的波粒二象性"],
            })
          );
        if (request.mode === "enrich")
          return (
            (window as any).__atlasEnrichAnswers?.shift() ??
            JSON.stringify({ visuals: [], overviews: [] })
          );
        if (request.mode === "organize")
          return (window as any).__atlasOrganizationAnswers?.shift() ?? "{}";
        if (request.mode === "gate")
          return (
            (window as any).__atlasGateAnswers?.shift() ??
            JSON.stringify({
              verdicts: [...request.prompt.matchAll(/"id":"([^"]+)","card"/g)].map((m: any) => ({ id: m[1], adds: "多了一个具体机制", pass: true })),
            })
          );
        if (request.mode === "mark") {
          const queued = (window as any).__atlasMarkAnswers?.shift();
          if (queued) return queued;
          if (request.prompt.startsWith("探测题"))
            return JSON.stringify({ verdict: "correct", missing: "" });
          if (request.prompt.startsWith("起点问题"))
            return JSON.stringify({ lit: [...request.prompt.matchAll(/"id":"(s\d+)"/g)].map((m: any) => m[1]), pass: true, missing: "" });
          return JSON.stringify({ pass: true, missing: "" });
        }
        if (request.mode === "probe") {
          const queued = (window as any).__atlasProbeAnswers?.shift();
          if (queued) return queued;
          if (request.prompt.includes("类比"))
            return JSON.stringify({ analogy: "就像新办的健身卡有一段冷静期：这段时间里出的事，不算在卡的保障里。" });
          if (request.prompt.includes("这两点之间")) return JSON.stringify({ adjacent: true, points: [] });
          const deeper = /学习者已经懂「([^」]+)」/.exec(request.prompt);
          // Distinct deeper concepts per expansion (names only, no depth suffixes).
          const DEEP = ["精算定价", "核保规则", "再保险安排", "监管口径", "现金价值", "费率可调", "保单贷款", "红利分配", "责任准备金", "长期偿付", "风险分散", "资产负债匹配"];
          let descs = ["生病了保险给钱", "给付型 vs 报销型", "合同结构", "条款细读", "产品取舍"];
          if (deeper) {
            const at = ((window as any).__atlasDeep = ((window as any).__atlasDeep ?? -1) + 1) % 3;
            descs = DEEP.slice(at * 4, at * 4 + 4);
          }
          return JSON.stringify({
            points: descs.map((desc, i) => ({
              concept: desc,
              keyPoints: ["要点" + i],
              probe:
                !deeper && i === 2
                  ? { q: "小李投保重疾险第 2 个月，就确诊了合同里列明的重疾。这笔理赔最可能卡在哪一条？", options: ["疾病定义：这种病不在合同里", "等待期：投保后一段时间内确诊不赔或只退保费", "免责条款：所有癌症都不赔"], answer: 1 }
                  : { q: `小李在投保重疾险时遇到了和「${desc}」有关的情况，三种处理里哪一种最稳妥？`, options: ["凭常识直接判断就行", "先核对合同里的具体约定", "先问身边买过的朋友"], answer: 1 },
            })),
          });
        }
        const picked = /学习者从提示里选了这个方向：「([^」]+)」/.exec(request.prompt);
        if (request.mode === "expand" && picked && !(window as any).__atlasExpansionAnswers?.length)
          return gateFill(
            JSON.stringify({
              nodes: [
                {
                  id: "hint-card",
                  parent: "anchor",
                  title: picked[1],
                  body: `${picked[1]}：比如在一个示例情况里，条件一变，结果就跟着变，所以判断前先看清条件。`,
                  substance: [{ kind: "example", text: "比如在一个示例情况里，条件一变，结果就跟着变", isExample: true }],
                  ...(/depthType 写 "(\w+)"/.exec(request.prompt) ? { depthType: /depthType 写 "(\w+)"/.exec(request.prompt)![1] } : {}),
                },
              ],
              relations: [],
            }),
          );
                if (request.mode === "expand" || request.mode === "regen")
          return gateFill(
            (window as any).__atlasExpansionAnswers?.shift() ??
            JSON.stringify({ nodes: [], relations: [] })
          );
        if (request.mode === "hint") {
          const i = hints.indexOf(request);
          return JSON.stringify({
            below: "提示·子" + i,
            right: "提示·并列" + i,
            above: "提示·更大" + i,
            ...((window as any).__atlasHintAngles
              ? {
                  angles: { below: "why", right: "compare", above: "apply" },
                  more: [
                    { angle: "example", text: "例子·子" + i },
                    { angle: "edge", text: "边界·子" + i },
                  ],
                }
              : {}),
          });
        }
        if (request.mode === "map")
          return gateFill((window as any).__atlasMapAnswers?.shift() ?? JSON.stringify({
            nodes: [
              {
                id: "light",
                block: "b1",
                title: "阳光里有哪些颜色？",
                body: "白光其实混着很多颜色。",
                summary: "白光是红到紫多种颜色的混合。",
                keyPoints: [
                  "可见光波长约 380–750 纳米",
                  "三棱镜能把白光分成连续色带",
                  "不同颜色在水中折射率略有不同",
                ],
                whyItMatters: "颜色本来就在阳光里，彩虹只是把它们分开。",
                example: "用一杯水和手电筒，在墙上也能照出一小段彩带。",
                misconception: "误解：水滴给光“染了色”；其实：只是把已有的颜色分开。",
                depthType: "what",
                sources: [{ title: "牛顿《光学》", url: "https://en.wikipedia.org/wiki/Opticks" }],
              },
              {
                id: "bend",
                block: "b2",
                title: "水滴怎样让光拐弯？",
                body: "进出水滴时光会折射。",
              },
              {
                id: "arc",
                block: "b3",
                title: "为什么是一道弧？",
                body: "只有特定角度的光会进到眼里。",
              },
            ],
            // A chain the old “first incoming edge” rule turned into a vertical stack.
            relations: [
              { source: "light", target: "bend", label: "先看" },
              { source: "bend", target: "arc", label: "然后" },
            ],
          }));
        return "在开始之前想先了解你：你听说过光的“折射”吗？你更想弄懂颜色从哪来，还是彩虹为什么是弯的？接下来我们会先拆成三个子问题：阳光的颜色、水滴里的折射、弧形的角度。";
      };
      let settings: any = {
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        configured: isConfigured,
        source: isConfigured ? "saved" : "none",
        keyStorage: "encrypted",
        ...(isConfigured ? { keyHint: "sk-••••7f3a" } : {}),
      };
      const canvasListeners = new Set<(event: any) => void>();
      const canvasRuns = new Map<string, any>();
      for (const run of (window as any).__atlasSeedRuns ?? []) canvasRuns.set(run.id, run);
      const emitCanvas = (run: any) => {
        canvasRuns.set(run.id, run);
        canvasListeners.forEach((callback) =>
          callback({ run: structuredClone(run) }),
        );
      };
      const startCanvas = async (
        boardId: string,
        origin = "organize",
        requestId?: string,
      ) => {
        if ((window as any).__atlasOrganizationError)
          throw new Error("整理请求失败，请重试。");
        const board = structuredClone(boards.get(boardId));
        const id = requestId ?? "canvas-" + crypto.randomUUID();
        const run = {
          id,
          boardId,
          stickyId: origin === "organize" ? "canvas-" + id : "chat-canvas",
          origin,
          status: "running",
          phase: "structure",
          revision: 0,
          reviewed: 0,
          total: board.nodes.length,
          changed: false,
          summary: "",
          draft: board,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        emitCanvas(run);
        setTimeout(() => {
          if (canvasRuns.get(id)?.status !== "running") return;
          emitCanvas({ ...run, phase: "locking" });
        }, 100);
        return structuredClone(run);
      };
      (window as any).atlas = {
        platform: os,
        onFullscreenChange: (callback: (value: boolean) => void) => {
          fullscreen.add(callback);
          return () => fullscreen.delete(callback);
        },
        onBeforeClose: () => () => {},
        listBoards: async () =>
          [...boards.values()].map(
            ({ id, title, kind, updatedAt, archivedAt, progress, nodes, wrap, notes }) => {
              // Mirrors model/progress.ts (stored on save, backfilled on list), as the real store does.
              const cards = nodes.filter((n: any) => n.parentId !== null);
              const sealed = cards.filter((n: any) => n.status === "explained").length;
              return {
                id,
                title,
                sessionCount: (window as any).__atlasLegacyCounts ? undefined : notes.length,
                kind,
                updatedAt,
                ...(archivedAt ? { archivedAt } : {}),
                ...(progress ?? { sealed, total: cards.length, done: !!wrap?.done || (cards.length > 0 && sealed === cards.length) }),
              };
            },
          ),
        loadBoard: async (id: string) => boards.get(id) ?? null,
        saveBoard: async (board: any) => {
          boards.set(board.id, board);
          persist();
        },
        deleteBoard: async (id: string) => {
          boards.delete(id);
          persist();
        },
        getProfile: async () => JSON.parse(localStorage.getItem("studyboard-preview-profile-v1") ?? '{"version":1,"enabled":true,"text":"","updatedAt":null,"lastRewriteAt":null,"pending":[]}'),
        getAISettings: async () => ({ ...settings }),
        // Like the desktop runtime with safeStorage: a key is saved encrypted, shown masked.
        setAISettings: async (s: any) => {
          const { apiKey, deepseekApiKey, ...rest } = s;
          if (deepseekApiKey !== undefined) {
            settings.searchKey = deepseekApiKey
              ? {
                  source: "saved",
                  keyHint: `sk-••••${String(deepseekApiKey).slice(-4)}`,
                }
              : { source: "none" };
          }
          if (apiKey === "")
            settings = {
              ...settings,
              ...rest,
              configured: false,
              source: "none",
            };
          else if (apiKey)
            settings = {
              ...settings,
              ...rest,
              configured: true,
              source: "saved",
              keyHint: `sk-••••${String(apiKey).slice(-4)}`,
            };
          else settings = { ...settings, ...rest };
          if (!settings.configured) delete settings.keyHint;
          return { ...settings };
        },
        testAIConnection: async (s: any) =>
          s.apiKey === "bad"
            ? {
                ok: false,
                kind: "auth",
                message: "鉴权失败：API Key 无效、已过期或没有这个模型的权限。",
                status: 401,
              }
            : { ok: true, model: s.model, latencyMs: 842 },
        onCanvasRun: (callback: (event: any) => void) => {
          canvasListeners.add(callback);
          return () => canvasListeners.delete(callback);
        },
        startCanvasRun: async (boardId: string) => {
          asks.push({
            mode: "organize",
            boardId,
            context: {
              topic: boards.get(boardId)?.topic,
              references: [],
              summary: "整理全画布",
            },
          });
          return startCanvas(boardId);
        },
        listCanvasRuns: async (boardId: string) =>
          [...canvasRuns.values()]
            .filter((run) => run.boardId === boardId)
            .map(({ draft, ...run }) => run),
        getCanvasRun: async (_boardId: string, id: string) =>
          canvasRuns.get(id) ?? null,
        prepareCanvasRun: async (_boardId: string, id: string) => {
          const run = canvasRuns.get(id);
          if (!run || run.status !== "running") return;
          const custom = (window as any).__atlasCanvasDraft;
          const draft = custom
            ? {
                ...run.draft,
                ...structuredClone(custom),
                nodes: custom.nodes.map((node: any) => ({
                  ...run.draft.nodes.find((n: any) => n.id === node.id),
                  ...node,
                })),
              }
            : run.draft;
          emitCanvas({
            ...run,
            draft,
            changed: true,
            revision: 1,
            phase: "editing",
          });
          setTimeout(() => {
            const current = canvasRuns.get(id);
            if (current?.status !== "running") return;
            emitCanvas({
              ...current,
              status: (window as any).__atlasCanvasFail ? "failed" : "ready",
              phase: "validating",
              reviewed: draft.nodes.length,
              summary: "画布修改已完成，可撤销恢复。",
              ...((window as any).__atlasCanvasFail
                ? { error: "本轮校对未完成，修改未提交。" }
                : {}),
            });
          }, 900);
        },
        commitCanvasRun: async (boardId: string, id: string) => {
          const run = canvasRuns.get(id);
          const current = boards.get(boardId);
          const result = {
            ...current,
            nodes: run.draft.nodes,
            relations: run.draft.relations,
            canvasVersion: id,
          };
          boards.set(boardId, result);
          persist();
          emitCanvas({
            ...run,
            status: "applied",
            phase: "complete",
            draft: result,
          });
          return structuredClone(result);
        },
        resumeCanvasRun: async (boardId: string, id: string) => {
          const run = canvasRuns.get(id);
          if (run) emitCanvas({ ...run, status: "running", phase: "locking" });
        },
        cancelCanvasRun: async (_boardId: string, id: string) => {
          const run = canvasRuns.get(id);
          if (run) emitCanvas({ ...run, status: "cancelled" });
        },
        ask: async (request: any) => {
          if (
            request.mode === "organize" &&
            (window as any).__atlasOrganizationError
          )
            throw new Error("整理请求失败，请重试。");
          (request.mode === "hint"
            ? hints
            : request.mode === "gate" || request.mode === "mark" || request.mode === "probe" || request.mode === "regen" || String(request.stickyId).includes("-gate-")
              ? gates
            : request.mode === "enrich"
              ? enriches
              : request.mode === "plan"
                ? plans
                : asks
          ).push(request);
          // Screenshot hook: hold a probe generation until __atlasRelease() (to catch the skeletons).
          if ((request.mode === "probe" || request.mode === "plan") && (window as any).__atlasHold)
            await new Promise<void>((r) => ((window as any).__atlasRelease = r));
          if (request.canvas && (window as any).__atlasChatCanvas) {
            void startCanvas(request.boardId, "chat", request.requestId);
          }
          const emit = (text: string, status: string) =>
            listeners.forEach((l) =>
              l({
                boardId: request.boardId,
                stickyId: request.stickyId,
                requestId: request.requestId,
                text,
                status,
              }),
            );
          // Tests that look at the streaming state set __atlasSlow: think, stream half, finish.
          const slow = (window as any).__atlasSlow as number | undefined;
          if (slow && (request.mode === "answer" || request.mode === "chat")) {
            const full = answer(request);
            setTimeout(() => emit("", "streaming"), 20);
            setTimeout(
              () =>
                emit(full.slice(0, Math.ceil(full.length / 2)), "streaming"),
              slow,
            );
            setTimeout(() => emit(full, "done"), slow * 2);
            return;
          }
          setTimeout(
            () => emit(answer(request), "done"),
            request.mode === "organize" ? 900 : 120,
          );
        },
        stop: async () => {},
        getHistory: async () => ({ messages: [], running: false }),
        onAIUpdate: (callback: (update: any) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      };
    },
    [configured, platform, seed ? JSON.stringify(seed) : null] as [
      boolean,
      string,
      string | null,
    ],
  );
}
