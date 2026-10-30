import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  boardSchema,
  conceptNodeSchema,
  planGoalSchema,
} from "../src/shared/validation";
import { createEmptyBoard, buildMapFromAI } from "../src/model/boards";
import {
  gapMessage,
  upgradeCard,
  parseAssessment,
  goalText,
  assessmentPrompt,
} from "../src/model/goal";
import { parseChatReply, displayChat, chatPrompt } from "../src/model/chat";
import { nextStep } from "../src/model/next-step";
import { CardSourceLine } from "../src/components/CardSourceLine";
import { WeightFooter } from "../src/components/WeightFooter";
import { goalBoard, fixtureGoal } from "./goal-fixtures";
import { applyGate } from "../src/model/gate";

const assessment = (current: number) => ({
  part: {
    stopId: "goal-core",
    title: "图片说明",
    content: "已按图片用途补充描述。",
  },
  results: [{ id: "access", current, evidence: "项目测量记录" }],
  suggestion: "下一站检查无法加载图片的情况。",
  focus: "补齐读者仍无法理解的作品意图",
});

describe("goal and weight compatibility", () => {
  it("reads old canvases with a default weight and preserves string goals", () => {
    const old = createEmptyBoard("旧问题");
    old.plan = {
      status: "confirmed",
      intent: "concept",
      goal: "解释清楚",
      learner: "",
      blocks: [],
      outOfScope: [],
    };
    const parsed = boardSchema.parse(old);
    expect(parsed.nodes[0].weight).toBe("background");
    expect(parsed.plan).toMatchObject({ goal: "解释清楚", artifact: [] });
    expect(old.nodes[0].weight).toBeUndefined();
    expect(boardSchema.parse(parsed)).toEqual(parsed);
  });
  it("defaults missing structured goal details without inventing answers", () => {
    expect(planGoalSchema.parse({ deliverable: "交付清单" })).toEqual({
      deliverable: "交付清单",
      criteria: [],
      constraints: [],
      experience: "",
    });
  });
  it("round trips source/date, weights, goal and attachment metadata", () => {
    const board = goalBoard();
    const msg = gapMessage(board, "goal-core", assessment(84))!;
    board.notes.push({
      id: "note-goal",
      title: "",
      text: "",
      position: { x: 0, y: 0 },
      messages: [
        {
          id: "msg-goal",
          role: "assistant",
          createdAt: board.createdAt,
          ...msg,
        },
      ],
    });
    expect(
      boardSchema.parse(JSON.parse(JSON.stringify(board))).notes[0].messages[0]
        .meta,
    ).toEqual(msg.meta);
    expect(
      conceptNodeSchema.safeParse({ ...board.nodes[1], date: "2026-99" })
        .success,
    ).toBe(false);
  });
  it("keeps the new card fields through both generation and the gate", () => {
    const board = createEmptyBoard("交付清单");
    const node = {
      id: "card-a",
      title: "图片用途不同，说明也不同",
      body: "作品展示应描述作品内容。图标说明操作用途。",
      source: "项目记录",
      date: "2026-10",
      weight: "hard",
      questionPrompt: "移除图片后还能理解吗？",
      upgradeCheck: { q: "图标该描述什么？", options: ["用途", "文件名"] },
    };
    expect(
      buildMapFromAI(JSON.stringify({ nodes: [node] }), board).nodes[1],
    ).toMatchObject({ ...node, id: expect.any(String) });
    const applied = applyGate(
      board,
      board.nodes[0].id,
      {
        kept: [{ card: node, meta: {} }],
        merges: [],
        dropped: [],
        tokens: 0,
        calls: { regen: 0, judge: 0 },
        rest: {},
      },
      "map",
    );
    expect(applied.board.nodes[1]).toMatchObject({
      weight: "hard",
      source: node.source,
      questionPrompt: node.questionPrompt,
    });
  });
  it("promotes one level and uses prepared questions; hard stays hard", () => {
    const card = goalBoard().nodes[1];
    const core = { ...card, ...upgradeCard({ ...card, weight: "background" }) };
    expect(core).toMatchObject({
      weight: "core",
      check: card.upgradeCheck,
      status: "exploring",
    });
    const hard = { ...core, ...upgradeCard(core) };
    expect(hard).toMatchObject({
      weight: "hard",
      questionPrompt: card.questionPrompt,
    });
    expect(upgradeCard(hard)).toEqual({});
    expect(card.weight).toBe("background");
  });
  it("a read background stop moves on while retaining hollow progress", () => {
    const b = goalBoard();
    b.nodes[1] = { ...b.nodes[1], status: "exploring", beat: "done" };
    expect(nextStep(b)).toMatchObject({ card: { id: "goal-core" } });
  });
});

describe("station gap messages", () => {
  it("calculates a delta, bolds it, and proposes only a future focus", () => {
    const message = gapMessage(goalBoard(), "goal-core", assessment(84))!;
    expect(message.text).toContain(
      "**可访问性评分至少 90：当前 84分，还差 6分**",
    );
    expect(message.meta?.proposal).toMatchObject({
      type: "editRoute",
      ops: [{ op: "focus", stop: 3 }],
    });
    expect(message.meta?.artifact).toMatchObject({
      added: "goal-core",
      parts: [{ stopId: "goal-bg" }, { stopId: "goal-core" }],
    });
  });
  it("does not propose focus when the standard is met or evidence is missing", () => {
    expect(
      gapMessage(goalBoard(), "goal-core", assessment(93))!.meta?.proposal,
    ).toBeUndefined();
    const unknown = { ...assessment(84), results: [] };
    expect(gapMessage(goalBoard(), "goal-core", unknown)!.text).toContain(
      "还没有足够依据",
    );
    expect(
      gapMessage(goalBoard(), "goal-core", unknown)!.meta?.proposal,
    ).toBeUndefined();
  });
  it("handles upper bounds and qualitative standards without assuming a domain", () => {
    const b = goalBoard();
    b.plan!.goal = {
      ...fixtureGoal,
      criteria: [
        {
          id: "time",
          label: "加载不超过 2 秒",
          target: 2,
          direction: "atMost",
          unit: "秒",
        },
        { id: "review", label: "同伴能读懂" },
      ],
    };
    const msg = gapMessage(b, "goal-core", {
      ...assessment(0),
      results: [
        { id: "time", current: 2.7, evidence: "测量记录" },
        { id: "review", met: false, evidence: "同伴反馈" },
      ],
    })!;
    expect(msg.text).toContain("还差 0.7秒");
    expect(msg.text).toContain("还需补齐（同伴反馈）");
  });
  it("rejects a different stop and malformed assessments and updates a part only once", () => {
    const b = goalBoard();
    expect(gapMessage(b, "goal-hard", assessment(84))).toBeUndefined();
    expect(parseAssessment('{"part":{}}')).toBeUndefined();
    b.plan!.artifact!.push(assessment(84).part);
    expect(
      gapMessage(b, "goal-core", assessment(87))!.meta?.artifact?.parts,
    ).toHaveLength(2);
    expect(
      gapMessage(b, "goal-core", assessment(87))!.meta?.artifact?.added,
    ).toBeUndefined();
    expect(assessmentPrompt(b, "goal-core")).toContain("source");
  });
});

describe("chat and card rendering", () => {
  it("reads chips and goal edits while hiding structured tails during streaming", () => {
    const raw = `记下了。\n\`\`\`json\n${JSON.stringify({ goal: fixtureGoal, ready: true, chips: ["一份清单"] })}\n\`\`\``;
    expect(displayChat(raw)).toBe("记下了。");
    expect(parseChatReply(raw, goalBoard())).toMatchObject({
      reply: "记下了。",
      goal: fixtureGoal,
      ready: true,
    });
    expect(displayChat('好。{"goal":')).toBe("好。");
    expect(chatPrompt(goalBoard(), undefined, "改目标", "goal-core")).toContain(
      fixtureGoal.deliverable,
    );
    expect(goalText(fixtureGoal)).toContain(fixtureGoal.experience);
  });
  it("renders source and month as plain text, with no links or popup", () => {
    const html = renderToStaticMarkup(
      createElement(CardSourceLine, {
        card: { source: "项目记录", date: "2026-10-20" },
      }),
    );
    expect(html).toBe('<div class="srcl">项目记录 · 截至 2026-10</div>');
    expect(
      renderToStaticMarkup(createElement(CardSourceLine, { card: {} })),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(CardSourceLine, {
          card: { sources: [{ title: "旧来源", url: "https://example.com" }] },
        }),
      ),
    ).toContain("旧来源</div>");
  });
  it("escapes source text and renders distinct footers without weight labels", () => {
    expect(
      renderToStaticMarkup(
        createElement(CardSourceLine, { card: { source: "<script>" } }),
      ),
    ).toContain("&lt;script&gt;");
    const actions = { onRead() {}, async onAnswer() {} };
    const cards = goalBoard()
      .nodes.slice(1)
      .map((c) => ({ ...c, status: "unseen" as const, beat: undefined }));
    const [bg, core, hard] = cards.map((card) =>
      renderToStaticMarkup(createElement(WeightFooter, { card, actions })),
    );
    expect(bg).toContain("懂了");
    expect(bg).not.toContain("<form");
    expect(core).toContain(cards[1].check!.q);
    expect(core).not.toContain("<input");
    expect(hard).toContain("写下你的猜测");
    expect(hard).toContain(cards[2].questionPrompt);
  });
});
