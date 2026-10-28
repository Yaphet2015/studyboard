import type { Board } from "../shared/types";

/** Milliseconds, shared by the canvas and full prose. */
export const P = {
  start: 400,
  washIn: 160,
  sweep: 1100,
  swapOut: 240,
  swapInDelay: 140,
  swapIn: 360,
  hold: 440,
  washOut: 1000,
  stagger: 150,
  limit: 8,
  direct: 120,
  reducedHold: 600,
  reducedOut: 400,
} as const;
export type Sentence = { key: string; text: string };
export function sentences(text: string): Sentence[] {
  const counts = new Map<string, number>();
  return (text.match(/[^。！？.!?\n]+[。！？.!?]*|[。！？.!?]+|\n/g) ?? []).map(
    (text) => {
      const count = counts.get(text) ?? 0;
      counts.set(text, count + 1);
      return { text, key: `${text}\0${count}` };
    },
  );
}
export type SentenceChange = { old: Sentence[]; next: Sentence[] };
/** LCS retains identical sentences, including duplicates; adjacent edits form one replacement. */
export function sentenceDiff(before: string, after: string): SentenceChange[] {
  const a = sentences(before),
    b = sentences(after);
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i].text === b[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const result: SentenceChange[] = [];
  let i = 0,
    j = 0;
  const changed = () => {
    const last = result.at(-1);
    if (last && !(last.old.length === 1 && last.old[0] === last.next[0]))
      return last;
    const chunk = { old: [] as Sentence[], next: [] as Sentence[] };
    result.push(chunk);
    return chunk;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      // Use the final key even if an earlier duplicate was inserted/deleted.
      result.push({ old: [b[j]], next: [b[j]] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1]))
      changed().old.push(a[i++]);
    else changed().next.push(b[j++]);
  }
  return result.flatMap((chunk) => {
    if (chunk.old[0] === chunk.next[0]) return [chunk];
    // Each changed sentence has its own sweep trigger, even in consecutive edits.
    return Array.from(
      { length: Math.max(chunk.old.length, chunk.next.length) },
      (_, i) => ({
        old: chunk.old.slice(i, i + 1),
        next: chunk.next.slice(i, i + 1),
      }),
    );
  });
}
export type AgentEdit = {
  before: string;
  after: string;
  start: number;
  sweep: boolean;
  reduced: boolean;
  token: number;
};
export function editDuration(edit: Pick<AgentEdit, "sweep" | "reduced">) {
  return !edit.sweep
    ? P.direct
    : edit.reduced
      ? P.reducedHold + P.reducedOut
      : P.washIn + P.sweep + P.hold + P.washOut;
}
/** Only replacements of nonempty bodies on the same board are eligible. */
export function existingBodyChanges(previous: Board, next: Board) {
  if (previous.id !== next.id) return [];
  const old = new Map(previous.nodes.map((n) => [n.id, n]));
  return next.nodes.filter(
    (n) => old.get(n.id)?.body && old.get(n.id)!.body !== n.body,
  );
}
export function planAgentEdits(
  previous: Board,
  next: Board,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  agent: boolean,
  reduced: boolean,
  time: number,
): Map<string, AgentEdit> {
  if (!agent || previous.id !== next.id) return new Map();
  const old = new Map(previous.nodes.map((n) => [n.id, n]));
  const changed = existingBodyChanges(previous, next);
  changed.sort((a, b) => {
    const p = positions.get(a.id) ?? { x: 0, y: 0 },
      q = positions.get(b.id) ?? { x: 0, y: 0 };
    return p.y - q.y || p.x - q.x || a.id.localeCompare(b.id);
  });
  return new Map(
    changed.map((n, i) => [
      n.id,
      {
        before: old.get(n.id)!.body,
        after: n.body,
        start: time + (i < P.limit ? P.start + i * P.stagger : 0),
        sweep: i < P.limit,
        reduced,
        token: time,
      },
    ]),
  );
}

export const clamp = (x: number) => Math.min(1, Math.max(0, x));
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const curve = (t: number, a: number, b: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  return (x: number) => {
    x = clamp(x);
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (curve(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return curve((lo + hi) / 2, y1, y2);
  };
}
export const sweepEase = bezier(0.45, 0, 0.25, 1);
export const inEase = bezier(0.2, 0.6, 0.3, 1);
export const outEase = bezier(0.5, 0, 0.8, 0.4);
