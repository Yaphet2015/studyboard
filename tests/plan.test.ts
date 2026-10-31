import { describe, expect, it } from "vitest";
import { buildMapFromAI, createEmptyBoard } from "../src/model/boards";
import { contextForNote } from "../src/model/context";
import { newNote } from "../src/model/boards";
import {
  blockOf,
  confirmPlan,
  coveredBlocks,
  parsePlan,
  planFirstLevelPrompt,
  removeBlock,
  renameBlock,
  renderPlan,
} from "../src/model/plan";
import { boardSchema } from "../src/shared/validation";
import { tutorInstructions, renderScopedContext } from "../electron/prompts";

const raw = {
  intent: "learning-path",
  goal: "学完后，能制定三个月的微观经济学自学计划。",
  learner: "大一，数学一般",
  blocks: [
    { id: "s1", title: "先修", why: "", parent: null, prerequisites: [] },
    { id: "s2", title: "核心阶段", why: "主体", parent: null, prerequisites: ["s1", "zz"] },
    { id: "s2a", title: "供需与弹性", why: "", parent: "s2", core: true },
    { id: "s2b", title: "嵌套错误", why: "", parent: "s2a" },
    { id: "s3", title: "里程碑", why: "", parent: null, core: false },
    { id: "s3", title: "重复", why: "", parent: null },
  ],
  outOfScope: ["宏观经济"],
};

describe("learning plan", () => {
  it("parses, dedupes ids, flattens bad parents and drops unknown prerequisites", () => {
    const plan = parsePlan("```json\n" + JSON.stringify(raw) + "\n```");
    expect(plan.status).toBe("draft");
    expect(plan.blocks.map((b) => b.id)).toEqual(["s1", "s2", "s2a", "s2b", "s3"]);
    expect(plan.blocks.find((b) => b.id === "s2b")!.parent).toBeNull();
    expect(plan.blocks.find((b) => b.id === "s2")!.prerequisites).toEqual(["s1"]);
    expect(plan.blocks.find((b) => b.id === "s1")!.core).toBe(true);
    expect(plan.blocks.find((b) => b.id === "s3")!.core).toBe(false);
  });
  it("rejects unusable output", () => {
    expect(() => parsePlan("不是 JSON")).toThrow(/学习计划/);
    expect(() => parsePlan(JSON.stringify({ ...raw, blocks: raw.blocks.slice(0, 1) }))).toThrow();
  });
  it("edits: rename, remove with children, confirm; old boards stay valid", () => {
    let plan = parsePlan(JSON.stringify(raw));
    plan = removeBlock(renameBlock(plan, "s1", "数学先修"), "s2");
    expect(plan.blocks.map((b) => b.id)).toEqual(["s1", "s2b", "s3"]);
    expect(plan.blocks[0].title).toBe("数学先修");
    const board = createEmptyBoard("如何学好微观经济学");
    expect(boardSchema.parse(board).plan).toBeUndefined();
    expect(boardSchema.parse({ ...board, plan: confirmPlan(plan) }).plan!.status).toBe("confirmed");
  });
  it("lays one card per top block, carries block tags, and feeds the plan to expansions", () => {
    const board = { ...createEmptyBoard("如何学好微观经济学"), plan: confirmPlan(parsePlan(JSON.stringify(raw))) };
    const prompt = planFirstLevelPrompt(board);
    expect(prompt).toContain("1. [s1] 先修");
    expect(prompt).not.toContain("供需与弹性");
    const next = buildMapFromAI(
      JSON.stringify({
        nodes: [
          { id: "a", title: "先修什么？", body: "x", block: "s1" },
          { id: "b", title: "核心学什么？", body: "y", block: "s2" },
          { id: "c", title: "无关", body: "z", block: "nope" },
        ],
        relations: [],
      }),
      board,
    );
    expect(next.plan).toEqual({ ...board.plan, artifact: [] });
    const [a, b, c] = next.nodes.slice(1);
    expect(a.planBlock).toBe("s1");
    expect(c.planBlock).toBeUndefined();
    expect([...coveredBlocks(next)].sort()).toEqual(["s1", "s2"]);
    expect(blockOf(next, b.id)!.id).toBe("s2");
    const text = renderPlan(next, b.id)!;
    expect(text).toContain("当前卡片属于块 [s2]");
    expect(text).toContain("尚未覆盖：[s2a] 供需与弹性");
    expect(text).toContain("[s3] 里程碑");
    expect(text).toContain("不展开的话题：宏观经济");
    const note = newNote(next, { x: 0, y: 0 }, { kind: "node", id: b.id });
    const ctx = contextForNote({ ...next, notes: [note] }, note.id);
    expect(ctx.plan).toBe(text);
    expect(renderScopedContext(ctx)).toContain("学习计划");
    // Drafts are not sent.
    expect(renderPlan({ ...next, plan: { ...next.plan!, status: "draft" } }, b.id)).toBeUndefined();
  });
  it("the plan prompt holds the type guidance and the core-coverage rule", () => {
    const p = tutorInstructions("plan");
    expect(p).toContain("howto：必须把这些具体事项各自列为独立的顶层核心块");
    expect(p).toContain("仍是 howto，不是 learning-path");
    expect(p).toContain("learning-path：阶段路线");
    expect(p).toContain("核心覆盖规则");
    expect(p).toContain("不得删去");
    expect(tutorInstructions("expand")).toContain('"block":"块id"');
  });
});

describe("new-card hygiene", () => {
  it("drops near-duplicate cards and skips relations to unknown cards", () => {
    const board = createEmptyBoard("React 和 Vue 有什么区别");
    const first = buildMapFromAI(
      JSON.stringify({
        nodes: [{ id: "a", title: "模板与 JSX", body: "JSX 里直接写 JS，Vue 模板是带指令的 HTML。" }],
        relations: [],
      }),
      board,
    );
    const next = buildMapFromAI(
      JSON.stringify({
        nodes: [
          { id: "b", title: "模板与JSX！", body: "完全不同的正文内容在这里。" },
          { id: "b1", title: "子卡", body: "随重复卡一起丢弃", parent: "b" },
          { id: "c", title: "JSX 与模板写法", body: "JSX 里直接写 JS，Vue 模板是带指令的 HTML。" },
          { id: "d", title: "状态管理", body: "React 不可变更新，Vue 响应式直接修改。" },
        ],
        relations: [{ source: "d", target: "concept_missing", label: "x" }],
      }),
      first,
    );
    expect(next.nodes.map((n) => n.title).slice(2)).toEqual(["状态管理"]);
    expect(next.relations).toHaveLength(first.relations.length);
  });
});

it("a self or unknown relation is skipped, the cards still land", () => {
  const board = createEmptyBoard("学习");
  const next = buildMapFromAI(
    JSON.stringify({
      nodes: [{ id: "s", title: "结构", body: "内容" }],
      relations: [
        { source: "s", target: "s", label: "self" },
        { source: "s", target: "unrelated-board-node", label: "invalid" },
      ],
    }),
    board,
  );
  expect(next.nodes).toHaveLength(2);
  expect(next.relations).toHaveLength(0);
});
