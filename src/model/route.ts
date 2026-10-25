import type { Board, ConceptNode, RouteDiffRow, RouteOp } from "../shared/types";
import { applyCanvasEdits, questionNode, type CanvasOperation } from "../shared/canvas";

/** The learning path's stations in order: board.route if set, else the first level under the question. */
export function routeOf(board: Board): ConceptNode[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  if (board.route?.length)
    return board.route.map((id) => byId.get(id)).filter((n): n is ConceptNode => !!n);
  return [];
}
/** The order a route would get from the cards already there (old maps: 帮我排一条路线). */
export function defaultRoute(board: Board): string[] {
  const root = questionNode(board);
  return board.nodes
    .filter((n) => root && n.parentId === root.id)
    .sort((a, b) => a.order - b.order)
    .map((n) => n.id);
}
/** 1-based station number of a card, or undefined when it is not on the route. */
export function stationOf(board: Board, id: string): number | undefined {
  const i = (board.route ?? []).indexOf(id);
  return i < 0 ? undefined : i + 1;
}
export const sealed = (n: ConceptNode) => n.status === "explained";

/** Every card below one card, deepest first (the order that archives a subtree without re-parenting). */
export function descendantIds(board: Board, id: string): string[] {
  return board.nodes.filter((n) => n.parentId === id).flatMap((k) => [...descendantIds(board, k.id), k.id]);
}
/** Archive (into cardArchives, restorable) everything below a card; the card itself stays. */
export function archiveBelow(board: Board, id: string, runId: string, timestamp: string, reason: string): Board {
  const edits: CanvasOperation[] = descendantIds(board, id).map((d) => ({ op: "delete", id: d, reason }));
  return edits.length ? applyCanvasEdits(board, edits, runId, timestamp) : board;
}

// ---- Route edits proposed in the post-probe chat (v2) -------------------------------------

/** Keep only ops that point at real stations; at most 4; the route keeps at least one stop. */
export function validRouteOps(board: Board, ops: RouteOp[]): RouteOp[] {
  const n = routeOf(board).length;
  const inRange = (k: number) => Number.isInteger(k) && k >= 1 && k <= n;
  const touched = new Set<number>();
  const kept: RouteOp[] = [];
  for (const op of ops) {
    if (kept.length >= 4) break;
    if (op.op === "add") {
      if (!(Number.isInteger(op.after) && op.after >= 0 && op.after <= n)) continue;
    } else {
      if (!inRange(op.stop) || touched.has(op.stop)) continue;
      if (op.op === "move" && (!inRange(op.to) || op.to === op.stop)) continue;
      touched.add(op.stop);
    }
    kept.push(op);
  }
  const removed = kept.filter((o) => o.op === "remove").length;
  const added = kept.filter((o) => o.op === "add").length;
  if (n - removed + added < 1) return kept.filter((o) => o.op !== "remove");
  return kept;
}

export type RoutePreviewRow = RouteDiffRow;

/** The new route as rows, for the inline diff (only changed rows are shown there). */
export function previewRoute(board: Board, ops: RouteOp[]): RoutePreviewRow[] {
  const stops = routeOf(board);
  type Item = { node?: ConceptNode; from?: number; title: string; row: RoutePreviewRow["kind"]; was?: string; focus?: string };
  let items: Item[] = stops.map((node, i) => ({ node, from: i + 1, title: node.title, row: "keep" }));
  const removed: Item[] = [];
  for (const op of ops) {
    if (op.op === "replace" || op.op === "focus" || op.op === "remove" || op.op === "move") {
      const item = items.find((it) => it.from === op.stop);
      if (!item) continue;
      if (op.op === "replace") Object.assign(item, { row: "replace", was: item.title, title: op.title });
      else if (op.op === "focus") Object.assign(item, { row: item.row === "keep" ? "focus" : item.row, focus: op.text });
      else if (op.op === "remove") {
        items = items.filter((it) => it !== item);
        removed.push({ ...item, row: "remove" });
      } else {
        items = items.filter((it) => it !== item);
        items.splice(Math.min(op.to - 1, items.length), 0, { ...item, row: item.row === "keep" ? "move" : item.row });
      }
    }
  }
  for (const op of ops) {
    if (op.op !== "add") continue;
    const at = op.after === 0 ? 0 : items.findIndex((it) => it.from === op.after) + 1;
    items.splice(at <= 0 && op.after !== 0 ? items.length : at, 0, { title: op.title, row: "add" });
  }
  const rows: RoutePreviewRow[] = items.map((it, i) => ({
    kind: it.row,
    from: it.from,
    to: i + 1,
    title: it.title,
    ...(it.was ? { was: it.was } : {}),
    ...(it.focus ? { focus: it.focus } : {}),
    ...(it.node && (it.row === "replace") && sealed(it.node) ? { archives: true } : {}),
    ...(it.node ? { nodeId: it.node.id } : {}),
  }));
  for (const it of removed)
    rows.push({
      kind: "remove",
      from: it.from,
      title: it.title,
      ...(it.node && sealed(it.node) ? { archives: true } : {}),
      ...(it.node ? { nodeId: it.node.id } : {}),
    });
  return rows;
}

/**
 * Apply validated route ops as one board change (the caller wraps it in one edit(), so it is one
 * undo step). New and replaced stops get a title only (待探索); their content is generated when the
 * learner starts the stop. Removing or replacing a sealed stop archives it in cardArchives.
 */
export function applyRouteOps(
  board: Board,
  ops: RouteOp[],
  runId: string,
  timestamp: string,
  newId: (i: number) => string,
): { board: Board; changed: string[] } {
  const valid = validRouteOps(board, ops);
  if (!valid.length) return { board, changed: [] };
  const root = questionNode(board);
  if (!root) return { board, changed: [] };
  const rows = previewRoute(board, valid);
  const edits: CanvasOperation[] = [];
  const ids: string[] = [];
  const changed: string[] = [];
  const archive = (id: string, reason: string) => {
    for (const d of descendantIds(board, id)) edits.push({ op: "delete", id: d, reason });
    edits.push({ op: "delete", id, reason });
  };
  let fresh = 0;
  for (const row of rows) {
    if (row.kind === "remove") {
      archive(row.nodeId!, "对话中从路线移除");
      continue;
    }
    if (row.kind === "add" || (row.kind === "replace" && row.archives)) {
      if (row.kind === "replace") archive(row.nodeId!, `对话中替换为「${row.title}」`);
      const id = newId(fresh++);
      edits.push({ op: "create", id, parentId: root.id, title: row.title, body: "" });
      ids.push(id);
      changed.push(id);
      continue;
    }
    ids.push(row.nodeId!);
    if (row.kind === "replace") {
      edits.push({ op: "update", id: row.nodeId!, title: row.title, body: "", visual: null });
      changed.push(row.nodeId!);
    } else if (row.kind !== "keep") changed.push(row.nodeId!);
  }
  let next = edits.length ? applyCanvasEdits(board, edits, runId, timestamp) : structuredClone(board);
  // Route stops sit left to right in route order; other first-level cards follow.
  const position = new Map(ids.map((id, i) => [id, i]));
  const firstLevel = next.nodes
    .filter((n) => n.parentId === root.id)
    .sort((a, b) => (position.get(a.id) ?? 1e6 + a.order) - (position.get(b.id) ?? 1e6 + b.order));
  firstLevel.forEach((n, i) => (n.order = i));
  const focus = new Map(rows.filter((r) => r.focus).map((r) => [r.nodeId, r.focus!]));
  next = {
    ...next,
    route: ids,
    nodes: next.nodes.map((n) => {
      const replaced = rows.find((r) => r.kind === "replace" && !r.archives && r.nodeId === n.id);
      let out = n;
      if (replaced) {
        const { check: _c, beat: _b, summary: _s, keyPoints: _k, whyItMatters: _w, example: _e, misconception: _m, hints: _h, overview: _o, ...rest } = n as ConceptNode & Record<string, unknown>;
        out = { ...(rest as ConceptNode), status: "unseen" };
      }
      const f = focus.get(n.id);
      return f ? { ...out, hand: `重点：${f}` } : out;
    }),
  };
  return { board: next, changed };
}
