import type { Board, StickyNote } from "../shared/types";
import { outlineOf, plain } from "./answer";

/** Top-level cards, left to right. A board can grow several roots side by side. */
export const rootsOf = <T extends { parentId: string | null; order: number }>(
  nodes: T[],
): T[] =>
  nodes.filter((n) => n.parentId === null).sort((a, b) => a.order - b.order);
/** The primary root: the leftmost top-level card. */
export const rootOf = (board: Board) => rootsOf(board.nodes)[0];
/** The board's question card: the node marked `question`, else the leftmost root (older boards). */
export function questionId<
  T extends {
    id: string;
    parentId: string | null;
    order: number;
    question?: boolean;
  },
>(nodes: T[]): string | undefined {
  return (nodes.find((n) => n.question) ?? rootsOf(nodes)[0])?.id;
}
/**
 * A root that shows the board's topic. Roots grown later (above or beside it) and cards
 * promoted to roots show their own title.
 */
export function isQuestionRoot<
  T extends {
    id: string;
    parentId: string | null;
    order: number;
    question?: boolean;
  },
>(nodes: T[], n: T): boolean {
  return n.parentId === null && n.id === questionId(nodes);
}

/** An AI board whose root question has no children yet: the user needs an obvious next step. */
export function needsKickoff(board: Board | null | undefined): boolean {
  if (!board || board.kind !== "ai") return false;
  const root = rootOf(board);
  return Boolean(root) && !board.nodes.some((n) => n.parentId === root!.id);
}

/** The drawer conversation attached to the root question, if any. */
export function kickoffNote(board: Board): StickyNote | undefined {
  const root = rootOf(board);
  return root
    ? board.notes.find(
        (n) => n.attachedTo?.kind === "node" && n.attachedTo.id === root.id,
      )
    : undefined;
}

export const KICKOFF_MESSAGE = "我想从这里开始学，带我起步吧。";

/**
 * Sent in answer mode. Shown in the thread as the learner's own short line; the
 * instructions after it ask the tutor to probe prior knowledge first.
 */
export function kickoffPrompt(topic: string): string {
  return `${KICKOFF_MESSAGE}
我的起点问题是：「${topic}」。
请先别讲解。通过 3–5 题逐一问清想拿到的产出物、成功标准、约束（预算与期限）、真实经历和已经知道些什么；每次只问一题，可提供 chips。收齐后把答案写进 goal，返回 ready:true，再按产出物的组成排路线。知识层级按整体到细节划分，不按问答先后划分。`;
}

/** What the learner said in the kickoff conversation (their own replies, not the kickoff line). */
export function learnerAnswers(note: StickyNote | undefined): string[] {
  return (note?.messages ?? [])
    .filter((m) => m.role === "user" && !m.text.startsWith(KICKOFF_MESSAGE))
    .map((m) => m.text.trim())
    .filter(Boolean)
    .slice(-6);
}

/**
 * The skeleton the tutor proposed in the kickoff: the outline of its latest answer
 * that has one (two or more items, not a list of questions to the learner), as
 * "head：gist" lines. Empty when none.
 */
export function kickoffSkeleton(note: StickyNote | undefined): string[] {
  const replies = (note?.messages ?? []).filter((m) => m.role === "assistant");
  for (let i = replies.length - 1; i >= 0; i--) {
    const items = outlineOf(replies[i].text);
    // A numbered list of questions to the learner ("你现在了解多少？") is not a skeleton.
    const asks = replies[i].text.match(
      /^\s*(?:\d+[.、)）]|[-*])\s.*[？?]\s*$/gm,
    );
    if (items.length > 1 && (asks?.length ?? 0) * 2 < items.length)
      return items.map((item) => {
        const gist = plain(item.rest)
          .replace(/^[：:\s]+/, "")
          .trim();
        return gist ? `${item.head}：${gist}` : item.head;
      });
  }
  return [];
}

/**
 * Map-mode prompt for the first level of child questions, informed by the
 * learner's answers. With an outline (the numbered skeleton the tutor already
 * gave), the level must follow it so the canvas matches the drawer.
 */
export function firstLevelPrompt(
  topic: string,
  answers: string[],
  outline?: string[],
): string {
  const known = answers.length
    ? `学习者说自己已经知道 / 想弄懂的是：${answers.map((a) => `「${a.slice(0, 300)}」`).join("；")}。据此调整解释和学习顺序，知识层级仍按主题的整体与细节划分。`
    : "学习者还没说自己知道什么，按初学者处理。";
  const skeleton = outline?.length
    ? `\n必须按这份骨架拆，一项一个子问题，顺序不变：${outline.map((h, i) => `${i + 1}. ${h.slice(0, 60)}`).join("；")}。`
    : "";
  return `为这个问题创建学习地图的第一层：「${topic}」。${known}${skeleton}
给 3–5 个抽象程度相近、彼此并列不重叠、合起来覆盖整个问题的大图景子问题，都以 anchor 为 parent。按建议的阅读或学习顺序从左到右排列；具体原理与细节属于下一知识层，提问次数不决定层级。每个标题写成一个具体的小问题，正文一两句说明它在主题中的作用。具体、直观、少文字。`;
}

/** The thread shows only the learner-facing line of the kickoff request. */
export const displayMessage = (role: "user" | "assistant", text: string) =>
  role === "user" && text.startsWith(KICKOFF_MESSAGE) ? KICKOFF_MESSAGE : text;
