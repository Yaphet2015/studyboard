import type { Board, StickyNote } from "../shared/types";
import { displayMessage, rootOf } from "./kickoff";

/** One conversation on this board, as the drawer's session list shows it. */
export interface SessionEntry {
  id: string;
  title: string;
  /** The card it hangs on; null for a free note, "" for a relation. */
  anchorId: string | null;
  anchorTitle: string;
  /** ISO time of the last activity: last message, else creation, else the board. */
  time: string;
  count: number;
  /** Cards brought in besides the anchor. */
  extra: number;
  /** ISO creation time (older notes without one fall back to `time`). */
  created: string;
}

const DEFAULT_TITLES = new Set(["我的问题", ""]);

export function sessionTime(board: Board, note: StickyNote): string {
  return note.messages.at(-1)?.createdAt ?? note.createdAt ?? board.updatedAt;
}

export function listSessions(board: Board): SessionEntry[] {
  const root = rootOf(board);
  return board.notes
    .map((note): SessionEntry => {
      const at = note.attachedTo;
      const node =
        at?.kind === "node"
          ? board.nodes.find((n) => n.id === at.id)
          : undefined;
      const relation =
        at?.kind === "relation"
          ? board.relations.find((r) => r.id === at.id)
          : undefined;
      const anchorTitle = node
        ? node.id === root?.id
          ? "起点问题"
          : node.title
        : relation
          ? `连线 · ${relation.label || "关系"}`
          : "自由批注";
      const question = note.messages.find((m) => m.role === "user");
      const custom =
        !DEFAULT_TITLES.has(note.title.trim()) &&
        note.title.trim() !== node?.title.trim();
      const title = (
        custom
          ? note.title
          : question
            ? displayMessage("user", question.text).replace(/[*_`#>]/g, "")
            : note.text || node?.title || "新对话"
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      return {
        id: note.id,
        title,
        anchorId: node ? node.id : relation ? "" : null,
        anchorTitle,
        time: sessionTime(board, note),
        count: note.messages.length,
        extra: note.contextCards?.length ?? 0,
        created: note.createdAt ?? sessionTime(board, note),
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time));
}

/** The most recent conversation on a card or relation, if any. */
export function latestNoteOn(
  board: Board,
  attachment: NonNullable<StickyNote["attachedTo"]>,
): StickyNote | undefined {
  return board.notes
    .filter(
      (n) =>
        n.attachedTo?.kind === attachment.kind &&
        n.attachedTo.id === attachment.id,
    )
    .sort((a, b) =>
      sessionTime(board, b).localeCompare(sessionTime(board, a)),
    )[0];
}

/**
 * The drawer's tab strip: newest conversation first by creation, so tabs keep their places
 * while you talk in one (the full list stays ordered by last activity).
 */
export function stripOrder(sessions: SessionEntry[]): SessionEntry[] {
  return [...sessions].sort((a, b) => b.created.localeCompare(a.created));
}

/** "14:05" today, "昨天 14:05", else "10月3日". */
export function sessionClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Keep the latest six and the active conversation in activity order. */
export function visibleSessions(
  entries: SessionEntry[],
  activeId: string | undefined,
  expandedAll: boolean,
): { rows: SessionEntry[]; hidden: number } {
  const sorted = [...entries].sort((a, b) => b.time.localeCompare(a.time));
  const rows =
    expandedAll || sorted.length <= 8
      ? sorted
      : sorted.filter((entry, i) => i < 6 || entry.id === activeId);
  return { rows, hidden: entries.length - rows.length };
}

export function filterSessions(
  entries: SessionEntry[],
  query: string,
): SessionEntry[] {
  const q = query.trim().toLocaleLowerCase();
  return entries.filter((entry) =>
    `${entry.title} ${entry.anchorTitle}`.toLocaleLowerCase().includes(q),
  );
}
