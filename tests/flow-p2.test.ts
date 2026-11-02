import { describe, expect, it } from "vitest";
import type { Board, ConceptNode, LadderLevel, ProbeVerdict } from "../src/shared/types";
import {
  questionProblem,
  answerProbe,
  applyExpand,
  applyRefine,
  applyFrontier,
  failRecheck,
  knownClaims,
  localGrade,
  newProbe,
  nextStep as probeStep,
  parseGrade,
  parseLadder,
  parsePoints,
  probeLearner,
  probeOutcome,
  probeResult,
  restartProbe,
  skipProbe,
  MAX_QUESTIONS,
} from "../src/model/probe";
import { parseWrap, sentences } from "../src/model/wrap";
import { nextStep } from "../src/model/next-step";
import { boardSchema } from "../src/shared/validation";

const node = (id: string, title: string, parentId: string | null, order: number, extra: Partial<ConceptNode> = {}): ConceptNode => ({
  id,
  kind: "concept",
  title,
  body: "",
  parentId,
  order,
  status: "unseen",
  ...extra,
});
const board = (nodes: ConceptNode[], extra: Partial<Board> = {}): Board => ({
  version: 3,
  id: "board-p2",
  title: "重疾险",
  topic: "重疾险有哪些重要条款？",
  kind: "ai",
  createdAt: "2026-10-22T08:00:00.000Z",
  updatedAt: "2026-10-22T08:00:00.000Z",
  nodes,
  relations: [],
  notes: [],
  scene: { width: 180, color: "#E9AE7E", prediction: "", explanation: "", changed: null },
  ...extra,
});
const point = (i: number, tag = "c"): LadderLevel => ({
  level: i,
  desc: `${tag}${i}`,
  keyPoints: [`要点${tag}${i}`],
  probe: { type: "choice", q: `小李遇到情况 ${tag}${i}，会怎样？`, options: ["甲", "乙", "丙"], answer: 1 },
});
const pts = (n: number, tag = "c") => Array.from({ length: n }, (_, i) => point(i, tag));
/**
 * Simulated learner: knows every point whose desc is in `knows` (or, by default, the first `depth`
 * points of the initial chain plus every expansion point when depth = ∞). REFINE inserts `refineWith`
 * points once per pair, then says adjacent.
 */
function simulate(opts: {
  depth: number;
  idkAt?: number;
  refineWith?: number;
  verdict?: (desc: string, known: boolean) => ProbeVerdict | undefined;
}) {
  let s = newProbe(pts(5));
  let gens = 0;
  const asked: string[] = [];
  const isKnown = (p: LadderLevel) => {
    const [tag, n] = [p.desc[0], Number(p.desc.slice(1))];
    if (tag === "c") return n < opts.depth;
    if (tag === "e") return opts.depth === Infinity || 5 + n < opts.depth;
    return n < 0; // refine points: unknown
  };
  for (let guard = 0; s.status === "asking" && guard < 40; guard++) {
    const step = probeStep(s);
    if (step.kind === "ask") {
      const p = s.ladder[step.index];
      asked.push(p.desc);
      const known = isKnown(p);
      const v = opts.verdict?.(p.desc, known) ?? (opts.idkAt !== undefined && asked.length === opts.idkAt ? "unsure" : known ? "correct" : "wrong");
      s = answerProbe(s, { verdict: v, ...(step.recheck ? { recheck: true } : {}) });
    } else if (step.kind === "expand") {
      gens++;
      const base = s.ladder.filter((x) => x.desc.startsWith("e")).length;
      s = applyExpand(s, pts(4, "e").map((x, i) => ({ ...x, desc: `e${base + i}` })));
    } else if (step.kind === "refine") {
      gens++;
      const already = (s.meta?.refined ?? []).length;
      s = applyRefine(s, step.lo, step.hi, already === 0 && opts.refineWith ? pts(opts.refineWith, "r").map((x, i) => ({ ...x, desc: `r${i}` })) : [], already > 0 || !opts.refineWith);
    } else break;
  }
  return { s, asked, gens, out: probeOutcome(s) };
}

describe("摸底 v2: open-ended nested bisection", () => {
  it("a mid-level learner: brackets, confirms the edge above it, stops precise", () => {
    const { s, asked, out } = simulate({ depth: 3 });
    expect(s.status).toBe("done");
    // Precise; the edge is confirmed by the misses above it (here the chain runs out after one).
    expect(s.meta?.stopReason).toMatch(/^precise/);
    expect(out.known?.desc).toBe("c2");
    expect(out.start?.desc).toBe("c3");
    expect(out.knownList.map((p) => p.desc)).toEqual(["c0", "c1", "c2"]);
    expect(asked.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });
  it("three misses in a row confirm the edge (precise+wrong3)", () => {
    const { s, out } = simulate({ depth: 0 });
    expect(s.meta?.stopReason).toBe("precise+wrong3");
    expect(out.start?.desc).toBe("c0");
  });
  it("an expert never hits a ceiling: correct at the top expands deeper (≤3 times), capped gracefully", () => {
    const { s, out, gens } = simulate({ depth: Infinity });
    expect(s.meta?.expansions).toBeGreaterThanOrEqual(1);
    expect(s.meta?.expansions).toBeLessThanOrEqual(3);
    expect(gens).toBeLessThanOrEqual(3);
    expect(s.meta?.stopReason).toBe("cap");
    expect(out.capped).toBe(true);
    expect(out.start?.desc.startsWith("e")).toBe(true);
    expect(probeResult(s)).toContain("你懂得挺深");
    expect(s.answers.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });
  it("a learner just above the first chain: expands once, then brackets inside the new segment", () => {
    const { out, s } = simulate({ depth: 7 });
    expect(s.meta?.expansions).toBe(1);
    expect(out.known?.desc).toBe("e1");
    expect(out.start?.desc).toBe("e2");
  });
  it("refines between lo and hi when they are not adjacent, and uses the inserted points", () => {
    const { s, out } = simulate({ depth: 3, refineWith: 2 });
    expect(s.meta?.refines).toBeGreaterThanOrEqual(1);
    expect(s.ladder.map((p) => p.desc)).toContain("r0");
    // r points are unknown: the start moves down to the first inserted point.
    expect(out.start?.desc).toBe("r0");
    expect(s.ladder.every((p, i) => p.level === i)).toBe(true);
  });
  it("不了解这块 at the very start: from the basics, at most 2 follow-ups", () => {
    const { s, asked, out } = simulate({ depth: 0, idkAt: 1 });
    expect(asked.length).toBeLessThanOrEqual(3);
    expect(out.known).toBeUndefined();
    expect(out.start?.desc).toBe("c0");
    expect(probeResult(s)).toBe("我们从最基础的开始。");
  });
  it("a second 不了解 in the follow-ups ends it at once", () => {
    const { s, asked } = simulate({ depth: 2, verdict: (d) => (d === "c1" || d === "c0" ? "unsure" : undefined) });
    expect(s.meta?.stopReason).toBe("idk");
    expect(asked.length).toBeLessThanOrEqual(2);
  });
  it("部分对 counts as a miss but only half a streak", () => {
    const { s } = simulate({ depth: 3, verdict: (_d, known) => (known ? undefined : "partial") });
    expect(s.status).toBe("done");
    expect(probeOutcome(s).start?.desc).toBe("c3");
  });
  it("a contradiction (deeper correct over a shallower miss) is rechecked once; the conservative answer wins", () => {
    // Misses c1 the first time, then knows c3: c1 is rechecked; still missed → start at c1.
    const seen = new Map<string, number>();
    const { s, out } = simulate({
      depth: 4,
      verdict: (d) => {
        seen.set(d, (seen.get(d) ?? 0) + 1);
        return d === "c1" ? "wrong" : undefined;
      },
    });
    expect(s.answers.some((a) => a.recheck)).toBe(true);
    expect(seen.get("c1")).toBe(2);
    expect(out.start?.desc).toBe("c1");
  });
  it("never asks more than 10", () => {
    const { s } = simulate({ depth: Infinity, verdict: (d) => (Number(d.slice(1)) % 2 ? "partial" : undefined) });
    expect(s.answers.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });
  it("skip: by the current lo; nothing answered = from the start", () => {
    expect(skipProbe(newProbe(pts(5)))).toMatchObject({ status: "skipped", frontier: 0 });
    let s = newProbe(pts(5));
    s = answerProbe(s, { verdict: "correct" }); // asks c1 first
    expect(skipProbe(s).frontier).toBe(2);
    expect(probeResult(skipProbe(newProbe(pts(5))))).toContain("跳过也没关系");
  });
  it("重新摸底 reuses the chain and clears the answers", () => {
    const { s } = simulate({ depth: 3 });
    const again = restartProbe(s);
    expect(again.ladder).toEqual(s.ladder);
    expect(again.answers).toEqual([]);
    expect(again.status).toBe("asking");
  });
  it("the learner brief and gate claims carry known/start; nothing mentions levels", () => {
    const { s } = simulate({ depth: 3 });
    const brief = probeLearner(s);
    expect(brief).toContain("「c2」");
    expect(brief).toContain("路线从「c3」开始");
    expect(brief).toMatch(/1–2 句/);
    expect(brief).not.toMatch(/L\d/);
    expect(knownClaims({ probe: s })).toContain("要点c1");
  });
  it("grades choices locally (不了解 / wrong option / right option without reason) with no call", () => {
    const l = point(0);
    expect(localGrade(l, -1, "")).toBe("unsure");
    expect(localGrade(l, 0, "")).toBe("wrong");
    expect(localGrade(l, 1, "")).toBe("correct");
    expect(localGrade(l, 1, "因为…")).toBeNull();
    expect(parseGrade('{"verdict":"partial","missing":"x"}')).toEqual({ verdict: "partial", missing: "x" });
  });
  it("parses points with their questions; drops points without a 3-option question", () => {
    const reply = JSON.stringify({
      points: [
        { concept: "a", keyPoints: ["k"], probe: { q: "小李投保第 1 个月确诊了合同列明的重疾，去申请理赔时最可能遇到什么情况？", options: ["确诊即赔全额1", "等待期内只退保费1", "按比例先赔一半1"], answer: 0 } },
        { concept: "b", probe: { q: "小李投保第 2 个月确诊了合同列明的重疾，去申请理赔时最可能遇到什么情况？", options: ["确诊即赔全额2", "等待期内只退保费2"], answer: 0 } },
        { concept: "c", probe: { q: "小李投保第 3 个月确诊了合同列明的重疾，去申请理赔时最可能遇到什么情况？", options: ["确诊即赔全额3", "等待期内只退保费3", "按比例先赔一半3"], answer: 2 } },
        { concept: "d", probe: { q: "小李投保第 4 个月确诊了合同列明的重疾，去申请理赔时最可能遇到什么情况？", options: ["确诊即赔全额4", "等待期内只退保费4", "按比例先赔一半4"], answer: 1 } },
      ],
    });
    expect(parsePoints(reply)!.points.map((p) => p.desc)).toEqual(["a", "c", "d"]);
    expect(parseLadder(reply)!.map((p) => [p.id, p.level, p.buildsOn])).toEqual([["p0", 0, undefined], ["p1", 1, "p0"], ["p2", 2, "p1"]]);
    expect(parsePoints('{"adjacent":true,"points":[]}')).toEqual({ points: [], adjacent: true });
    expect(parseLadder("nope")).toBeNull();
  });
  it("a done v2 probe validates as board data", () => {
    const { s } = simulate({ depth: 7, refineWith: 1 });
    expect(boardSchema.parse(board([node("q", "起点", null, 0, { question: true })], { probe: s })).probe?.status).toBe("done");
  });
});

const ladder = (n = 6): LadderLevel[] => pts(n);

describe("frontier on the route", () => {
  const routed = (frontier: number) => {
    const b = board(
      [
        node("q", "起点", null, 0, { question: true }),
        node("a", "保什么", "q", 0, { meta: { level: 0 } }),
        node("b", "给付型", "q", 1, { meta: { level: 1 } }),
        node("c", "条款细读", "q", 2, { meta: { level: 3 } }),
        node("d", "取舍", "q", 3, { meta: { level: 4 }, status: "explained", seal: "test" }),
      ],
      { route: ["a", "b", "c", "d"], probe: { ...newProbe(ladder()), status: "done", frontier } },
    );
    return applyFrontier(b);
  };
  it("stations below the frontier get the light seal; the first one from the frontier is next", () => {
    const b = routed(3);
    expect(b.nodes.filter((n) => n.seal === "probe").map((n) => n.id)).toEqual(["a", "b"]);
    expect(nextStep(b)).toMatchObject({ kind: "station", station: 3 });
    expect(boardSchema.parse(b)).toBeTruthy();
  });
  it("re-probing recomputes light seals and never touches seals earned by 测", () => {
    const b = applyFrontier({ ...routed(3), probe: { ...newProbe(ladder()), status: "done", frontier: 1 } });
    expect(b.nodes.find((n) => n.id === "b")!.seal).toBeUndefined();
    expect(b.nodes.find((n) => n.id === "a")!.seal).toBe("probe");
    expect(b.nodes.find((n) => n.id === "d")!.seal).toBe("test");
    const all = applyFrontier({ ...b, probe: { ...b.probe!, frontier: 6 } });
    expect(all.nodes.find((n) => n.id === "d")!.seal).toBe("test");
  });
  it("cards with no level are spread over the ladder by route position", () => {
    const b = board(
      [node("q", "起点", null, 0, { question: true }), ...["a", "b", "c", "d"].map((id, i) => node(id, id, "q", i))],
      { route: ["a", "b", "c", "d"], probe: { ...newProbe(ladder()), status: "done", frontier: 2 } },
    );
    expect(applyFrontier(b).nodes.filter((n) => n.seal === "probe").map((n) => n.id)).toEqual(["a"]);
  });
  it("a light-sealed card that fails its recheck loses the seal and is queued after the current stop", () => {
    const b = failRecheck(routed(3), "a", "c");
    expect(b.nodes.find((n) => n.id === "a")).toMatchObject({ status: "exploring", beat: "learn" });
    expect(b.nodes.find((n) => n.id === "a")!.seal).toBeUndefined();
    expect(b.route).toEqual(["b", "c", "a", "d"]);
  });
  it("an unfinished probe is the next step", () => {
    const b = board([node("q", "起点", null, 0, { question: true })], { probe: newProbe(ladder()) });
    expect(nextStep(b).kind).toBe("probe");
  });
});

describe("合起来讲", () => {
  const sealed = () =>
    board(
      [
        node("q", "起点", null, 0, { question: true }),
        ...["a", "b", "c"].map((id, i) => node(id, id, "q", i, { status: "explained", seal: "test" })),
      ],
      { route: ["a", "b", "c"] },
    );
  it("maps the lit stations back to card ids and drops unknown ones", () => {
    expect(parseWrap(sealed(), '{"lit":["s1","s3","s9"],"pass":true,"missing":""}')).toEqual({ lit: ["a", "c"], pass: true, missing: "" });
    expect(parseWrap(sealed(), "{}")).toBeNull();
  });
  it("wrap → wrapped once it passes", () => {
    const b = sealed();
    expect(nextStep(b).kind).toBe("wrap");
    const done = { ...b, wrap: { text: "…", lit: ["a"], done: true } };
    expect(nextStep(done).kind).toBe("wrapped");
    expect(boardSchema.parse(done)).toBeTruthy();
  });
  it("counts sentences", () => {
    expect(sentences("先看保哪些病。再看保额够不够！最后看保到几岁")).toBe(3);
  });
});

describe("摸底 v2 · question quality", () => {
  const ok = "小王投保重疾险第 2 个月就确诊了合同列明的重疾，保险公司最可能怎么处理这笔理赔？";
  const opts = ["照常全额赔付，确诊即赔", "在等待期内，通常只退保费不赔", "先赔一半，剩下的过了观察期再补"];
  const reply = (q: string, options = opts) => JSON.stringify({ points: [{ concept: "等待期", keyPoints: ["k"], probe: { q, options, answer: 1 } }] });
  it("keeps a 30–80 字 scenario with real options", () => {
    expect(questionProblem(ok, opts)).toBe("");
    expect(parsePoints(reply(ok))?.points).toHaveLength(1);
  });
  it("drops depth indices from concept names", () => {
    const r = JSON.stringify({ points: [{ concept: "L3 监管口径 · 2", keyPoints: ["k"], probe: { q: ok, options: opts, answer: 1 } }] });
    expect(parsePoints(r)!.points[0].desc).toBe("监管口径");
  });
  it("rejects a template stem, a self-report stem and placeholder options", () => {
    for (const q of [
      "关于「给付型 vs 报销型」，下面哪个说法对？这是一个用来凑够三十个字的长句子而已。",
      "你了解重疾险里的等待期吗？请根据你自己的理解，选出最符合你实际情况的一项回答。",
      "等待期是什么？",
    ])
      expect(parsePoints(reply(q))?.points).toHaveLength(0);
    expect(parsePoints(reply(ok, ["给付型：说法甲", "给付型：说法乙", "给付型：说法丙"]))?.points).toHaveLength(0);
    expect(parsePoints(reply(ok, ["说法甲", "说法乙", "说法丙"]))?.points).toHaveLength(0);
  });
});
