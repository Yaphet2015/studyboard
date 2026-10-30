import { boardSchema } from "../src/shared/validation";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AIRuntime } from "../electron/ai-runtime";
import { BoardStore } from "../electron/board-store";
import {
  CanvasDoc,
  newCanvasWork,
  reviewVersion,
  createCanvasExtension,
} from "../electron/canvas-agent";
import { createEmptyBoard } from "../src/model/boards";
import type { Board, CanvasRun } from "../src/shared/types";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

const dirs: string[] = [];
const instances: AIRuntime[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture(count = 3): Board {
  const board = createEmptyBoard("浏览器渲染");
  for (let i = 1; i < count; i++)
    board.nodes.push({
      id: `card-${i}`,
      kind: "concept",
      title: `概念${i}`,
      body: `正文${i}：解释浏览器中这部分如何工作。`,
      parentId: board.nodes[0].id,
      order: i - 1,
      status: "unseen",
    });
  return board;
}
function stream(call?: [string, unknown], id = "call"): Response {
  const chunk = {
    id: "completion",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: {
                    name: call[0],
                    arguments: JSON.stringify(call[1]),
                  },
                },
              ],
            }
          : {
              content:
                "精简历史：具体画布与校对进度均保存在工作文档，请通过工具查询。",
            },
        finish_reason: call ? "tool_calls" : "stop",
      },
    ],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
async function setup(board = fixture()) {
  vi.stubEnv("OPENAI_API_KEY", "");
  const directory = await mkdtemp(join(tmpdir(), "canvas-recovery-"));
  dirs.push(directory);
  const store = new BoardStore(join(directory, "boards"));
  await store.save(board);
  const events: CanvasRun[] = [];
  const host = {
    load: (id: string) => store.load(id),
    acquire: (run: CanvasRun, expected: string) =>
      store.acquireCanvas(run.boardId, run.id, expected),
    release: (board: string, run: string) => store.releaseCanvas(board, run),
    commit: store.commitCanvas.bind(store),
  };
  async function open() {
    const runtime = new AIRuntime(
      directory,
      () => {},
      null,
      host,
      (run) => events.push(run),
    );
    instances.push(runtime);
    await runtime.setSettings({
      model: "deepseek-flash",
      baseUrl: "http://localhost:12345/v1",
      apiKey: "TEST_SECRET",
    });
    return runtime;
  }
  return { directory, store, events, host, open };
}

it.each([20, 100, 500])(
  "covers %i cards through bounded read/review rounds",
  async (count) => {
    const board = fixture(count);
    const { open, events } = await setup(board);
    const calls: [string, unknown][] = [["canvas_structure", {}]];
    for (let i = 0; i < count; i += 8) {
      const ids = board.nodes.slice(i, i + 8).map((n) => n.id);
      calls.push(
        ["canvas_read", { ids }],
        [
          "canvas_review",
          { ids, revision: 0, conclusion: "已校对这些卡片的当前内容和层级" },
        ],
      );
    }
    calls.push([
      "canvas_finish",
      { summary: "全部卡片已校对，未发现需要修改的内容。" },
    ]);
    let index = 0;
    let largest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const payload = JSON.parse(init.body);
        largest = Math.max(largest, JSON.stringify(payload.messages).length);
        if (!payload.tools?.length) return stream();
        const call = calls[index++];
        if (!call) throw new Error("unexpected generation");
        return stream(call, "call-" + index);
      }),
    );
    const runtime = await open();
    await runtime.startCanvasRun(board.id);
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("ready"), {
      timeout: 20000,
    });
    expect(events.at(-1)?.reviewed).toBe(count);
    expect(index).toBe(calls.length);
    // Calls scale with batches; no request contains a separately injected full-card snapshot.
    expect(index).toBeLessThanOrEqual(128);
    expect(largest).toBeLessThan(400000);
  },
  25000,
);

it("persists a preview across close/reopen and explicitly resumes the remaining tool work", async () => {
  const board = fixture();
  const { open, events, store } = await setup(board);
  const ids = board.nodes.map((n) => n.id);
  let calls: [string, unknown][] = [
    ["canvas_read", { ids }],
    [
      "canvas_edit",
      {
        reason: "校对解释",
        operations: [{ op: "update", id: "card-1", body: "已校对的正文" }],
      },
    ],
  ];
  let waiting = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const call = calls.shift();
      if (call) return stream(call, "call-" + crypto.randomUUID());
      waiting = true;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  const first = await open();
  const run = await first.startCanvasRun(board.id);
  await vi.waitFor(() => expect(waiting).toBe(true));
  expect(events.some((event) => event.changed)).toBe(true);
  await first.close();
  expect((await store.load(board.id))?.nodes[1].body).toBe(board.nodes[1].body);
  const second = await open();
  const recovered = await second.getCanvasRun(board.id, run.id);
  expect(recovered?.status).toBe("paused");
  expect(recovered?.draft?.nodes[1].body).toBe("已校对的正文");
  calls = [
    ["canvas_read", { ids }],
    ["canvas_review", { ids, revision: 1, conclusion: "恢复后复核当前版本" }],
    ["canvas_finish", { summary: "已恢复并完成" }],
  ];
  await second.resumeCanvasRun(board.id, run.id);
  await vi.waitFor(() => expect(events.at(-1)?.status).toBe("ready"));
  const result = await second.commitCanvasRun(board.id, run.id);
  expect(result.nodes[1].body).toBe("已校对的正文");
  expect(result.nodes).toHaveLength(board.nodes.length);
});

it("cancel after a tool write rejects commit and keeps the official board unchanged", async () => {
  const board = fixture();
  const { open, events, store } = await setup(board);
  const ids = board.nodes.map((n) => n.id);
  const calls: [string, unknown][] = [
    ["canvas_read", { ids }],
    [
      "canvas_edit",
      {
        reason: "更新",
        operations: [{ op: "update", id: "card-1", body: "临时改动" }],
      },
    ],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const call = calls.shift();
      if (call) return stream(call, "call-" + crypto.randomUUID());
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  const runtime = await open();
  const run = await runtime.startCanvasRun(board.id);
  await vi.waitFor(() =>
    expect(events.some((event) => event.changed)).toBe(true),
  );
  await runtime.cancelCanvasRun(board.id, run.id);
  await expect(runtime.commitCanvasRun(board.id, run.id)).rejects.toThrow();
  expect((await store.load(board.id))?.nodes).toEqual(boardSchema.parse(board).nodes);
  expect((await runtime.getCanvasRun(board.id, run.id))?.status).toBe(
    "cancelled",
  );
});

it("commits an edit and its receipt once even if the tool invocation is replayed", async () => {
  const board = fixture();
  const { open, host } = await setup(board);
  const runtime = await open();
  const request = {
    boardId: board.id,
    stickyId: "test-tool",
    requestId: "test-run",
    prompt: "create",
    mode: "answer" as const,
    context: { topic: board.topic, references: [], summary: "" },
  };
  const harness = await (runtime as any).openBoard(board.id, request.stickyId);
  const conversation = await (runtime as any).findConversation(
    harness,
    request.stickyId,
    true,
  );
  const work = newCanvasWork(board, request);
  work.readVersions[board.nodes[0].id] = reviewVersion(
    board,
    board.nodes[0].id,
  );
  await conversation.commit(async (tx: any) => {
    const doc = await tx.doc(CanvasDoc, conversation.id);
    doc.activeId = work.id;
    doc.runs[work.id] = work;
  }, CTX);
  const extension = createCanvasExtension(
    host,
    () => {},
    async () => {},
  );
  const tool = extension.tools!.find((tool) => tool.name === "canvas_edit")!;
  const api = {
    conversationId: conversation.id,
    callId: "same-call",
    snapshot: harness.snapshot.bind(harness),
    commit: conversation.commit.bind(conversation),
  } as unknown as ToolExecutionApi;
  const args = {
    reason: "创建一次",
    operations: [
      {
        op: "create",
        id: "created-once",
        parentId: board.nodes[0].id,
        title: "新卡",
        body: "新概念",
      },
    ],
  };
  const first = await tool.execute(args, api, CTX);
  const second = await tool.execute(args, api, CTX);
  expect(second.output).toEqual(first.output);
  const state = await harness.snapshot(CanvasDoc, conversation.id, CTX);
  expect(
    state.runs[work.id].draft.nodes.filter(
      (node: any) => node.id === "created-once",
    ),
  ).toHaveLength(1);
  expect(state.runs[work.id].operations).toHaveLength(1);
});

it("reports unreviewed cross-links and completes after reading all relation pages", async () => {
  const board = fixture(3);
  for (let i = 0; i < 25; i++)
    board.relations.push({
      id: `relation-${i}`,
      source: board.nodes[0].id,
      target: "card-1",
      label: `关系${i}`,
      kind: "cross",
    });
  const { open, host } = await setup(board);
  const runtime = await open();
  const request = {
    boardId: board.id,
    stickyId: "relations",
    requestId: "relations-run",
    prompt: "整理",
    mode: "organize" as const,
    context: { topic: board.topic, references: [], summary: "" },
  };
  const harness = await (runtime as any).openBoard(board.id, request.stickyId);
  const conversation = await (runtime as any).findConversation(
    harness,
    request.stickyId,
    true,
  );
  const work = newCanvasWork(board, request);
  for (const node of board.nodes) {
    work.readVersions[node.id] = reviewVersion(board, node.id);
    work.reviewedVersions[node.id] = reviewVersion(board, node.id);
  }
  await conversation.commit(async (tx: any) => {
    const doc = await tx.doc(CanvasDoc, conversation.id);
    doc.activeId = work.id;
    doc.runs[work.id] = work;
  }, CTX);
  const extension = createCanvasExtension(
    host,
    () => {},
    async () => {},
  );
  const invoke = (name: string, args: any) =>
    extension
      .tools!.find((tool) => tool.name === name)!
      .execute(
        args,
        {
          conversationId: conversation.id,
          callId: crypto.randomUUID(),
          snapshot: harness.snapshot.bind(harness),
          commit: conversation.commit.bind(conversation),
        } as unknown as ToolExecutionApi,
        CTX,
      );
  const finish = await invoke("canvas_finish", { summary: "已校对卡片" });
  expect(finish.isError).toBe(true);
  const missing = JSON.parse((finish.output![0] as any).text);
  expect(missing.pendingIds).toEqual([]);
  expect(missing.totalRelations).toBe(25);
  expect(missing.pendingRelationIds).toContain("relation-24");
  await invoke("canvas_structure", { relationOffset: 0 });
  await invoke("canvas_structure", { relationOffset: 20 });
  await invoke("canvas_review", {
    ids: board.nodes.map((n) => n.id),
    revision: 0,
    conclusion: "已复核全部跨枝关系",
  });
  const complete = await invoke("canvas_finish", {
    summary: "全部卡片和关系已校对",
  });
  expect(complete.isError).not.toBe(true);
  expect(complete.control?.terminate).toBe(true);
});

it("recovers the gap between the official file commit and the task receipt without reapplying", async () => {
  const board = fixture();
  const { open, events, store } = await setup(board);
  const ids = board.nodes.map((n) => n.id);
  const calls: [string, unknown][] = [
    ["canvas_read", { ids }],
    [
      "canvas_edit",
      {
        reason: "校对",
        operations: [{ op: "update", id: "card-1", body: "只应用一次" }],
      },
    ],
    ["canvas_read", { ids }],
    ["canvas_review", { ids, revision: 1, conclusion: "已检查" }],
    ["canvas_finish", { summary: "完成" }],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => stream(calls.shift(), "call-" + crypto.randomUUID())),
  );
  const first = await open();
  const run = await first.startCanvasRun(board.id);
  await vi.waitFor(() => expect(events.at(-1)?.status).toBe("ready"));
  await vi.waitFor(() => expect((first as any).active.size).toBe(0));
  const found = await (first as any).locateCanvasRun(board.id, run.id);
  await store.commitCanvas(
    board.id,
    run.id,
    found.work.baseFingerprint,
    found.work.operations,
  );
  // Simulate process loss after JSON fsync but before the SQLite receipt update.
  await first.close();
  const second = await open();
  expect((await second.getCanvasRun(board.id, run.id))?.status).toBe("ready");
  const result = await second.commitCanvasRun(board.id, run.id);
  expect(result.nodes[1].body).toBe("只应用一次");
  expect(result.appliedCanvasRuns?.filter((id) => id === run.id)).toHaveLength(
    1,
  );
  expect((await second.getCanvasRun(board.id, run.id))?.status).toBe("applied");
});

it("refuses an edit based on a stale official canvas", async () => {
  const board = fixture();
  const { open, store, events } = await setup(board);
  const ids = board.nodes.map((n) => n.id);
  let step = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      step++;
      if (step === 1) return stream(["canvas_read", { ids }], "read");
      if (step === 2) {
        const updated = structuredClone(board);
        updated.nodes[1].body = "用户的新修改";
        await store.save(updated);
        return stream(
          [
            "canvas_edit",
            {
              reason: "旧版本修改",
              operations: [{ op: "update", id: "card-1", body: "过时结果" }],
            },
          ],
          "edit",
        );
      }
      return stream();
    }),
  );
  const runtime = await open();
  await runtime.startCanvasRun(board.id);
  await vi.waitFor(() => expect(events.at(-1)?.status).toBe("conflict"));
  expect((await store.load(board.id))?.nodes[1].body).toBe("用户的新修改");
});
