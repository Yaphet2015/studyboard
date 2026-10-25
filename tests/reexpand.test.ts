import { describe, expect, it } from "vitest";
import type { Board, ConceptNode } from "../src/shared/types";
import { clearJudgeCache, runGate } from "../src/model/novelty";
import { clearBelow, landReExpand } from "../src/model/reexpand";
import { expandPrompt, reExpandNote } from "../src/model/expand";
import { buildMapFromAI } from "../src/model/boards";
import { boardSchema, LIMITS } from "../src/shared/validation";

const node = (id: string, title: string, parentId: string | null, order: number, extra: Partial<ConceptNode> = {}): ConceptNode => ({
  id, kind: "concept", title, body: "", parentId, order, status: "unseen", ...extra,
});
const NOW = "2026-10-25T00:00:00.000Z";
// Station 1 has four L2 cards (one of them with a child), like the pstack board the learner was on.
const fixture = (): Board =>
  boardSchema.parse({
    version: 3, id: "b", title: "pstack", topic: "pstack 的 Skill 怎么用", kind: "ai", createdAt: NOW, updatedAt: NOW,
    nodes: [
      node("q", "pstack 的 Skill 怎么用", null, 0, { question: true }),
      node("s1", "pstack 有哪些 Skill、怎么分组", "q", 0, { body: "pstack 把 Skill 分成检索、写改、审查、编排四族。", expanded: true }),
      node("f1", "检索族", "s1", 0, { body: "检索族的 Skill 只读不写，用来先看清再动手。" }),
      node("f2", "写改族", "s1", 1, { body: "写改族的 Skill 会改文件，所以都带范围限制。" }),
      node("f3", "审查族", "s1", 2, { body: "审查族的 Skill 对改动逐条挑错。" }),
      node("f4", "编排族", "s1", 3, { body: "编排族的 Skill 把别的 Skill 串成流程。" }),
      node("f1a", "检索族的共同点", "f1", 0, { body: "它们都不产生副作用。" }),
      node("s2", "怎么写一个 Skill", "q", 1, { body: "Skill 是一份带触发描述的 Markdown。" }),
    ],
    relations: [{ id: "r1", source: "f1", target: "f3", label: "先检索再审查", kind: "cross" }],
    notes: [], route: ["s1", "s2"],
    scene: { width: 180, color: "#E9AE7E", prediction: "", explanation: "", changed: null },
  }) as Board;

const SKILLS = ["grep-first", "map-repo", "trace-call", "edit-small", "rename-safe", "split-file", "review-diff", "find-bug", "verify-run", "plan-steps", "run-parallel", "wrap-up"];
const CLAIMS = [
  "不知道文件在哪时先用搜索缩小范围", "陌生仓库先画目录地图再读代码", "改函数前沿调用链找出所有使用方", "每次只改十行以内便于回滚",
  "改名要扫描全部引用避免漏改", "单文件过千行按职责拆成多个", "合并前逐条审查副作用和边界", "线上报错用二分法定位根因",
  "声称完成之前必须跑验证命令", "超过三步的任务先列步骤清单", "独立的任务同时派给多个子代理加快速度", "交付时检查遗漏的收尾事项",
];
// Twelve different Skills: different titles, different claims, nothing shared with the board.
const card = (i: number) => ({
  id: `k${i}`,
  parent: "anchor",
  title: `${SKILLS[i]} 解决${["先看再改", "搜不到入口", "追调用链", "一次改太多", "改名漏改", "文件太大", "漏看副作用", "定位根因", "改完没验证", "步骤乱序", "串行太慢", "收尾遗漏"][i]}`,
  body: `${SKILLS[i]} 的触发描述写明「${["看不懂就先搜", "不知道从哪读", "谁调用了它", "改动超过十行", "跨文件改名", "单文件过千行", "合并前", "线上报错", "声称完成前", "任务超三步", "互不依赖的子任务", "交付时"][i]}」时才用，正文只给${["三步检索", "目录地图", "调用链模板", "最小改动清单", "引用扫描", "拆分边界", "逐条审查表", "二分排查", "验证命令", "步骤清单", "并行规则", "收尾检查"][i]}，不碰无关文件。`,
  newIdea: `${SKILLS[i]} 的适用边界`,
  substance: [{ kind: "mechanism", text: `${SKILLS[i]} 只在特定触发词下启用` }],
  addsBeyond: `分族卡只讲族，这张讲 ${SKILLS[i]} 本身`,
  claims: [CLAIMS[i]],
  check: { q: `小王在一个新项目里碰到了别的情形，什么时候才该启用 ${SKILLS[i]}？说出理由。`, keyPoints: ["看触发条件"] },
});
const twelve = () => JSON.stringify({ nodes: Array.from({ length: 12 }, (_, i) => card(i)), relations: [] });
const ask = async () => "{}";

describe("wide expansion", () => {
  it("an expansion may return up to 12 cards; the first map still stops at 8", () => {
    const b = fixture();
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, title: `卡${i}`, body: `正文${i}`, parent: "anchor" }));
    expect(buildMapFromAI(JSON.stringify({ nodes, relations: [] }), b, "s1", "expand").nodes.length).toBe(b.nodes.length + 12);
    expect(() => buildMapFromAI(JSON.stringify({ nodes: [...nodes, { id: "n12", title: "卡12", body: "正文12", parent: "anchor" }], relations: [] }), b, "s1", "expand")).toThrow(/1–12/);
    expect(() => buildMapFromAI(JSON.stringify({ nodes: nodes.slice(0, 9), relations: [] }), b, "s1", "map")).toThrow(/1–8/);
    expect(LIMITS.expansionCards).toBe(12);
  });
  it("the re-expand note overrides the 2–4 count and carries the learner's rule", () => {
    const b = fixture();
    expect(expandPrompt(b, "s1")).toContain("2–4");
    const note = reExpandNote("每个 Skill 一张卡");
    expect(note).toContain("「每个 Skill 一张卡」");
    expect(note).toContain("最多 12 张");
    expect(note).toContain("覆盖");
  });
});

describe("re-expanding the cards below a card", () => {
  it("clearBelow archives the children and grandchildren with the card kept, restorably", () => {
    const b = fixture();
    const cleared = clearBelow(b, "s1", "m1", NOW);
    expect(cleared.nodes.map((n) => n.id).sort()).toEqual(["q", "s1", "s2"]);
    expect(cleared.cardArchives?.map((a) => a.node.id).sort()).toEqual(["f1", "f1a", "f2", "f3", "f4"]);
    expect(cleared.cardArchives?.every((a) => a.runId === "reexpand-m1")).toBe(true);
    // Their relation is kept in the archive, so the old cards can come back whole.
    expect(cleared.cardArchives?.find((a) => a.node.id === "f1")?.relations.map((r) => r.id)).toEqual(["r1"]);
    expect(() => boardSchema.parse(cleared)).not.toThrow();
    // The input is untouched.
    expect(b.nodes).toHaveLength(8);
  });
  it("lands twelve new cards: the old ones are archived, none of the new ones merged or dropped by the gate", async () => {
    clearJudgeCache();
    const b = fixture();
    const r = await landReExpand(b, "s1", "m1", NOW, (cleared) => runGate(twelve(), cleared, "s1", ask, "base"));
    expect(r.replaced).toBe(true);
    expect(r.outcome.dropped).toEqual([]);
    expect(r.outcome.merges).toEqual([]);
    expect(r.added).toHaveLength(12);
    const kids = r.board.nodes.filter((n) => n.parentId === "s1").sort((a, c) => a.order - c.order);
    expect(kids.map((n) => n.title.split(" ")[0])).toEqual(SKILLS);
    // Old children are gone from the canvas and archived; the rest of the board is untouched.
    expect(r.board.nodes.some((n) => ["f1", "f2", "f3", "f4", "f1a"].includes(n.id))).toBe(false);
    expect(r.board.cardArchives?.map((a) => a.node.id).sort()).toEqual(["f1", "f1a", "f2", "f3", "f4"]);
    expect(r.board.nodes.find((n) => n.id === "s2")).toEqual(b.nodes.find((n) => n.id === "s2"));
    expect(r.board.route).toEqual(["s1", "s2"]);
    expect(() => boardSchema.parse(r.board)).not.toThrow();
  });
  it("without clearing, the gate would have judged the new cards against the old ones (why archive first)", async () => {
    clearJudgeCache();
    const b = fixture();
    // A new card that repeats an old child is merged into it when the old child is still there…
    const dup = { ...card(0), id: "dup", title: "检索族", body: "检索族的 Skill 只读不写，用来先看清再动手。", claims: ["检索族的 Skill 只读不写，用来先看清再动手"], newIdea: "检索族只读", substance: [{ kind: "mechanism", text: "检索族的 Skill 只读不写" }] };
    const before = await runGate(JSON.stringify({ nodes: [dup] }), b, "s1", ask, "base");
    expect(before.merges.map((m) => m.into)).toEqual(["f1"]);
    // …but it is a fresh card once the old children are archived.
    const after = await runGate(JSON.stringify({ nodes: [dup] }), clearBelow(b, "s1", "m2", NOW), "s1", ask, "base");
    expect(after.merges).toEqual([]);
  });
  it("nothing usable (empty or all dropped): the old cards stay exactly as they were", async () => {
    clearJudgeCache();
    const b = fixture();
    const empty = await landReExpand(b, "s1", "m3", NOW, (c) => runGate(JSON.stringify({ nodes: [], relations: [] }), c, "s1", ask, "base"));
    expect(empty.replaced).toBe(false);
    expect(empty.board).toBe(b);
    const filler = { ...card(0), id: "x", title: "重要性", body: "这很重要，要综合考虑，因人而异。", claims: ["很重要"] };
    const junk = await landReExpand(b, "s1", "m4", NOW, (c) => runGate(JSON.stringify({ nodes: [filler] }), c, "s1", async () => "{}", "base"));
    expect(junk.replaced).toBe(false);
    expect(junk.board).toBe(b);
    expect(junk.board.cardArchives).toBeUndefined();
  });
});
