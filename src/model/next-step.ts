/**
 * The one next step (spec §4.2), as a pure function. Rules, first hit wins:
 * 1 a stop with its four beats half done → continue that beat;
 * 3 children split off a stuck stop are unlearned → learn them first;
 * 4 the first unsealed stop in route order;
 * 6 every stop sealed → 合起来讲 (then "wrapped").
 * Before all of them: an unfinished 摸底 continues. Stops put off with 稍后 (meta.later) go last.
 * (Rule 2, spaced review, is out of scope; rule 5 is offered only when a stop missed a point.)
 */
import type { Beat, Board, ConceptNode } from "../shared/types";
import { routeOf, sealed as mastered } from "./route";

const sealed = (card: ConceptNode) => mastered(card) || card.weight === "background" && card.beat === "done";

export type NextStep =
  | { kind: "continue"; card: ConceptNode; station?: number; beat: Beat; why: string }
  | { kind: "child"; card: ConceptNode; parent: ConceptNode; station?: number; why: string }
  | { kind: "station"; card: ConceptNode; station: number; why: string }
  | { kind: "deeper"; card: ConceptNode; station: number; why: string }
  | { kind: "wrap"; why: string }
  | { kind: "wrapped"; why: string }
  | { kind: "probe"; why: string; confirm?: boolean }
  | { kind: "route"; why: string }
  | { kind: "none" };

export const BEAT_LABEL: Record<Beat, string> = {
  guess: "先猜",
  learn: "学",
  explain: "讲",
  test: "测",
  done: "已盖印",
};
export const BEATS: Beat[] = ["guess", "learn", "explain", "test"];
/** Share of the four beats done, for the card's progress line. */
export const beatProgress = (n: ConceptNode) =>
  n.status === "explained" ? 1 : n.beat ? BEATS.indexOf(n.beat as Beat) / 4 : 0;

export function nextStep(board: Board, skip: ReadonlySet<string> = new Set()): NextStep {
  if (board.probe?.status === "asking")
    return board.probe.meta?.mode === "confirm"
      ? { kind: "probe", why: "我记得你的一些基础，先确认 1–2 个点就开始。", confirm: true }
      : { kind: "probe", why: "先用约 3 道题找到你的起点，路线会从那里开始。" };
  const route = routeOf(board);
  if (!route.length)
    return board.nodes.some((n) => n.parentId !== null)
      ? { kind: "route", why: "这张地图还没有路线。要我按现有卡片排一个学习顺序吗？" }
      : { kind: "none" };
  const station = (id: string) => {
    const i = route.findIndex((n) => n.id === id);
    return i < 0 ? undefined : i + 1;
  };
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const stationFor = (n: ConceptNode): number | undefined => {
    for (let c: ConceptNode | undefined = n; c; c = c.parentId ? byId.get(c.parentId) : undefined) {
      const s = station(c.id);
      if (s) return s;
    }
    return undefined;
  };
  const unlearnedSplit = (n: ConceptNode) =>
    board.nodes.some((c) => c.parentId === n.id && !sealed(c));
  // 1. A stop in progress (not one waiting for its split children, nor one put off for later).
  const inProgress = board.nodes.find(
    (n) =>
      n.beat && n.beat !== "done" && !sealed(n) && !skip.has(n.id) && !n.meta?.later &&
      !((n.fails ?? 0) >= 2 && unlearnedSplit(n)),
  );
  if (inProgress)
    return {
      kind: "continue",
      card: inProgress,
      station: stationFor(inProgress),
      beat: inProgress.beat!,
      why: board.nodes.some((c) => c.parentId === inProgress.id && c.meta?.split)
        ? "拆出来的小问题学完了，回到这一站重新测。"
        : "这一站做到一半，接着把它走完。",
    };
  // 3. Children split off a stuck stop.
  for (const parent of board.nodes.filter((n) => (n.fails ?? 0) >= 2 && !sealed(n))) {
    const child = board.nodes
      .filter((n) => n.parentId === parent.id && !sealed(n) && !skip.has(n.id))
      .sort((a, b) => a.order - b.order)[0];
    if (child)
      return {
        kind: "child",
        card: child,
        parent,
        station: stationFor(parent),
        why: `「${parent.title}」卡住了，先学拆出来的小问题，学完回去重新测。`,
      };
  }
  // 4. The first unsealed stop.
  const open = route.filter((n) => !sealed(n));
  const pick =
    open.find((n) => !skip.has(n.id) && !n.meta?.later) ??
    open.find((n) => !skip.has(n.id)) ??
    open[0];
  if (pick) {
    const i = route.indexOf(pick);
    const prev = route.slice(0, i).filter(sealed).at(-1);
    return {
      kind: "station",
      card: pick,
      station: i + 1,
      why: prev ? `第 ${i} 站你已讲清楚；它是路线上的下一站。` : i === 0 ? "路线从这里开始。" : "它是路线上第一个还没盖印的站。",
    };
  }
  // 5. All stops sealed, but one missed a point while being explained.
  const missed = route.find((n) => n.meta?.missed && !skip.has(n.id));
  if (missed && skip.size === 0)
    return {
      kind: "deeper",
      card: missed,
      station: station(missed.id)!,
      why: `讲「${missed.title}」时漏了：${missed.meta!.missed}。值得再深一层。`,
    };
  // 6. Everything sealed.
  if (board.wrap?.done)
    return { kind: "wrapped", why: "全图讲通了。想继续，可以从任意一张卡往下长出新问题。" };
  return { kind: "wrap", why: "所有站都盖了印，回到起点问题，把它合起来讲一遍。" };
}
