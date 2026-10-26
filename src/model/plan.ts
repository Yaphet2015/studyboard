import { probeBrief } from "./probe";
import { z } from "zod";
import type { Board, BoardPlan, PlanBlock, PlanIntent } from "../shared/types";
import { idSchema, planIntentSchema } from "../shared/validation";

export const INTENT_LABEL: Record<PlanIntent, string> = {
  concept: "概念：是什么",
  mechanism: "机制：如何运作",
  decision: "决策：怎么选",
  howto: "操作：怎么做",
  "learning-path": "学习路径：怎么学",
  compare: "对比：有什么区别",
};

/** User prompt of the plan request: after the kickoff, or straight from the question. */
export function planPrompt(topic: string, answers: string[], learner = ""): string {
  const known = answers.length
    ? `学习者在开场对话里说：${answers.map((a) => `「${a.slice(0, 300)}」`).join("；")}。`
    : learner ? "学习者没有补充开场回答，参考下面的摸底结果和画像安排深度。" : "学习者跳过了开场提问，按初学者处理。";
  return `为这个起点问题拟定学习计划：「${topic}」。${known}
${learner}
先拟计划，不要生成卡片。只输出计划 JSON。`;
}

const aiPlanSchema = z
  .object({
    intent: planIntentSchema,
    goal: z.string().min(1).max(400),
    learner: z.string().max(400).catch(""),
    blocks: z
      .array(
        z
          .object({
            id: idSchema,
            title: z.string().min(1).max(80),
            why: z.string().max(300).catch(""),
            parent: idSchema.nullable().optional(),
            prerequisites: z.array(idSchema).max(12).optional().catch(undefined),
            core: z.boolean().optional().catch(undefined),
          })
          .strip(),
      )
      .min(3)
      .max(16),
    outOfScope: z.array(z.string().max(80)).max(8).optional().catch(undefined),
  })
  .strip();

/** Read the plan JSON (fenced or bare). Throws a learner-facing message when unusable. */
export function parsePlan(text: string): BoardPlan {
  let raw = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(raw);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("AI 没有返回有效的学习计划，请重试。");
  }
  const result = aiPlanSchema.safeParse(parsed);
  if (!result.success)
    throw new Error("AI 返回的学习计划不完整，请重试。");
  const p = result.data;
  const seen = new Set<string>();
  const blocks = p.blocks.filter((b) => !seen.has(b.id) && seen.add(b.id));
  const ids = new Set(blocks.map((b) => b.id));
  const clean: PlanBlock[] = blocks.map((b) => ({
    id: b.id,
    title: b.title.trim(),
    why: b.why.trim(),
    // Only top-level parents keep the skeleton two levels deep.
    parent:
      b.parent && ids.has(b.parent) && b.parent !== b.id
        ? b.parent
        : null,
    prerequisites: (b.prerequisites ?? []).filter(
      (x) => ids.has(x) && x !== b.id,
    ),
    core: b.core ?? true,
  }));
  const top = new Set(clean.filter((b) => b.parent === null).map((b) => b.id));
  for (const b of clean) if (b.parent && !top.has(b.parent)) b.parent = null;
  if (clean.filter((b) => b.parent === null).length < 2)
    throw new Error("AI 返回的学习计划缺少顶层块，请重试。");
  return {
    status: "draft",
    intent: p.intent,
    goal: p.goal.trim(),
    learner: p.learner.trim(),
    blocks: clean,
    outOfScope: (p.outOfScope ?? []).map((s) => s.trim()).filter(Boolean),
  };
}

export const topBlocks = (plan: BoardPlan) =>
  plan.blocks.filter((b) => b.parent === null);

/** Blocks some card on the board realises. */
export function coveredBlocks(board: Board): Set<string> {
  const ids = new Set(board.plan?.blocks.map((b) => b.id));
  return new Set(
    board.nodes
      .map((n) => n.planBlock)
      .filter((id): id is string => !!id && ids.has(id)),
  );
}

/** The block a card belongs to: its own, else the nearest ancestor's. */
export function blockOf(board: Board, nodeId: string): PlanBlock | undefined {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  for (let n = byId.get(nodeId); n; n = n.parentId ? byId.get(n.parentId) : undefined)
    if (n.planBlock) return board.plan?.blocks.find((b) => b.id === n!.planBlock);
  return undefined;
}

/** The confirmed plan as request context: goal, skeleton with coverage, this card's block, what is uncovered. */
export function renderPlan(board: Board, anchorId: string | null): string | undefined {
  const plan = board.plan;
  if (!plan || plan.status !== "confirmed") return undefined;
  const covered = coveredBlocks(board);
  const title = new Map(plan.blocks.map((b) => [b.id, b.title]));
  const line = (b: PlanBlock, indent: string) =>
    `${indent}- [${b.id}] ${covered.has(b.id) ? "✓已有卡片" : "✗未覆盖"}${b.core ? " · 核心" : ""} ${b.title}${b.why ? ` —— ${b.why}` : ""}${b.prerequisites.length ? `（先修：${b.prerequisites.map((p) => title.get(p) ?? p).join("、")}）` : ""}`;
  const lines: string[] = [];
  for (const top of topBlocks(plan)) {
    lines.push(line(top, ""));
    for (const sub of plan.blocks.filter((b) => b.parent === top.id))
      lines.push(line(sub, "  "));
  }
  const mine = anchorId ? blockOf(board, anchorId) : undefined;
  const own = mine
    ? [mine, ...plan.blocks.filter((b) => b.parent === mine.id)]
    : [];
  // Cards already in this block (excluding the anchor's own subtree path): the expansion must not restate them.
  const ownIds = new Set(own.map((b) => b.id));
  const inBlock = mine
    ? board.nodes
        .filter(
          (n) =>
            n.id !== anchorId &&
            ownIds.has(blockOf(board, n.id)?.id ?? "") &&
            n.title,
        )
        .slice(0, 14)
    : [];
  const uncovered = plan.blocks.filter((b) => !covered.has(b.id));
  const ownOpen = own.filter((b) => !covered.has(b.id));
  return [
    `问题类型：${INTENT_LABEL[plan.intent]}`,
    `学习目标：${plan.goal}`,
    `学习者：${plan.learner || "按初学者处理"}`,
    "骨架（[块id]，✓ 表示画布上已有卡片实现了这个块）：",
    ...lines,
    mine
      ? `当前卡片属于块 [${mine.id}] ${mine.title}${ownOpen.length ? `；这个块下尚未覆盖：${ownOpen.map((b) => `[${b.id}] ${b.title}`).join("、")}` : "；这个块下的子块都已覆盖，继续深入它的原因、机制、例子、误区或判断标准"}。`
      : "当前卡片不属于具体的块。",
    inBlock.length
      ? `同一块里已有这些卡片，新卡片不要重复它们的内容，只补它们没讲到的：\n${inBlock.map((n) => `  · ${n.title}：${(n.body ?? "").slice(0, 80)}`).join("\n")}`
      : "",
    uncovered.length
      ? `整张画布尚未覆盖的块：${uncovered.map((b) => `[${b.id}] ${b.title}`).join("、")}。`
      : "所有块都已有卡片。",
    plan.outOfScope.length ? `不展开的话题：${plan.outOfScope.join("、")}。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Map-mode prompt of the first level once the plan is confirmed: one card per top-level block. */
export function planFirstLevelPrompt(board: Board): string {
  const plan = board.plan!;
  const tops = topBlocks(plan);
  return `按已确认的学习计划为「${board.topic}」铺第一层：每个顶层块一张卡，顺序不变，都以 anchor 为 parent，并用 "block" 写上对应的块 id：${tops.map((b, i) => `${i + 1}. [${b.id}] ${b.title}`).join("；")}。
标题写成这个块要回答的具体小问题；正文直接给出这一块的要点（结论、关键数字或判断标准），并点明它对学习目标的作用，不要只写“介绍了……”。只铺这一层，子块留给后续展开。${ladderNote(board)}`;
}
/** With a 摸底 chain: the learner brief, plus the chain so each card can name the point it teaches. */
function ladderNote(board: Board): string {
  const ladder = board.probe?.ladder;
  if (!ladder?.length) return probeBrief(board);
  return `
${probeBrief(board)}
概念链（从浅到深，序号从 0 起）：${ladder.map((l, i) => `${i}. ${l.desc}`).join("；")}。每张卡加一个整数字段 "level"，写它主要讲的是链上第几个概念；卡片顺序从浅到深，不要为已懂的概念单独成卡。`;
}

/** Edits from the plan editor. */
export function renameBlock(plan: BoardPlan, id: string, title: string): BoardPlan {
  return {
    ...plan,
    blocks: plan.blocks.map((b) => (b.id === id ? { ...b, title } : b)),
  };
}
export function removeBlock(plan: BoardPlan, id: string): BoardPlan {
  const gone = new Set([
    id,
    ...plan.blocks.filter((b) => b.parent === id).map((b) => b.id),
  ]);
  return {
    ...plan,
    blocks: plan.blocks
      .filter((b) => !gone.has(b.id))
      .map((b) => ({
        ...b,
        prerequisites: b.prerequisites.filter((p) => !gone.has(p)),
      })),
  };
}
export const confirmPlan = (plan: BoardPlan): BoardPlan => ({
  ...plan,
  status: "confirmed",
});

/** Where to grow a missing block, and the prompt: under its parent block's card, else the root. */
export function coverTarget(
  board: Board,
  blockId: string,
): { anchorId: string; prompt: string } | undefined {
  const plan = board.plan;
  const block = plan?.blocks.find((b) => b.id === blockId);
  if (!plan || !block || coveredBlocks(board).has(blockId)) return undefined;
  const parentCard =
    block.parent !== null
      ? board.nodes.find((n) => n.planBlock === block.parent)
      : undefined;
  const anchor =
    parentCard ??
    board.nodes.find((n) => n.parentId === null) ??
    board.nodes[0];
  if (!anchor) return undefined;
  const prereq = block.prerequisites
    .map((id) => plan.blocks.find((b) => b.id === id)?.title)
    .filter(Boolean);
  const prompt = `学习计划里「${block.title}」（block ${block.id}）还没有卡片。围绕「${anchor.title}」只补 1 张卡片来覆盖它${block.why ? `：它的作用是${block.why}` : ""}。${prereq.length ? `它建立在 ${prereq.map((t) => `「${t}」`).join("、")} 之上，可以直接引用。` : ""}这张卡片的 block 写 "${block.id}"，parent 写 "anchor"，标题直接点明这一块要学会什么，不要重复画布上已有的内容。`;
  return { anchorId: anchor.id, prompt };
}
