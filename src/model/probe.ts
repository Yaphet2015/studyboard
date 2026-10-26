/**
 * 摸底 v2 (studyboard-probe/README.md, replaces §4.6): no fixed ladder. The agent keeps an internal
 * chain of concept points, shallow → deep, each building on the previous one. lo = deepest point
 * known, hi = shallowest point not known (∞ until the learner hits the top). Correct at the top →
 * EXPAND the chain deeper; bracketed but not adjacent → REFINE between lo and hi. Stops once the
 * range is precise AND the edge is confirmed (3 wrong in a row, or 不了解这块), or on skip / 10 questions.
 * Pure functions; App.tsx stores ProbeState on the board and runs the generation calls.
 * Nothing here is shown as levels or scores: the UI shows only 第 n 题 and the result.
 */
import type { Board, ConceptNode, LadderLevel, ProbeAnswer, ProbeMeta, ProbeState, ProbeVerdict } from "../shared/types";
import { profileText, type UserProfile } from "../shared/profile";
import { learnerProfile } from "./profile-context";
import { routeOf } from "./route";

export const MAX_QUESTIONS = 10;
export const MAX_EXPANSIONS = 3;
export const MAX_REFINES = 3;
export const INIT_POINTS = 5;
export const EXPAND_POINTS = 4;
/** Kept for callers of the v1 API. */
export const MAX_PROBES = MAX_QUESTIONS;
const INF = Number.POSITIVE_INFINITY;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const pointId = (p: LadderLevel) => p.id ?? `p${p.level}`;

// ── Generation prompts (small model, batched: points and their questions in one call) ──────────

const QUESTION_RULES = `每个点配一道选择题：只考这一个概念；题干 30–80 字，必须是具体情境（某人在某时遇到某事），不要写“关于 X，下面哪个说法对”；3 个选项都写出完整内容（不要“说法甲/选项A”这类占位），2 个错误选项必须是学习者真会有的常见误解、不能明显离谱；不要出是非题，不要出“你了解 X 吗”这类自评题；答案不能在题干里泄露；越深的点越可以用“为什么/会怎样”的推理题，不考记忆细节。不要编造费率、条款号；需要数字时写明“示例”。不要加“不了解”选项（界面会自动加）。`;
const POINT_JSON = `{"concept":"≤20 字的具体概念","keyPoints":["答对必须理解的 1–2 个要点"],"probe":{"q":"…","options":["…","…","…"],"answer":1}}`;

/** The first segment of the chain, or a deeper segment that builds on `from` (EXPAND). */
export function chainPrompt(topic: string, from?: LadderLevel, n = from ? EXPAND_POINTS : INIT_POINTS, avoid: string[] = [], profile: UserProfile | null = learnerProfile()): string {
  const where = from
    ? `学习者已经懂「${from.desc}」。往更深处再拟 ${n} 个概念点：第 1 个直接建立在「${from.desc}」之上，之后每个都建立在前一个之上，必须真的更深，不能换个说法重复。${avoid.length ? `已有的点（不要重复）：${avoid.slice(-12).join("；")}。` : ""}`
    : `为学习问题拟 ${n} 个由浅到深的概念点：第 1 个是日常直觉就能懂的入口，之后每个都直接建立在前一个之上；最后一个已经相当深，但不必封顶。`;
  return `学习问题：「${topic.slice(0, 300)}」
${where}
${profileText(profile)}
每个点额外输出 prior: known|shaky|none。只有画像明确支持对这个概念掌握扎实时才用 known；明确薄弱或仅可能掌握用 shaky；画像完全没有涉及的概念才用 none；画像明确说“不熟悉”的概念必须标 shaky，不能标 none。没有画像时全部 none，不要凭主题或常识猜测学习者会什么。前面连续至少 3 个 known 表示对这个主题基础很有把握，可用确认题核实。
${QUESTION_RULES}
只输出 JSON（每个点必须有 prior 字段）：{"points":[${POINT_JSON.replace('{"concept"', '{"prior":"none","concept"')}]}`;
}

/** REFINE: are lo and hi adjacent, or is there an independent concept in between? */
export function refinePrompt(topic: string, lo: LadderLevel, hi: LadderLevel): string {
  return `学习问题：「${topic.slice(0, 300)}」
学习者懂「${lo.desc}」，但还不懂「${hi.desc}」。这两点之间还有没有可以单独成卡的独立概念？
没有：输出 {"adjacent":true,"points":[]}。有：按由浅到深插入 1–3 个中间点，每个建立在前一个之上。
${QUESTION_RULES}
只输出 JSON：{"adjacent":false,"points":[${POINT_JSON}]}`;
}

/** A stem that is a template, a self-report or a bare "which is right" (README: 30–80 字情境题). */
const BAD_STEM = /下面(哪个|哪一?项|哪种)说法|以下(哪个|哪一?项)说法|哪个说法(是)?(对|正确)|你(知道|了解|熟悉|听说过|懂).{0,12}吗|是否(了解|知道)|^关于「/;
/** Placeholder or catch-all options. */
const BAD_OPTION = /^(说法|选项)\s*[甲乙丙丁一二三四A-Da-d1-4]$|[:：]\s*说法[甲乙丙丁]$|^(以上|都)(都)?(对|不对|正确|错误)|^[A-Da-d]$/;
/** Exposed for tests: why a generated question is rejected ("" = ok). */
export function questionProblem(q: string, options: string[]): string {
  const len = [...q].length;
  if (len < 30 || len > 80) return "题干要 30–80 字的具体情境";
  if (BAD_STEM.test(q)) return "题干是模板或自评题";
  if (options.length < 3) return "选项不足 3 个";
  if (options.some((o) => BAD_OPTION.test(o.trim()))) return "选项是占位符";
  if (new Set(options.map((o) => o.trim())).size !== options.length) return "选项重复";
  return "";
}

/** Parse points (with their questions). Only multiple-choice points with 3–4 options survive. */
export function parsePoints(reply: string): { points: LadderLevel[]; adjacent: boolean } | null {
  let j: any;
  try {
    j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const raw: any[] = Array.isArray(j?.points) ? j.points : Array.isArray(j?.ladder) ? j.ladder : [];
  const points: LadderLevel[] = [];
  for (const r of raw) {
    const p = r?.probe ?? {};
    // Concept names only: never keep a depth index (L3 …, … · 2) a model may echo back.
    const desc = text(r?.concept ?? r?.desc, 40).replace(/^L\d+\s*[:：.、]?\s*/, "").replace(/\s*[·・(（]\s*\d+\s*[)）]?$/, "").trim();
    const q = text(p.q, 240);
    const options: string[] = Array.isArray(p.options) ? p.options.map((o: unknown) => text(o, 120)).filter(Boolean).slice(0, 4) : [];
    if (!desc || !q || options.length < 3 || !Number.isInteger(p.answer) || p.answer < 0 || p.answer >= options.length) continue;
    if (questionProblem(q, options)) continue;
    const keyPoints: string[] = Array.isArray(r?.keyPoints) ? r.keyPoints.map((k: unknown) => text(k, 80)).filter(Boolean).slice(0, 3) : [];
    points.push({ level: 0, prior: ["known", "shaky", "none"].includes(r?.prior) ? r.prior : "none", desc, keyPoints: keyPoints.length ? keyPoints : [desc], probe: { type: "choice", q, options, answer: p.answer } });
  }
  return { points, adjacent: j?.adjacent === true };
}
/** v1 name: the initial chain (≥3 usable points), numbered. */
export function parseLadder(reply: string): LadderLevel[] | null {
  const r = parsePoints(reply);
  if (!r || r.points.length < 3) return null;
  return number(r.points.map((p, i) => ({ ...p, id: `p${i}`, ...(i ? { buildsOn: `p${i - 1}` } : {}) })));
}
const number = (chain: LadderLevel[]) => chain.map((p, i) => ({ ...p, level: i }));

/** In-memory cache keyed by topic + from, so 重新摸底 and retries reuse generated points. */
const chainCache = new Map<string, LadderLevel[]>();
export const chainKey = (topic: string, from?: LadderLevel) => `${topic}|${from ? pointId(from) + ":" + from.desc : ""}|${profileText(learnerProfile())}`;
export const cachedChain = (key: string) => chainCache.get(key);
export const cacheChain = (key: string, points: LadderLevel[]) => void chainCache.set(key, points);

// ── Grading ─────────────────────────────────────────────────────────────────────────────────────

/** Only when the learner added a reason: one short call with the point's key points (~0.3k). */
export function gradePrompt(l: LadderLevel, answer: string): string {
  return `探测题：${l.probe.q}
这个概念（${l.desc}）答对必须理解的要点：${JSON.stringify(l.keyPoints)}
学习者的回答：${JSON.stringify(answer.slice(0, 600))}
判定：说中全部要点 = correct；只说中一部分或选对但理由不对 = partial；没说中 = wrong；说不知道 = unsure。只输出 JSON：{"verdict":"correct","missing":"漏掉的要点，≤20 字"}`;
}
export function parseGrade(reply: string): { verdict: ProbeVerdict; missing: string } | null {
  try {
    const j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    if (!["correct", "partial", "wrong", "unsure"].includes(j.verdict)) return null;
    return { verdict: j.verdict, missing: String(j.missing ?? "").slice(0, 40) };
  } catch {
    return null;
  }
}
/** 不了解这块 = unsure; wrong option = wrong; right option, no reason = correct. Null: needs the AI. */
export function localGrade(l: LadderLevel, choice: number | null, reason: string): ProbeVerdict | null {
  if (choice === -1) return "unsure";
  if (l.probe.type !== "choice" || choice === null) return null;
  if (choice !== l.probe.answer) return "wrong";
  return reason.trim() ? null : "correct";
}

// ── State machine ───────────────────────────────────────────────────────────────────────────────

const freshMeta = (): ProbeMeta => ({ expansions: 0, refines: 0, refined: [], adjacent: [] });
export const knownPrefix = (chain: LadderLevel[]) => {
  const first = chain.findIndex(p => p.prior !== "known");
  return first < 0 ? chain.length : first;
};
export function newProbe(chain: LadderLevel[]): ProbeState {
  // Stable ids from the start, so refine inserts never shift what an answer points at.
  const ladder = number(chain).map((p, i) => ({ ...p, id: p.id ?? `p${i}`, ...(i && !p.buildsOn ? { buildsOn: chain[i - 1].id ?? `p${i - 1}` } : {}) }));
  return { status: "asking", ladder, answers: [], meta: { ...freshMeta(), mode: knownPrefix(ladder) >= 3 ? "confirm" : knownPrefix(ladder) > 0 ? "partial" : "full" } };
}
const metaOf = (s: ProbeState): ProbeMeta => s.meta ?? freshMeta();
const indexOf = (s: ProbeState, a: ProbeAnswer) => {
  if (a.pointId) return s.ladder.findIndex((p) => pointId(p) === a.pointId);
  return a.level < s.ladder.length ? a.level : -1;
};

/** Latest verdict per chain index (a recheck overrides the first answer). */
function verdicts(s: ProbeState): Map<number, ProbeVerdict> {
  const m = new Map<number, ProbeVerdict>();
  for (const a of s.answers) {
    const i = indexOf(s, a);
    if (i >= 0) m.set(i, a.verdict);
  }
  return m;
}
/** hi = shallowest point not answered correctly (∞ if none); lo = deepest correct point below hi. */
export function bounds(s: ProbeState): { lo: number; hi: number } {
  const v = verdicts(s);
  let hi = INF;
  for (const [i, verdict] of v) if (verdict !== "correct") hi = Math.min(hi, i);
  let lo = s.meta?.mode === "partial" ? Math.min(knownPrefix(s.ladder) - 1, hi - 1) : -1;
  for (const [i, verdict] of v) if (verdict === "correct" && i < hi) lo = Math.max(lo, i);
  return { lo, hi };
}
/** Consecutive misses at the end; 部分对 counts half. */
export function wrongStreak(s: ProbeState): number {
  let n = 0;
  for (let i = s.answers.length - 1; i >= 0; i--) {
    const v = s.answers[i].verdict;
    if (v === "correct") break;
    n += v === "partial" ? 0.5 : 1;
  }
  return n;
}
const pairKey = (s: ProbeState, lo: number, hi: number) => `${lo < 0 ? "^" : pointId(s.ladder[lo])}|${pointId(s.ladder[hi])}`;

export type ProbeStop = NonNullable<ProbeMeta["stopReason"]>;
export type ProbeStep =
  | { kind: "ask"; index: number; recheck: boolean }
  | { kind: "expand"; from: number }
  | { kind: "refine"; lo: number; hi: number }
  | { kind: "done"; reason: ProbeStop; frontier: number };

const done = (s: ProbeState, reason: ProbeStop): ProbeStep => {
  const { lo, hi } = bounds(s);
  const last = Math.max(0, s.ladder.length - 1);
  return { kind: "done", reason, frontier: hi === INF ? Math.min(lo + 1, last) : hi };
};

/** The next move. Order: stops → recheck a contradiction → expand / bisect / refine / confirm the edge. */
export function nextStep(s: ProbeState): ProbeStep {
  if (s.status === "skipped") {
    const { lo } = bounds(s);
    return { kind: "done", reason: "skip", frontier: Math.max(0, Math.min(lo + 1, s.ladder.length - 1)) };
  }
  const meta = metaOf(s);
  const asked = s.answers.length;
  if (!s.ladder.length) return { kind: "expand", from: -1 };
  if (meta.mode === "confirm") {
    const prefix = knownPrefix(s.ladder);
    const checks = [Math.max(0, prefix - 2), prefix - 1].filter((v, i, all) => all.indexOf(v) === i);
    const index = checks.find(i => !s.answers.some(a => indexOf(s, a) === i));
    if (index !== undefined) return { kind: "ask", index, recheck: false };
    return { kind: "done", reason: "precise", frontier: Math.min(prefix, s.ladder.length - 1) };
  }
  if (!asked && meta.mode === "partial") return { kind: "ask", index: Math.min(knownPrefix(s.ladder), s.ladder.length - 1), recheck: false };
  if (asked >= MAX_QUESTIONS) return done(s, "cap");
  // 不了解这块: at most 2 follow-ups inside (lo, hi); another 不了解 ends it at once.
  const firstIdk = s.answers.findIndex((a) => a.verdict === "unsure");
  const idkHit = firstIdk >= 0;
  if (idkHit) {
    const after = s.answers.slice(firstIdk + 1);
    if (after.some((a) => a.verdict === "unsure") || after.length >= 2) return done(s, "idk");
  }
  // Contradiction: a shallower miss under a deeper correct answer gets one recheck.
  const v = verdicts(s);
  const rechecked = new Set(s.answers.filter((a) => a.recheck).map((a) => indexOf(s, a)));
  for (const [i, verdict] of [...v].sort((a, b) => a[0] - b[0]))
    if (verdict !== "correct" && verdict !== "unsure" && !rechecked.has(i) && [...v].some(([j, w]) => w === "correct" && j > i))
      return { kind: "ask", index: i, recheck: true };
  const { lo, hi } = bounds(s);
  const top = s.ladder.length - 1;
  if (hi === INF) {
    if (lo >= top) return meta.expansions < MAX_EXPANSIONS ? { kind: "expand", from: top } : done(s, "cap");
    // Not capped yet: jump up (lo + 2) rather than to the middle, to find the top faster.
    return { kind: "ask", index: Math.min(lo + 2, top), recheck: false };
  }
  if (hi - lo > 1) return { kind: "ask", index: Math.floor((lo + hi) / 2), recheck: false };
  const key = pairKey(s, lo, hi);
  const triedTwice = meta.refined.filter((k) => k === key).length >= 2;
  const adjacent = lo < 0 || meta.adjacent.includes(key) || triedTwice || meta.refines >= MAX_REFINES;
  if (!adjacent) return { kind: "refine", lo, hi };
  // Precise. Stop once the edge is confirmed; otherwise ask deeper to confirm it.
  if (wrongStreak(s) >= 3) return done(s, "precise+wrong3");
  if (idkHit) return done(s, "precise+idk");
  for (let i = hi + 1; i <= top; i++) if (!v.has(i)) return { kind: "ask", index: i, recheck: false };
  return done(s, "precise");
}

/** Finalize when the machine says stop. */
export function settle(s: ProbeState): ProbeState {
  if (s.status !== "asking") return s;
  const step = nextStep(s);
  if (step.kind !== "done") return s;
  return { ...s, status: "done", frontier: step.frontier, meta: { ...metaOf(s), stopReason: step.reason } };
}

/** Record one answer to the point being asked; may finish the probe. */
export function answerProbe(s: ProbeState, answer: Omit<ProbeAnswer, "level" | "pointId"> & Partial<Pick<ProbeAnswer, "level" | "pointId">>): ProbeState {
  const step = nextStep(s);
  const index = answer.pointId ? s.ladder.findIndex((p) => pointId(p) === answer.pointId) : step.kind === "ask" ? step.index : (answer.level ?? 0);
  const point = s.ladder[index];
  const a: ProbeAnswer = { ...answer, level: index, ...(point ? { pointId: pointId(point) } : {}) };
  const meta = s.meta?.mode === "confirm" && a.verdict !== "correct" ? { ...s.meta, mode: "full" as const } : s.meta;
  return settle({ ...s, meta, answers: [...s.answers, a] });
}

/** EXPAND result: deeper points appended after the current top (or the first chain). */
export function applyExpand(s: ProbeState, points: LadderLevel[]): ProbeState {
  const meta = metaOf(s);
  const base = s.ladder.length;
  const added = points.map((p, i) => ({
    ...p,
    id: `p${base + i}`,
    ...(base + i > 0 ? { buildsOn: `p${base + i - 1}` } : {}),
  }));
  const ladder = number([...s.ladder, ...added]);
  const next: ProbeState = { ...s, ladder, meta: { ...meta, expansions: base ? meta.expansions + 1 : meta.expansions } };
  // Nothing usable came back: stop at the current top instead of looping.
  if (!added.length) return { ...next, status: "done", frontier: Math.max(0, base - 1), meta: { ...next.meta!, stopReason: "cap", expansions: MAX_EXPANSIONS } };
  return settle(next);
}

/** REFINE result: middle points spliced in before hi, or the pair marked adjacent. */
export function applyRefine(s: ProbeState, lo: number, hi: number, points: LadderLevel[], adjacent: boolean): ProbeState {
  const meta = metaOf(s);
  const key = pairKey(s, lo, hi);
  const refined = [...meta.refined, key];
  if (adjacent || !points.length)
    return settle({ ...s, meta: { ...meta, refines: meta.refines + 1, refined, adjacent: [...meta.adjacent, key] } });
  const used = new Set(s.ladder.map(pointId));
  let n = s.ladder.length;
  const fresh = points.map((p) => {
    while (used.has(`p${n}`)) n++;
    used.add(`p${n}`);
    return { ...p, id: `p${n}` };
  });
  const ladder = [...s.ladder];
  ladder.splice(hi, 0, ...fresh);
  return settle({ ...s, ladder: number(ladder), meta: { ...meta, refines: meta.refines + 1, refined } });
}

export function skipProbe(s: ProbeState | undefined): ProbeState {
  const base: ProbeState = { status: "skipped", ladder: s?.ladder ?? [], answers: s?.answers ?? [], meta: { ...(s ? metaOf(s) : freshMeta()), stopReason: "skip" } };
  const step = nextStep(base);
  return { ...base, frontier: step.kind === "done" ? step.frontier : 0 };
}
/** 重新摸底: the same (cached) chain, answers cleared. */
export const restartProbe = (s: ProbeState): ProbeState => newProbe(s.ladder);

// ── Result ──────────────────────────────────────────────────────────────────────────────────────

export interface ProbeOutcome {
  /** The deepest known point, if any. */
  known?: LadderLevel;
  /** Points the learner already knows (the route skips them), shallow → deep. */
  knownList: LadderLevel[];
  start?: LadderLevel;
  questions: number;
  capped: boolean;
  skipped: boolean;
}
export function probeOutcome(s: ProbeState): ProbeOutcome {
  const f = Math.max(0, Math.min(s.frontier ?? 0, s.ladder.length - 1));
  const knownList = s.status === "skipped" && !s.answers.length ? [] : s.ladder.slice(0, f);
  const capped = s.meta?.stopReason === "cap" && bounds(s).hi === INF;
  return {
    known: knownList.at(-1),
    knownList: capped ? s.ladder.slice(0, f + 1).slice(0, -1) : knownList,
    start: s.ladder[f],
    questions: s.answers.length,
    capped,
    skipped: s.status === "skipped",
  };
}

/** Result copy (README §5 / §8). */
export function probeResult(s: ProbeState, _stations = 0): string {
  const o = probeOutcome(s);
  if (o.skipped && !o.questions) return "跳过也没关系，我会从最基础的开始排。";
  if (o.capped) return "你懂得挺深，先从这里开始，后面随时可以往下钻。";
  if (!o.known) return "我们从最基础的开始。";
  return `你已经懂到「${o.known.desc}」。从「${o.start?.desc ?? ""}」开始，正好在你会的上面一层。`;
}

/** Board-local results used by generation; global prose is added separately. */
function localLearner(s: ProbeState): string {
  if (s.status === "asking") return "";
  // Skipped before the first chain arrived still counts as a skip.
  if (s.status === "skipped" && !s.answers.length) return "学习者跳过了摸底，按初学者处理，从最基础的开始。";
  if (!s.ladder.length) return "";
  const o = probeOutcome(s);
  const known = o.knownList.length ? `学习者已经懂：${o.knownList.map((p) => `「${p.desc}」`).join("、")}。` : "学习者还没有确认会的概念。";
  const start = o.start ? `路线从「${o.start.desc}」开始` : "";
  return `摸底结果：${known}${start}。已懂的内容不单独成卡、不重复解释，只在根卡或第一站开头用 1–2 句“你已经知道……”带过；需要前置知识时只用一句话提一下。讲法、举例和用词按这个深度来。`;
}
/** Local results first, with the global profile supplementing the teaching style. */
export function probeLearner(s: ProbeState, profile: UserProfile | null = learnerProfile()): string {
  return [localLearner(s), profileText(profile)].filter(Boolean).join("\n");
}
export const probeBrief = (board: Pick<Board, "probe">, profile: UserProfile | null = learnerProfile()) =>
  board.probe ? probeLearner(board.probe, profile) : profileText(profile);
/** Known points as text, for the gate's duplicate check. */
export const knownClaims = (board: Pick<Board, "probe">): string[] =>
  board.probe && board.probe.status !== "asking" ? probeOutcome(board.probe).knownList.flatMap((p) => [p.desc, ...p.keyPoints]) : [];

// ── Route mapping (unchanged shape: a card's meta.level is a chain index) ─────────────────────────

/** The chain index of each station: the card's own level, else spread over the chain by route position. */
export function stationLevels(board: Board): Map<string, number> {
  const route = routeOf(board).map((c) => c.id);
  const n = board.probe?.ladder.length || 6;
  const out = new Map<string, number>();
  route.forEach((id, i) => {
    const card = board.nodes.find((c) => c.id === id);
    const own = card?.meta?.level;
    out.set(id, own !== undefined ? Math.min(n - 1, Math.max(0, own)) : route.length <= 1 ? 0 : Math.round((i * (n - 1)) / (route.length - 1)));
  });
  return out;
}

/**
 * Cards before the start get the light A seal (route skips them). Re-probing recomputes: earlier
 * probe seals are cleared first; seals earned by 测 are never touched.
 */
export function applyFrontier(board: Board): Board {
  const probe = board.probe;
  if (!probe || probe.status === "asking") return board;
  const f = probe.frontier ?? 0;
  const levels = stationLevels(board);
  const nodes = board.nodes.map((n): ConceptNode => {
    if (n.seal === "test") return n;
    const level = levels.get(n.id);
    const below = level !== undefined && level < f;
    if (below) return { ...n, seal: "probe", status: "explained", beat: "done" };
    if (n.seal === "probe") {
      const { seal: _s, ...rest } = n;
      return { ...rest, status: "exploring", beat: "test" };
    }
    return n;
  });
  return { ...board, nodes };
}

/** A light-sealed card failed its recheck: drop the seal and move it right after the current stop. */
export function failRecheck(board: Board, id: string, currentId?: string): Board {
  const nodes = board.nodes.map((n): ConceptNode => {
    if (n.id !== id) return n;
    const { seal: _s, ...rest } = n;
    return { ...rest, status: "exploring", beat: "learn", fails: 0 };
  });
  const route = routeOf(board).map((c) => c.id).filter((r) => r !== id);
  const at = currentId ? route.indexOf(currentId) : -1;
  route.splice(at + 1, 0, id);
  return { ...board, nodes, route };
}
