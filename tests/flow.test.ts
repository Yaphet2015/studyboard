import { describe, expect, it } from "vitest";
import type { Board, ConceptNode } from "../src/shared/types";
import { cheapGate, clearJudgeCache, evasionRisk, runGate, similarity, type RawCard } from "../src/model/novelty";
import { applyGate } from "../src/model/gate";
import { nextStep } from "../src/model/next-step";
import { defaultRoute } from "../src/model/route";
import { localMark, parseMark } from "../src/model/mark";
import { publicBoard, transferMarkdown } from "../src/shared/transfer";
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
  id: "board-f",
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
const insurance = () =>
  board([
    node("q", "重疾险有哪些重要条款？", null, 0, { question: true }),
    node("pay", "赔多少、赔多久", "q", 0, {
      body: "重疾险确诊后赔一笔钱，保额和保障期决定赔多少、保多久。",
      meta: { gate: { claims: ["重疾险确诊后一次性赔一笔钱", "保额和保障期决定赔付"] } },
    }),
  ]);
const GOOD: RawCard = {
  id: "gap",
  parent: "anchor",
  title: "保额该按收入缺口算，而不是按医药费",
  body: "重疾险是确诊就一次性给一笔钱，跟实际花了多少医药费无关——医药费本来有医保和医疗险报销。所以这笔钱要补的是停工丢掉的收入：比如年收入 20 万、休养 3 年（示例），缺口约 60 万。",
  newIdea: "重疾险给付用来补停工期间的收入缺口",
  substance: [
    { kind: "mechanism", text: "医药费本来有医保和医疗险报销" },
    { kind: "example", text: "年收入 20 万、休养 3 年，缺口约 60 万", isExample: true },
  ],
  addsBeyond: "父卡讲赔一笔钱，这张讲这笔钱该怎么算",
  claims: ["保额应按收入缺口估算", "给付与实际医疗花费无关"],
  check: {
    q: "小陈是自由职业者，收入不稳定，但医疗险很全。她该少买还是多买保额？说出理由。",
    keyPoints: ["医疗险不能替代收入补偿"],
  },
};

describe("new-knowledge gate: cheap checks (no LLM)", () => {
  it("rejects advice to evade disclosure, tax or legal duties; soft phrasing goes to the judge", () => {
    const tail = "（示例）比如年收入 20 万。";
    const strong = { ...GOOD, body: "等待期内体检要小心，稳妥做法是把非紧急体检挪到等待期后，避免留下争议记录。" + tail };
    const v = cheapGate(strong, insurance(), "pay");
    expect(v.kind).toBe("reject");
    expect(v.kind === "reject" && v.reasons.join()).toMatch(/规避如实告知/);
    expect(cheapGate({ ...GOOD, title: "小毛病可以隐瞒不报" }, insurance(), "pay").kind).toBe("reject");
    // Soft phrasing in an insurance topic: borderline, not silently accepted.
    const soft = { ...GOOD, body: GOOD.body + "有人会把体检推迟到投保之后。" };
    expect(cheapGate(soft, insurance(), "pay").kind).toBe("borderline");
    expect(evasionRisk("把复查推迟到下周", "怎么学好钢琴")).toBeNull();
    // Explaining what does not count as concealment is legitimate: judged, not rejected.
    expect(evasionRisk("问卷外的情况不构成隐瞒。", "重疾险")).toBe("borderline");
    // Explaining the duty itself is fine.
    expect(evasionRisk("投保前必须如实告知体检异常，否则保险公司可以拒赔。", "重疾险")).toBeNull();
    expect(cheapGate(GOOD, insurance(), "pay").kind).toBe("accept");
  });
  it("accepts a good, deep card", () => {
    expect(cheapGate(GOOD, insurance(), "pay").kind).toBe("accept");
  });
  it("rejects a card that restates its parent", () => {
    const v = cheapGate(
      { ...GOOD, title: "赔多少、赔多久很关键", claims: ["重疾险确诊后一次性赔一笔钱"] },
      insurance(),
      "pay",
    );
    expect(v.kind).toBe("reject");
    expect(v.kind === "reject" && v.reasons.join()).toMatch(/复述父卡/);
  });
  it("rejects filler, labelled sections, missing fields and a restating check", () => {
    const b = insurance();
    const why = (c: Partial<RawCard>) => {
      const v = cheapGate({ ...GOOD, ...c } as RawCard, b, "pay");
      return v.kind === "reject" ? v.reasons.join("|") : v.kind;
    };
    expect(why({ body: GOOD.body + "保额很重要，要综合考虑。" })).toMatch(/空话/);
    expect(why({ body: "新知识点：可以赔多次\n机制：分组\n例子：癌症" })).toMatch(/分栏标签/);
    expect(why({ addsBeyond: undefined })).toMatch(/缺少 addsBeyond/);
    expect(why({ check: { q: "什么是给付型？" } })).toMatch(/检查题/);
    expect(why({ substance: [{ kind: "definition", text: "重疾险是确诊就一次性给一笔钱" }] })).toMatch(/只有定义/);
    expect(why({ substance: [{ kind: "number", text: "年收入 20 万" }] })).toMatch(/数字没有标注/);
  });
  it("has no depth limit: an expert card that is clear passes", () => {
    const expert: RawCard = {
      ...GOOD,
      id: "old-def",
      title: "新版定义只约束新保单，老保单可选择更有利的",
      body: "疾病定义规范更新后，按旧定义签的保单并不会被自动改写；理赔时通常按合同签订时的定义执行，部分产品还允许择优适用新定义。所以比较新旧保单时，要逐条看病种定义的措辞差异，而不是只看病种数量。",
      newIdea: "定义更新不追溯老保单",
      substance: [{ kind: "distinction", text: "按合同签订时的定义执行，部分产品允许择优适用新定义" }],
      claims: ["疾病定义更新不追溯已签保单", "部分产品允许择优适用新定义"],
      check: { q: "老周 2018 年投保，2022 年确诊的疾病按新定义更容易理赔。他能用新定义吗？", keyPoints: ["看合同是否允许择优"] },
    };
    expect(cheapGate(expert, insurance(), "pay").kind).toBe("accept");
  });
  it("merges a card that repeats another card on the board", () => {
    const b = insurance();
    b.nodes.push(node("other", "等待期", "q", 1, { meta: { gate: { claims: ["等待期内确诊通常不赔或退还保费"] } } }));
    const v = cheapGate({ ...GOOD, claims: ["等待期内确诊通常不赔或退还保费"] }, b, "pay");
    expect(v).toMatchObject({ kind: "merge", into: "other" });
  });
  it("similarity is bigram Jaccard", () => {
    expect(similarity("保额应按收入缺口估算", "保额应按收入缺口估算")).toBe(1);
    expect(similarity("保额应按收入缺口估算", "等待期内确诊不赔")).toBeLessThan(0.1);
  });
});

describe("new-knowledge gate: the full pipeline", () => {
  it("good cards need no LLM call; a restating card is regenerated at most once", async () => {
    clearJudgeCache();
    const calls: string[] = [];
    const bad = { ...GOOD, id: "bad", title: "保额的重要性", body: "保额很重要，要根据自身情况选择。", claims: ["保额很重要"] };
    const out = await runGate(
      JSON.stringify({ nodes: [GOOD, bad], relations: [] }),
      insurance(),
      "pay",
      async (mode) => {
        calls.push(mode);
        return JSON.stringify({ nodes: [{ ...bad, title: "还是保额的重要性" }] });
      },
      "base",
    );
    expect(calls).toEqual(["regen"]);
    expect(out.kept.map((k) => k.card.id)).toEqual(["gap"]);
    expect(out.dropped.map((d) => d.card.id)).toEqual(["bad"]);
    expect(out.calls).toEqual({ regen: 1, judge: 0 });
  });
  it("regenAny regenerates a rejected card even when most of the batch passed", async () => {
    clearJudgeCache();
    const second: RawCard = {
      ...GOOD,
      id: "wait",
      title: "等待期内确诊通常只退保费",
      body: "合同生效后有一段等待期，这期间确诊通常只退保费不赔保额，它防的是带病投保。",
      newIdea: "等待期防带病投保",
      substance: [{ kind: "mechanism", text: "这期间确诊通常只退保费不赔保额" }],
      claims: ["等待期内确诊通常只退保费"],
      check: { q: "小赵投保第二个月查出合同列明的病，最可能卡在哪一条？", keyPoints: ["等待期"] },
    };
    const bad = { ...GOOD, id: "bad", title: "保额的重要性", body: "保额很重要，要根据自身情况选择。", claims: ["保额很重要"] };
    const redone: RawCard = {
      ...second,
      id: "bad",
      title: "免责条款之外的出险照常赔",
      body: "免责条款只列出合同不赔的情形，比如故意自伤，这些情形之外的出险照常赔付。",
      newIdea: "免责条款有边界",
      substance: [{ kind: "mechanism", text: "免责条款只列出合同不赔的情形" }],
      claims: ["免责条款只覆盖列明的情形"],
      check: { q: "小周因为一种合同没写免责的意外受伤，保险公司能直接拒赔吗？", keyPoints: ["免责只限列明情形"] },
    };
    const text = JSON.stringify({ nodes: [GOOD, second, bad] });
    const plain: string[] = [];
    const base = await runGate(text, insurance(), "pay", async (m) => (plain.push(m), JSON.stringify({ nodes: [redone] })), "base");
    expect(plain).toEqual([]);
    expect(base.kept.map((k) => k.card.id)).toEqual(["gap", "wait"]);
    const asked: string[] = [];
    const all = await runGate(text, insurance(), "pay", async (m) => (asked.push(m), JSON.stringify({ nodes: [redone] })), "base", { regenAny: true });
    expect(asked).toEqual(["regen"]);
    expect(all.kept.map((k) => k.card.id).sort()).toEqual(["bad", "gap", "wait"]);
  });
  it("borderline cards go to ONE batched judge call, and verdicts are cached", async () => {
    clearJudgeCache();
    const b = insurance();
    const near1 = { ...GOOD, id: "n1", claims: ["确诊后一次性赔一笔钱，按停工收入缺口估算"] };
    const near2 = { ...GOOD, id: "n2", title: "保障期决定保到哪个年龄段", claims: ["保额和保障期决定晚年的赔付额度"], check: { q: "老李 65 岁时确诊，保到 60 岁的保单赔吗？", keyPoints: ["过了保障期不赔"] } };
    const judged: string[] = [];
    const ask = async (mode: string, prompt: string) => {
      judged.push(mode);
      const ids = [...prompt.matchAll(/"id":"([^"]+)","card"/g)].map((m) => m[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, adds: "讲了怎么算", pass: id === "n1" })) });
    };
    const text = JSON.stringify({ nodes: [near1, near2] });
    const first = await runGate(text, b, "pay", ask, "base");
    expect(judged).toEqual(["gate"]);
    expect(first.kept.map((k) => [k.card.id, k.meta.decidedBy])).toEqual([["n1", "judge"]]);
    const again = await runGate(text, b, "pay", ask, "base");
    expect(judged).toEqual(["gate"]);
    expect(again.kept.map((k) => k.card.id)).toEqual(["n1"]);
  });
  it("kept cards land with check.q visible and gate data only in meta.gate", async () => {
    clearJudgeCache();
    const b = insurance();
    const out = await runGate(JSON.stringify({ nodes: [GOOD] }), b, "pay", async () => "{}", "base");
    const { board: next, added } = applyGate(b, "pay", out, "expand");
    const card = next.nodes.find((n) => n.id === added[0])!;
    expect(card.check).toEqual({ q: GOOD.check!.q });
    expect(card.meta?.gate?.addsBeyond).toBe(GOOD.addsBeyond);
    expect(card.meta?.check?.keyPoints).toEqual(["医疗险不能替代收入补偿"]);
    expect(Object.keys(card)).not.toContain("addsBeyond");
    expect(() => boardSchema.parse(next)).not.toThrow();
  });
});

describe("internal gate fields never leave the app", () => {
  it("export (JSON and Markdown) excludes meta.gate and check key points", async () => {
    clearJudgeCache();
    const b = insurance();
    const out = await runGate(JSON.stringify({ nodes: [GOOD] }), b, "pay", async () => "{}", "base");
    const next = applyGate(b, "pay", out, "expand").board;
    const transfer = { format: "studyboard" as const, version: 1 as const, exportedAt: "2026-10-22T08:00:00.000Z", board: publicBoard(next), conversations: [] };
    const json = JSON.stringify(transfer);
    const md = transferMarkdown(transfer);
    for (const secret of [GOOD.addsBeyond!, GOOD.claims![0], GOOD.newIdea!, "医疗险不能替代收入补偿", "simParent", "addsBeyond", "claims", "decidedBy"]) {
      expect(json).not.toContain(secret);
      expect(md).not.toContain(secret);
    }
    expect(md).toContain(GOOD.check!.q);
    expect(md).toContain("保额该按收入缺口算");
  });
});

describe("next step", () => {
  const routed = () => {
    const b = board([
      node("q", "起点", null, 0, { question: true }),
      node("a", "保什么病", "q", 0, { status: "explained", seal: "test" }),
      node("b", "赔多少", "q", 1),
      node("c", "什么时候不赔", "q", 2),
    ]);
    return { ...b, route: defaultRoute(b) };
  };
  it("old maps without a route are offered one", () => {
    const b = routed();
    expect(nextStep({ ...b, route: undefined }).kind).toBe("route");
    expect(defaultRoute(b)).toEqual(["a", "b", "c"]);
  });
  it("rule 4: the first unsealed stop, with the reason", () => {
    const s = nextStep(routed());
    expect(s).toMatchObject({ kind: "station", station: 2 });
    expect("why" in s && s.why).toContain("第 1 站你已讲清楚");
  });
  it("rule 1: a half-done stop wins; 换一个 skips it", () => {
    const b = routed();
    b.nodes[3] = { ...b.nodes[3], beat: "explain" };
    expect(nextStep(b)).toMatchObject({ kind: "continue", beat: "explain" });
    expect(nextStep(b, new Set(["c"]))).toMatchObject({ kind: "station", station: 2 });
  });
  it("rule 3: children of a stuck stop come first", () => {
    const b = routed();
    b.nodes[2] = { ...b.nodes[2], fails: 2 };
    b.nodes.push(node("b1", "小问题", "b", 0));
    expect(nextStep(b)).toMatchObject({ kind: "child", parent: { id: "b" }, station: 2 });
  });
  it("rule 6: all sealed → 合起来讲", () => {
    const b = routed();
    b.nodes = b.nodes.map((n) => (n.parentId ? { ...n, status: "explained" as const } : n));
    expect(nextStep(b).kind).toBe("wrap");
  });
});

describe("check marking", () => {
  const card = node("x", "t", "q", 0, { check: { q: "?", options: ["甲", "乙", "丙"] }, meta: { check: { keyPoints: ["k"], answer: 1 } } });
  it("a wrong option or 不知道 fails locally, with no call", () => {
    expect(localMark(card, 0, "因为")).toEqual({ pass: false, missing: "选项不对" });
    expect(localMark(card, -1, "")).toMatchObject({ pass: false });
    expect(localMark(card, 1, "")).toMatchObject({ pass: false, missing: "还差一句理由" });
  });
  it("a right option with a reason, or free text, needs one short call", () => {
    expect(localMark(card, 1, "因为它按确诊给钱")).toBeNull();
    expect(localMark(node("y", "t", "q", 0), null, "回答")).toBeNull();
    expect(parseMark('{"pass":true,"missing":""}')).toEqual({ pass: true, missing: "" });
    expect(parseMark("oops")).toBeNull();
  });
});
