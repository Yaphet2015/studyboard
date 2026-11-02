import type { Board, BoardProgress, ConceptNode } from "../shared/types.js";

/**
 * The sidebar's per-canvas progress, matching the 理解进度 pill: every card below the root is one
 * segment, an explained (sealed) card is a filled one. A canvas is done once its wrap-up is sealed
 * or every card is explained. Stored on the board at save time so the list never re-derives it.
 */
export function boardProgress(board: Pick<Board, "nodes" | "wrap">): BoardProgress {
  const concepts = board.nodes.filter((n) => n.parentId !== null);
  const sealed = concepts.filter((n) => n.status === "explained").length;
  const total = concepts.length;
  const known = knownIds(board.nodes);
  // 已会 cards are skippable: they never block done, but are not counted as sealed by the learner.
  const settled = concepts.filter((n) => n.status === "explained" || known.has(n.id)).length;
  return { sealed, total, ...(known.size ? { known: known.size } : {}), done: Boolean(board.wrap?.done) || (total > 0 && settled === total) };
}

/** Demonstrated mastery on a weighted card: core/hard explained (not merely inferred by 摸底), or any card re-checked after 摸底. */
export const cardMastered = (card: Pick<ConceptNode, "weight" | "status" | "seal">) =>
  card.status === "explained" &&
  (card.seal === "probe-reviewed" || ((card.weight === "core" || card.weight === "hard") && card.seal !== "probe"));

/**
 * 摸底「已会」on a weighted route: a probe-sealed station and every card under it, until the learner
 * misses that card (seal "probe-revoked") or re-checks it into mastery.
 */
export function knownIds(nodes: ConceptNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.parentId === null || !n.weight || n.seal === "probe-revoked" || cardMastered(n)) continue;
    for (let a: ConceptNode | undefined = n, hops = 0; a && hops < 64; a = a.parentId ? byId.get(a.parentId) : undefined, hops++) {
      if (a.seal === "probe") { out.add(n.id); break; }
      if (a !== n && a.seal === "probe-revoked") break;
    }
  }
  return out;
}

/** Save-time metadata. listSessions currently includes every note, including saved annotations. */
export const withProgress = <B extends Board>(board: B): B => ({ ...board, progress: boardProgress(board), sessionCount: board.notes.length });
