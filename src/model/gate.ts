import type { Board, ContextBundle, ConceptNode } from "../shared/types";
import { buildMapFromAI, newId } from "./boards";
import type { GateOutcome, RawCard } from "./novelty";

/** Keys the board map schema accepts; gate and check fields are taken out before it. */
const MAP_KEYS = ["id", "title", "body", "parent", "emoji", "color", "visual", "block", "depthType", "source", "date", "weight", "questionPrompt", "upgradeCheck", "sources"];
const clean = (c: RawCard) =>
  Object.fromEntries(MAP_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

/** Turn the gate's verdicts into a board: kept cards land with their check + meta; merges extend a card. */
export function applyGate(
  board: Board,
  anchorId: string,
  outcome: GateOutcome & { rest: Record<string, unknown> },
  mode: "map" | "expand",
  context?: ContextBundle,
): { board: Board; added: string[]; mergedInto: string[] } {
  let next = board;
  if (outcome.kept.length) {
    const json = JSON.stringify({
      nodes: outcome.kept.map((k) => clean(k.card)),
      relations: Array.isArray(outcome.rest.relations) ? outcome.rest.relations : [],
      ...(outcome.rest.overviews ? { overviews: outcome.rest.overviews } : {}),
    });
    try {
      next = buildMapFromAI(json, board, anchorId, mode, context);
    } catch {
      // Relations to dropped cards can fail the map: try once more without them.
      next = buildMapFromAI(
        JSON.stringify({ nodes: outcome.kept.map((k) => clean(k.card)), relations: [] }),
        board,
        anchorId,
        mode,
        context,
      );
    }
  }
  const known = new Set(board.nodes.map((n) => n.id));
  const byTitle = new Map(outcome.kept.map((k) => [k.card.title.trim(), k]));
  const added: string[] = [];
  next = {
    ...next,
    nodes: next.nodes.map((n): ConceptNode => {
      if (known.has(n.id)) return n;
      added.push(n.id);
      const k = byTitle.get(n.title.trim());
      if (!k) return n;
      const c = k.card.check;
      const options = Array.isArray(c?.options) ? c.options.map(String).slice(0, 5) : undefined;
      return {
        ...n,
        ...(c?.q ? { check: { q: String(c.q).slice(0, 400), ...(options?.length ? { options } : {}) } } : {}),
        meta: {
          gate: k.meta,
          ...(Number.isInteger((k.card as { level?: unknown }).level)
            ? { level: Math.min(5, Math.max(0, (k.card as unknown as { level: number }).level)) }
            : {}),
          ...(c?.q
            ? {
                check: {
                  keyPoints: (c.keyPoints ?? []).map(String).slice(0, 6),
                  ...(options && typeof c.answer === "number" && c.answer < options.length ? { answer: c.answer } : {}),
                },
              }
            : {}),
        },
      };
    }),
  };
  // A card that repeats one already on the board extends that card instead (spec §4.7 合并).
  const mergedInto: string[] = [];
  for (const { card, into } of outcome.merges) {
    const target = next.nodes.find((n) => n.id === into);
    if (!target) continue;
    const addition = String(card.newIdea || card.body.split(/[。！？]/)[0] || "").trim();
    if (!addition || target.body.includes(addition)) continue;
    mergedInto.push(into);
    next = {
      ...next,
      nodes: next.nodes.map((n) =>
        n.id === into ? { ...n, body: `${n.body}${/[。！？]$/.test(n.body) || !n.body ? "" : "。"}${addition}。`.slice(0, 4000) } : n,
      ),
      relations:
        anchorId !== into && !next.relations.some((r) => [r.source, r.target].includes(anchorId) && [r.source, r.target].includes(into))
          ? [...next.relations, { id: newId("relation"), source: anchorId, target: into, label: "已补充进这张卡", kind: "cross" as const }]
          : next.relations,
    };
  }
  return { board: next, added, mergedInto };
}
