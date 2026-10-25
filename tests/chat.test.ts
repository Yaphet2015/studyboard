import { describe, expect, it } from "vitest";
import type { Board, ConceptNode, StickyNote } from "../src/shared/types";
import { applyRouteOps, previewRoute, routeOf, validRouteOps } from "../src/model/route";
import {
  chatPrompt,
  chatRequest,
  displayChat,
  estimateTokens,
  expireProposals,
  isGoAhead,
  noteLinks,
  parseChatReply,
  pendingProposal,
  restoreLinks,
  TURN_CAP,
  withProposal,
} from "../src/model/chat";
import { boardSchema } from "../src/shared/validation";
import { CHAT_INSTRUCTIONS } from "../electron/prompts";

const node = (id: string, title: string, parentId: string | null, order: number, extra: Partial<ConceptNode> = {}): ConceptNode => ({
  id, kind: "concept", title, body: "", parentId, order, status: "unseen", ...extra,
});
const fixture = (): Board =>
  boardSchema.parse({
    version: 3,
    id: "board-c",
    title: "重疾险",
    topic: "怎么挑一份合适的重疾险",
    kind: "ai",
    createdAt: "2026-10-22T08:00:00.000Z",
    updatedAt: "2026-10-22T08:00:00.000Z",
    nodes: [
      node("q", "怎么挑一份合适的重疾险", null, 0, { question: true }),
      node("s1", "保费豁免条款", "q", 0, { status: "explained", body: "投保人出事后免交后续保费。" }),
      node("s1a", "豁免的触发条件", "s1", 0),
      node("s2", "保额怎么定才够", "q", 1, { body: "保额要覆盖治疗费和几年的收入缺口。".repeat(20) }),
      node("s3", "等待期与观察期", "q", 2, { body: "等待期内确诊不赔。" }),
      node("s4", "重疾、中症、轻症的赔付比例", "q", 3),
    ],
    relations: [],
    notes: [],
    route: ["s1", "s2", "s3", "s4"],
    scene: { width: 180, color: "#E9AE7E", prediction: "", explanation: "", changed: null },
  }) as Board;
const ids = (i: number) => `stop-new-${i}`;
const titles = (b: Board) => routeOf(b).map((n) => n.title);

describe("parseChatReply", () => {
  it("reads a trailing ```json proposal and keeps only the text as the reply", () => {
    const b = fixture();
    const r = parseChatReply(
      '好，第三站改讲等待期里的坑。\n```json\n{"proposal":{"type":"editRoute","ops":[{"op":"replace","stop":3,"title":"等待期里最容易踩的坑"}]}}\n```',
      b,
    );
    expect(r.reply).toBe("好，第三站改讲等待期里的坑。");
    expect(r.proposal).toEqual({
      type: "editRoute",
      ops: [{ op: "replace", stop: 3, title: "等待期里最容易踩的坑" }],
      state: "pending",
    });
  });
  it("reads a bare JSON tail and a startStop for an unsealed stop", () => {
    const r = parseChatReply('好，下一站讲保额。{"proposal":{"type":"startStop","stop":2}}', fixture());
    expect(r).toEqual({
      reply: "好，下一站讲保额。",
      proposal: { type: "startStop", stop: 2, stopId: "s2", state: "pending" },
    });
  });
  it("plain answers carry no proposal", () => {
    expect(parseChatReply("等待期是投保后一段不赔的时间。", fixture())).toEqual({
      reply: "等待期是投保后一段不赔的时间。",
    });
  });
  it("bad JSON or out-of-range stops show the text only, without an error", () => {
    const b = fixture();
    expect(parseChatReply('改一下。\n```json\n{"proposal":{"type":"editRoute","ops":[{"op":"remove"', b)).toEqual({ reply: "改一下。" });
    expect(parseChatReply('删掉。{"proposal":{"type":"editRoute","ops":[{"op":"remove","stop":9}]}}', b)).toEqual({ reply: "删掉。" });
    expect(parseChatReply('开始。{"proposal":{"type":"startStop","stop":1}}', b)).toEqual({ reply: "开始。" });
    expect(parseChatReply('嗯。{"proposal":{"type":"dance"}}', b)).toEqual({ reply: "嗯。" });
  });
  it("drops invalid ops but keeps the valid ones, at most 4", () => {
    const r = parseChatReply(
      'x{"proposal":{"type":"editRoute","ops":[{"op":"move","stop":4,"to":1},{"op":"add","title":"","after":1},{"op":"remove","stop":0},{"op":"focus","stop":2,"text":"算收入缺口"},{"op":"add","title":"a","after":1},{"op":"add","title":"b","after":1},{"op":"add","title":"c","after":1}]}}',
      fixture(),
    );
    expect(r.proposal?.type === "editRoute" && r.proposal.ops.map((o) => o.op)).toEqual(["move", "focus", "add", "add"]);
  });
  it("reads a reExpand by station number or exact card title and counts what it would replace", () => {
    const b = fixture();
    const byNo = parseChatReply('好，把第 1 站的下层重做。\n```json\n{"proposal":{"type":"reExpand","stop":1,"instruction":"每个 Skill 一张卡"}}\n```', b);
    expect(byNo.reply).toBe("好，把第 1 站的下层重做。");
    expect(byNo.proposal).toEqual({ type: "reExpand", targetId: "s1", title: "保费豁免条款", instruction: "每个 Skill 一张卡", replaces: 1, below: 0, state: "pending" });
    b.nodes.push(node("g", "孙卡", "s1a", 0));
    const byTitle = parseChatReply('重做。{"proposal":{"type":"reExpand","stop":"豁免的触发条件","instruction":"拆细一点"}}', b);
    expect(byTitle.proposal).toMatchObject({ type: "reExpand", targetId: "s1a", replaces: 1, below: 0 });
    expect(parseChatReply('x{"proposal":{"type":"reExpand","stop":1,"instruction":"x"}}', b).proposal).toMatchObject({ replaces: 1, below: 1 });
  });
  it("drops a reExpand whose target is missing, ambiguous, the root, or has no instruction", () => {
    const b = fixture();
    b.nodes.push(node("dup1", "重名", "s2", 0), node("dup2", "重名", "s3", 0));
    const bad = (stop: unknown, instruction: unknown = "拆") =>
      parseChatReply(`x{"proposal":{"type":"reExpand","stop":${JSON.stringify(stop)},"instruction":${JSON.stringify(instruction)}}}`, b);
    for (const r of [bad(9), bad(0), bad("不存在的卡"), bad("重名"), bad("怎么挑一份合适的重疾险"), bad(1, "   ")]) expect(r).toEqual({ reply: "x" });
    expect(parseChatReply('x{"proposal":{"type":"reExpand","stop":1}}', b)).toEqual({ reply: "x" });
  });
  it("never shows the JSON tail while streaming", () => {
    expect(displayChat('好，改一下。\n```js')).toBe("好，改一下。");
    expect(displayChat('好。{"propo')).toBe('好。{"propo');
    expect(displayChat('好。{"proposal":{"ty')).toBe("好。");
  });
});

describe("applyRouteOps", () => {
  it("replace renames the stop in place, title only, card count unchanged; undo is the prior snapshot", () => {
    const b = fixture();
    const { board, changed } = applyRouteOps(b, [{ op: "replace", stop: 3, title: "等待期里最容易踩的坑" }], "chat-1", "2026-10-23T00:00:00.000Z", ids);
    expect(board.nodes).toHaveLength(b.nodes.length);
    expect(titles(board)[2]).toBe("等待期里最容易踩的坑");
    const s3 = board.nodes.find((n) => n.id === "s3")!;
    expect(s3.body).toBe("");
    expect(s3.status).toBe("unseen");
    expect(changed).toEqual(["s3"]);
    // The input board is untouched, so restoring it (the undo snapshot) brings the route back.
    expect(titles(b)[2]).toBe("等待期与观察期");
  });
  it("removing a sealed stop archives it with its subtree, so it can be restored", () => {
    const b = fixture();
    expect(previewRoute(b, [{ op: "remove", stop: 1 }]).find((r) => r.kind === "remove")).toMatchObject({ archives: true, title: "保费豁免条款" });
    const { board } = applyRouteOps(b, [{ op: "remove", stop: 1 }], "chat-2", "2026-10-23T00:00:00.000Z", ids);
    expect(titles(board)).toEqual(["保额怎么定才够", "等待期与观察期", "重疾、中症、轻症的赔付比例"]);
    expect(board.nodes.some((n) => n.id === "s1" || n.id === "s1a")).toBe(false);
    expect(board.cardArchives?.map((a) => a.node.id).sort()).toEqual(["s1", "s1a"]);
  });
  it("replacing a sealed stop archives it and puts a new title-only stop in its place", () => {
    const { board } = applyRouteOps(fixture(), [{ op: "replace", stop: 1, title: "豁免条款的坑" }], "chat-3", "2026-10-23T00:00:00.000Z", ids);
    expect(board.route?.[0]).toBe("stop-new-0");
    expect(titles(board)[0]).toBe("豁免条款的坑");
    expect(board.cardArchives?.some((a) => a.node.id === "s1")).toBe(true);
  });
  it("move and add reorder the route and the first level left to right", () => {
    const { board } = applyRouteOps(
      fixture(),
      [{ op: "move", stop: 3, to: 2 }, { op: "add", title: "健康告知", after: 0 }],
      "chat-4",
      "2026-10-23T00:00:00.000Z",
      ids,
    );
    expect(titles(board)).toEqual(["健康告知", "保费豁免条款", "等待期与观察期", "保额怎么定才够", "重疾、中症、轻症的赔付比例"]);
    const first = board.nodes.filter((n) => n.parentId === "q").sort((a, b) => a.order - b.order).map((n) => n.id);
    expect(first).toEqual(board.route);
    expect(board.nodes.find((n) => n.id === "stop-new-0")).toMatchObject({ body: "", status: "unseen" });
  });
  it("focus adds a remark; invalid ops are dropped and the route keeps at least one stop", () => {
    const b = fixture();
    expect(applyRouteOps(b, [{ op: "focus", stop: 2, text: "算收入缺口" }], "c", "2026-10-23T00:00:00.000Z", ids).board.nodes.find((n) => n.id === "s2")?.hand).toBe("重点：算收入缺口");
    expect(validRouteOps(b, [1, 2, 3, 4].map((stop) => ({ op: "remove" as const, stop })))).toEqual([]);
    expect(applyRouteOps(b, [{ op: "remove", stop: 7 }], "c", "2026-10-23T00:00:00.000Z", ids).board).toBe(b);
  });
});

describe("chat turn", () => {
  const note = (messages: StickyNote["messages"] = []): StickyNote => ({
    id: "note-1", title: "", text: "", position: { x: 0, y: 0 }, attachedTo: { kind: "node", id: "q" }, messages,
  });
  it("free text is always an ordinary chat call with canvas:false, whatever was said", () => {
    for (const text of ["开始吧", "把第 3 站删掉", "展开第二站并生成卡片", "等待期是什么？"]) {
      const r = chatRequest(fixture(), note(), text, { requestId: "r", stickyId: "chat-note-1-r" });
      expect(r.canvas).toBe(false);
      expect(r.mode).toBe("chat");
      expect(r.context).toEqual({ topic: "怎么挑一份合适的重疾险", references: [], summary: "" });
    }
  });
  it("context is route titles, the current stop (200 chars) and the last 6 messages", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `消息${i}`, createdAt: "2026-10-23T00:00:00.000Z" }));
    const p = chatPrompt(fixture(), note(msgs), "继续");
    expect(p).toContain("1. 保费豁免条款 ✓");
    expect(p).toContain("4. 重疾、中症、轻症的赔付比例");
    expect(p).toContain("当前站：第 2 站「保额怎么定才够」");
    expect(p).not.toContain("消息3");
    expect(p).toContain("消息4");
    expect(p).toContain("消息9");
    expect(p).not.toContain("保额要覆盖治疗费和几年的收入缺口。".repeat(13));
    expect(p).not.toContain("等待期内确诊不赔");
  });
  it("the card selected on the canvas wins over the thread's card, and its L2 cards come along", () => {
    const b = fixture();
    const p = chatPrompt(b, note(), "下一层直接按每个 Skills 拆", "s1");
    expect(p).toContain("当前站：第 1 站「保费豁免条款」");
    expect(p).toContain("选中卡：第 1 站「保费豁免条款」");
    expect(p).toContain("下层(L2) 1 张：\n- 「豁免的触发条件」");
    // Without a selection the next unsealed stop is the current one, and there is no selection block.
    expect(chatPrompt(b, note(), "继续")).not.toContain("选中卡");
  });
  it("L2 lists at most 8 cards as title + 40 chars, and says when a card has none", () => {
    const b = fixture();
    for (let i = 0; i < 12; i++) b.nodes.push(node(`k${i}`, `子卡${i}`, "s3", i, { summary: "一句很长的摘要".repeat(20) }));
    const p = chatPrompt(b, note(), "拆", "s3");
    expect(p).toContain("下层(L2) 12 张：");
    expect(p).toContain("- 「子卡7」：");
    expect(p).not.toContain("子卡8」");
    expect(p).toContain("- …共 12 张");
    expect(p).not.toContain("一句很长的摘要".repeat(7));
    expect(chatPrompt(b, note(), "拆", "s4")).toContain("下层(L2)：还没有");
    // A selected card off the route is described without a station number; the root adds nothing.
    expect(chatPrompt(b, note(), "拆", "s1a")).toContain("选中卡：「豁免的触发条件」");
    expect(chatPrompt(b, note(), "拆", "q")).not.toContain("选中卡");
  });
  it("selecting a card with 8 L2 cards adds about 150 tokens to a turn", () => {
    const b = fixture();
    for (let i = 0; i < 8; i++) b.nodes.push(node(`k${i}`, `子卡标题${i}`, "s3", i, { body: "这是一段大约四十个字的摘要，用来估算每一轮多出来的上下文开销。".repeat(2) }));
    const extra = estimateTokens(chatPrompt(b, note(), "拆", "s3")) - estimateTokens(chatPrompt(b, note(), "拆"));
    expect(extra).toBeLessThan(260);
  });
  it("chatRequest passes the selected card into the prompt", () => {
    const r = chatRequest(fixture(), note(), "拆", { requestId: "r", stickyId: "s", selectedId: "s1" });
    expect(r.prompt).toContain("选中卡：第 1 站");
  });
  it("stays under the 2.5k cap by trimming history", () => {
    const long = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: "user" as const, text: "很长".repeat(400), createdAt: "2026-10-23T00:00:00.000Z" }));
    const p = chatPrompt(fixture(), note(long), "继续");
    expect(estimateTokens(CHAT_INSTRUCTIONS) + estimateTokens(p) + 400).toBeLessThanOrEqual(TURN_CAP);
  });
  it("a go-ahead equals the button only right after a pending proposal; new messages expire it", () => {
    expect(["好", "好，开始吧", "开始吧", "好的", "应用"].every(isGoAhead)).toBe(true);
    expect(["好难", "开始讲等待期", "好，那等待期是什么？"].some(isGoAhead)).toBe(false);
    const asked = note([
      { id: "a", role: "assistant", text: "下一站讲保额。", createdAt: "2026-10-23T00:00:00.000Z", meta: { chat: true, proposal: { type: "startStop", stop: 2, stopId: "s2", state: "pending" } } },
    ]);
    expect(pendingProposal(asked)?.id).toBe("a");
    const expired = expireProposals(asked.messages);
    expect(expired[0].meta?.proposal?.state).toBe("expired");
    expect(pendingProposal({ ...asked, messages: expired })).toBeUndefined();
  });
});

describe("proposal state and note links", () => {
  const reExpand = { type: "reExpand" as const, targetId: "s1", title: "保费豁免条款", instruction: "拆细", replaces: 1, below: 0, state: "pending" as const };
  it("withProposal changes one message's proposal and nothing else", () => {
    const b = fixture();
    b.notes = [
      { id: "n", title: "", text: "", position: { x: 0, y: 0 }, messages: [{ id: "a", role: "assistant", text: "好", createdAt: "2026-10-25T00:00:00.000Z", meta: { chat: true, proposal: reExpand } }] },
    ];
    const next = withProposal(b, "n", "a", { state: "applied", added: 5 });
    expect(next.notes[0].messages[0].meta?.proposal).toEqual({ ...reExpand, state: "applied", added: 5 });
    expect(b.notes[0].messages[0].meta?.proposal?.state).toBe("pending");
    expect(withProposal(b, "n", "nope", { state: "applied" }).notes[0].messages[0].meta?.proposal?.state).toBe("pending");
  });
  it("restoreLinks puts back a note pinned to a card that was archived", () => {
    const b = fixture();
    b.notes = [{ id: "n", title: "", text: "", position: { x: 0, y: 0 }, attachedTo: { kind: "node", id: "s1a" }, contextCards: ["s1a"], messages: [] }];
    const links = noteLinks(b);
    const cut = [{ ...b.notes[0], attachedTo: undefined, contextCards: [] }];
    expect(restoreLinks(cut, links)[0]).toMatchObject({ attachedTo: { kind: "node", id: "s1a" }, contextCards: ["s1a"] });
  });
});
