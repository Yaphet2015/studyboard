// 重做下层: regenerate the cards directly below one card by the learner's own rule. The old cards go
// to cardArchives first (so they stay restorable, and so the novelty gate and the prompt do not
// treat them as "already on the board"); if nothing new lands, the board is left exactly as it was.
import type { Board, ContextBundle } from "../shared/types";
import { applyGate } from "./gate";
import type { GateOutcome } from "./novelty";
import { archiveBelow } from "./route";

/** The chat proposal a re-expansion belongs to, carried on the request until its cards land. */
export interface ReExpandJob {
  noteId: string;
  messageId: string;
  instruction: string;
}

export interface ReExpandResult {
  board: Board;
  added: string[];
  mergedInto: string[];
  outcome: GateOutcome & { rest: Record<string, unknown> };
  /** False when no new card survived the gate: board is the untouched original. */
  replaced: boolean;
}

/** The board as the generation sees it: everything below the card archived, the card itself kept. */
export const clearBelow = (board: Board, parentId: string, messageId: string, timestamp: string): Board =>
  archiveBelow(board, parentId, `reexpand-${messageId}`, timestamp, "对话中重做下层");

/** `run` gates the model's new cards against the cleared board and returns the gate outcome. */
export async function landReExpand(
  board: Board,
  parentId: string,
  messageId: string,
  timestamp: string,
  run: (cleared: Board) => Promise<GateOutcome & { rest: Record<string, unknown> }>,
  context?: ContextBundle,
): Promise<ReExpandResult> {
  const cleared = clearBelow(board, parentId, messageId, timestamp);
  const outcome = await run(cleared);
  const applied = applyGate(cleared, parentId, outcome, "expand", context);
  if (!applied.added.length) return { board, added: [], mergedInto: [], outcome, replaced: false };
  return { board: applied.board, added: applied.added, mergedInto: applied.mergedInto, outcome, replaced: true };
}
