import type { Board, BoardProgress } from "../shared/types.js";

/**
 * The sidebar's per-canvas progress, matching the 理解进度 pill: every card below the root is one
 * segment, an explained (sealed) card is a filled one. A canvas is done once its wrap-up is sealed
 * or every card is explained. Stored on the board at save time so the list never re-derives it.
 */
export function boardProgress(board: Pick<Board, "nodes" | "wrap">): BoardProgress {
  const concepts = board.nodes.filter((n) => n.parentId !== null);
  const sealed = concepts.filter((n) => n.status === "explained").length;
  const total = concepts.length;
  return { sealed, total, done: Boolean(board.wrap?.done) || (total > 0 && sealed === total) };
}

/** Save-time metadata. listSessions currently includes every note, including saved annotations. */
export const withProgress = <B extends Board>(board: B): B => ({ ...board, progress: boardProgress(board), sessionCount: board.notes.length });
