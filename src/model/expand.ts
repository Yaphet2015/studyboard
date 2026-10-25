import { probeBrief } from "./probe";
import type { Board, ConceptNode, DepthType } from "../shared/types";
import { angleRule, type DigAngle } from "./angles";
import { LIMITS } from "../shared/validation";

export const DEPTH_LABEL: Record<DepthType, string> = {
  what: "是什么",
  why: "为什么",
  how: "怎么做",
  edge: "边界",
  apply: "应用",
  compare: "对照",
};
const LADDER: DepthType[] = ["what", "why", "how", "edge", "apply"];

/** The next rungs below a card: one or two steps further along what → why → how → edge → apply. */
export function nextDepths(parent?: DepthType): DepthType[] {
  if (!parent) return ["why", "how"];
  if (parent === "compare") return ["edge", "apply"];
  const i = LADDER.indexOf(parent);
  const next = LADDER.slice(i + 1, i + 3);
  return next.length ? next : ["edge", "compare"];
}

const points = (n: ConceptNode) =>
  [n.summary, ...(n.keyPoints ?? [])].filter(Boolean).join("；") ||
  n.body.slice(0, 80);

/** Expand-mode user prompt for one card (the system rules live in tutorInstructions("expand")). */
export function expandPrompt(
  board: Board | string,
  anchorId?: string,
  angle?: DigAngle,
): string {
  // Older callers pass only a title.
  if (typeof board === "string") return basePrompt(board, "", []);
  const anchor = board.nodes.find((n) => n.id === anchorId);
  if (!anchor) return basePrompt("", "", []);
  const parent = board.nodes.find((n) => n.id === anchor.parentId);
  const siblings = board.nodes.filter(
    (n) => n.parentId === anchor.parentId && n.id !== anchor.id,
  );
  const children = board.nodes.filter((n) => n.parentId === anchor.id);
  const known = [
    `当前卡片「${anchor.title}」：${points(anchor)}`,
    ...(parent ? [`父卡「${parent.title}」：${points(parent)}`] : []),
    ...siblings.slice(0, 6).map((n) => `兄弟卡「${n.title}」：${points(n)}`),
    ...children.slice(0, 6).map((n) => `已有子卡「${n.title}」：${points(n)}`),
  ];
  const next = nextDepths(anchor.depthType);
  const ladder = angle
    ? angleRule(angle)
    : `深度阶梯：当前卡片是「${anchor.depthType ? DEPTH_LABEL[anchor.depthType] : "未标注"}」层。新卡片优先往下一阶走：${next.map((d) => `${d}（${DEPTH_LABEL[d]}）`).join(" 或 ")}，并在 depthType 里标出；不要再停留在“是什么”的同一层重复定义。`;
  const brief = probeBrief(board);
  return basePrompt(anchor.title, ladder, known) + (brief ? `\n${brief}` : "");
}

function basePrompt(title: string, ladder: string, known: string[]): string {
  return `围绕「${title}」补充 2–4 个有帮助的新概念或具体子问题。先检查白板结构和已有子概念，避免重复或换句话重述已有内容；已展开过仍可继续补充。按知识关系设置 parent：同层概念放到共同父节点下，组成、原理或细节才放到对应概念下。先解释它如何工作或用一个例子拆开，不要一次铺开整个领域；不要按提问先后逐层往下挂。${ladder ? `\n${ladder}` : ""}${known.length ? `\n以下要点已经在画布上，新卡片不要重复它们，只补它们没讲到的新事实、机制、例子或判断标准：\n${known.map((k) => `- ${k}`).join("\n")}` : ""}
输出前自查：每张新卡片至少带来一条上面没有的新信息，否则删去。如果这次没有值得补充的新内容，返回 {"nodes":[],"relations":[]}，不要勉强凑数。`;
}

/** A ghost hint the learner picked: exactly one card on that point, through the usual gate. */
export function hintCardNote(title: string): string {
  return `
学习者从提示里选了这个方向：「${title.slice(0, 80)}」。只生成这 1 张卡：标题可以改写成一句结论，但必须讲这个点；正文和检查题照常给出。`;
}

/**
 * 重做下层: the learner's own rule for how the cards below this one are cut. It overrides the usual
 * 2–4 cards, because 「每个 Skill 一张」 can need a dozen; everything else (gate, check question) is unchanged.
 */
export function reExpandNote(instruction: string): string {
  return `
学习者要求重做这张卡的下一层，要求是：「${instruction.slice(0, 200)}」。以这个要求为准，它覆盖上面「2–4 个」「2–3 个」的数量建议：按要求需要几张就生成几张，最多 ${LIMITS.expansionCards} 张；每张卡是 anchor 的直接子卡，parent 都写 "anchor"，不要再往下嵌套。画布上这张卡现在没有子卡，不用避开旧的内容。按学习者的拆法分，不要换成你自己的分法。`;
}
