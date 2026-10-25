/**
 * The new-knowledge gate (spec §4.7): every generated card must bring a real new point.
 * Cheap local checks run first (schema, filler phrases, prose/label shape, bigram similarity);
 * only borderline cards go to the LLM rubric judge, batched per expansion.
 * Gate data (newIdea, substance, addsBeyond, claims, scores) is stored in node.meta.gate and is
 * never rendered or exported.
 */
import { knownClaims, probeBrief } from "./probe";
import type { Board, ConceptNode, GateMeta, GateSubstance } from "../shared/types";

/** A generated card as the model sends it, before it reaches the board. */
export interface RawCard {
  id: string;
  title: string;
  body: string;
  parent?: string | null;
  newIdea?: string;
  substance?: GateSubstance[];
  addsBeyond?: string;
  claims?: string[];
  check?: { q?: string; options?: string[]; answer?: number; keyPoints?: string[] };
  [key: string]: unknown;
}

export type Verdict =
  | { kind: "accept"; simParent: number; simMax: number }
  | { kind: "reject"; reasons: string[]; simParent: number; simMax: number }
  | { kind: "merge"; into: string; sim: number }
  | { kind: "borderline"; against: string; sim: number; simParent: number; simMax: number };

export const FILLER = [
  "很重要",
  "非常重要",
  "至关重要",
  "综合考虑",
  "因人而异",
  "根据自身情况",
  "视情况而定",
  "概述",
  "简介",
  "基本概念",
  "总的来说",
  "值得注意的是",
];
/** Section labels that turn a body into a form instead of prose. */
const LABEL = /(^|\n)\s*(新知识点|知识点|机制|原理|例子|具体例子|示例|要点|总结|定义|硬货|增量)\s*[:：]/;
const DEFINITION_KINDS = new Set(["definition", "定义"]);
export const REJECT_PARENT = 0.6;
export const MERGE_BOARD = 0.75;
export const BORDER_LOW = 0.4;
const MAX_BODY_CHARS = 220;
const MAX_SENTENCES = 5;

const norm = (s: string) =>
  s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function bigrams(s: string): Set<string> {
  const t = [...norm(s)];
  const out = new Set<string>();
  if (t.length === 1) out.add(t[0]);
  for (let i = 0; i + 1 < t.length; i++) out.add(t[i] + t[i + 1]);
  return out;
}
/** Character-bigram Jaccard similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}
/** Share of a's bigrams that also occur in b (is a "in" b?). */
export function containment(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / x.size;
}
const maxPair = (a: string[], b: string[]) =>
  Math.max(0, ...a.flatMap((x) => b.map((y) => similarity(x, y))));

/** A card's claims: its gate claims, else its title and first sentence (older cards). */
export function claimsOf(n: Pick<ConceptNode, "title" | "body" | "meta">): string[] {
  const c = n.meta?.gate?.claims;
  if (c?.length) return c;
  const first = n.body.split(/[。！？!?\n]/)[0] ?? "";
  return [n.title, first].filter((s) => s.trim());
}
const sentences = (s: string) =>
  s.split(/[。！？!?]+/).filter((x) => x.trim().length > 1).length;

/**
 * Advice to evade a disclosure, tax or legal duty. STRONG phrasing is rejected outright; SOFT
 * phrasing in a finance / insurance / legal topic is sent to the batched judge (borderline).
 */
const EVASION_STRONG =
  /(可以|建议|最好|干脆|偷偷|先)隐瞒|隐瞒(不报|下来|过去)|瞒报|不如实告知|不用告知|不必告知|别告知|逃税|偷税|漏税|骗保|规避(健康)?告知|绕过核保|(避免|以免|免得|不要)留下[^。]{0,8}(记录|病历|证据)/;
const EVASION_SOFT =
  /(推迟|延后|挪到|等到|拖到)[^。]{0,12}(体检|就诊|检查|复查|看病)|(体检|就诊|复查)[^。]{0,8}(挪到|推迟|延后|等到)|少报|不申报|不报税|避开[^。]{0,6}(告知|核保|申报|税)|争议记录|不留记录|隐瞒/;
const DUTY_TOPIC = /保险|重疾|医疗险|寿险|意外险|车险|保单|投保|核保|理赔|税|报税|法律|合同|贷款|理财|投资|社保|公积金|报销|征信/;
export function evasionRisk(text: string, topic: string): "reject" | "borderline" | null {
  if (EVASION_STRONG.test(text)) return "reject";
  if (EVASION_SOFT.test(text) && DUTY_TOPIC.test(`${topic}${text}`)) return "borderline";
  return null;
}

/** Local checks only; no LLM call. */
export function cheapGate(
  card: RawCard,
  board: Board,
  parentId: string | null,
  siblings: RawCard[] = [],
): Verdict {
  const reasons: string[] = [];
  const body = String(card.body ?? "");
  const title = String(card.title ?? "");
  // 1. Schema.
  for (const f of ["title", "body", "newIdea", "addsBeyond"] as const)
    if (!String(card[f] ?? "").trim()) reasons.push(`缺少 ${f}`);
  if (!Array.isArray(card.substance) || !card.substance.length) reasons.push("缺少 substance");
  if (!card.check?.q?.trim()) reasons.push("缺少检查题");
  if (!card.claims?.length) reasons.push("缺少 claims");
  // 2. Prose, not a form.
  if (LABEL.test(body)) reasons.push("正文用了分栏标签，要改写成一段自然的话");
  if ([...body].length > MAX_BODY_CHARS || sentences(body) > MAX_SENTENCES)
    reasons.push("正文太长，压缩到 2–4 句");
  // 3. Filler and definition-only.
  const hit = FILLER.filter((w) => title.includes(w) || body.includes(w));
  if (hit.length) reasons.push(`空话：${hit.join("、")}`);
  const subs = Array.isArray(card.substance) ? card.substance : [];
  if (subs.length && subs.every((s) => DEFINITION_KINDS.has(String(s.kind))))
    reasons.push("只有定义，没有机制或例子");
  let ambiguous = false;
  for (const s of subs) {
    const c = containment(String(s.text ?? ""), body);
    if (c < 0.2) reasons.push(`硬货没写进正文：${String(s.text).slice(0, 20)}`);
    else if (c < 0.35) ambiguous = true;
    if (/\d/.test(String(s.text)) && !s.isExample && !s.source)
      reasons.push("数字没有标注示例或来源");
  }
  if (/\d/.test(body) && subs.some((s) => /\d/.test(String(s.text)) && s.isExample) && !/比如|例如|示例|假设|举例/.test(body))
    reasons.push("正文里的示例数字旁要写明“比如/示例”");
  // 5. The check question must use a new situation.
  // A clear restatement is rejected; a check that merely shares wording with the body is left to the judge.
  const q = card.check?.q ?? "";
  const qOverlap = q ? containment(q, body) : 0;
  if (q && (qOverlap >= 0.7 || /是什么[？?]?$|重要吗[？?]?$|^什么是/.test(q.trim())))
    reasons.push("检查题在复述正文，要换成新情境");
  else if (qOverlap >= 0.5) ambiguous = true;
  // 6. Never advise evading disclosure, tax or legal duties.
  const risk = evasionRisk(`${title}${body}${q}${(card.check?.options ?? []).join("")}`, board.topic);
  if (risk === "reject") reasons.push("建议规避如实告知、纳税或法律义务");
  else if (risk === "borderline") ambiguous = true;
  const answer = card.check?.options?.[card.check.answer ?? -1];
  if (answer && answer.length >= 6 && norm(body).includes(norm(answer)))
    reasons.push("检查题答案能在正文里直接找到");
  // 4. Similarity against the parent, siblings and the whole board.
  const mine = card.claims?.length ? card.claims.map(String) : [title];
  const parent = board.nodes.find((n) => n.id === parentId);
  const simParent = parent ? maxPair(mine, claimsOf(parent)) : 0;
  let simMax = 0;
  let nearest = "";
  for (const n of board.nodes) {
    if (n.parentId === null) continue;
    const s = maxPair(mine, claimsOf(n));
    if (s > simMax) [simMax, nearest] = [s, n.id];
  }
  const sib = Math.max(0, ...siblings.filter((x) => x !== card).map((x) => maxPair(mine, x.claims?.length ? x.claims : [x.title])));
  const r = (v: number) => +v.toFixed(3);
  if (simParent >= REJECT_PARENT) reasons.push("复述父卡");
  if (sib >= REJECT_PARENT) reasons.push("和同批兄弟卡重复");
  // 7. The learner already knows this (摸底): a card that re-teaches a known point is not new to them.
  const known = knownClaims(board);
  if (known.length && maxPair(mine, known) >= REJECT_PARENT) reasons.push("讲的是学习者摸底时已经懂的内容");
  if (reasons.length) return { kind: "reject", reasons, simParent: r(simParent), simMax: r(simMax) };
  if (simMax >= MERGE_BOARD && nearest && nearest !== parentId) return { kind: "merge", into: nearest, sim: r(simMax) };
  const border = Math.max(simParent, simMax, sib);
  if (border >= BORDER_LOW || ambiguous)
    return {
      kind: "borderline",
      against: simParent >= simMax ? (parentId ?? nearest) : nearest,
      sim: r(border),
      simParent: r(simParent),
      simMax: r(simMax),
    };
  return { kind: "accept", simParent: r(simParent), simMax: r(simMax) };
}

/** The gate data a kept card stores in node.meta.gate. */
export function gateMeta(card: RawCard, v: Verdict, extra: Partial<GateMeta> = {}): GateMeta {
  return {
    newIdea: card.newIdea ? String(card.newIdea).slice(0, 200) : undefined,
    substance: card.substance?.slice(0, 8).map((s) => ({
      kind: String(s.kind ?? "").slice(0, 40),
      text: String(s.text ?? "").slice(0, 400),
      ...(s.isExample ? { isExample: true } : {}),
      ...(s.source ? { source: String(s.source).slice(0, 400) } : {}),
    })),
    addsBeyond: card.addsBeyond ? String(card.addsBeyond).slice(0, 400) : undefined,
    claims: card.claims?.slice(0, 6).map((c) => String(c).slice(0, 200)),
    ...("simParent" in v ? { simParent: v.simParent, simMax: v.simMax } : {}),
    decidedBy: "cheap",
    ...extra,
  };
}

/** One batched rubric-judge prompt for all borderline cards of one expansion. */
export function judgePrompt(board: Board, items: { card: RawCard; against: string }[]): string {
  const title = (id: string) => board.nodes.find((n) => n.id === id);
  const rows = items.map(({ card, against }) => {
    const x = title(against);
    return {
      id: card.id,
      card: { title: card.title, body: card.body, claims: card.claims, check: card.check?.q },
      compareWith: x ? { title: x.title, claims: claimsOf(x) } : null,
    };
  });
  return `判断每张候选卡片相对“比较对象”是否带来具体的新知识。adds 写出它比比较对象多了什么（一句话，≤30 字；说不出具体差异就留空）。若卡片建议规避如实告知、纳税或法律义务（如推迟体检以免留下记录），pass 必须为 false。pass 为 true 仅当 adds 具体、正文不是空话或复述，并且检查题 check 把知识点用到了正文没写过的新情境（只是换词复述正文则不通过）。不因内容深、难而扣分。
只输出 JSON：{"verdicts":[{"id":"…","adds":"…","pass":true}]}
候选：${JSON.stringify(rows)}`;
}
export function parseJudge(text: string): Map<string, { pass: boolean; adds: string }> {
  const out = new Map<string, { pass: boolean; adds: string }>();
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    for (const v of j.verdicts ?? [])
      if (v && typeof v.id === "string")
        out.set(v.id, { pass: v.pass === true && !!String(v.adds ?? "").trim(), adds: String(v.adds ?? "").slice(0, 400) });
  } catch {
    /* An unreadable verdict counts as no verdict: the card is dropped. */
  }
  return out;
}

/** Cached judge verdicts, keyed by card content and comparison target. */
const judgeCache = new Map<string, { pass: boolean; adds: string }>();
export const judgeKey = (card: RawCard, against: string) =>
  `${against}|${norm(card.title)}|${norm(String(card.body)).slice(0, 200)}`;

/** The regenerate prompt: rewrite just the rejected cards, with the reasons. */
/**
 * The one regenerate call: self-contained and slim (no board context, no tutor preamble). It carries
 * the topic, the parent card, the sibling titles and the existing claims; the slim "regen" system
 * prompt carries the card schema.
 */
export function regeneratePrompt(
  base: string,
  rejected: { card: RawCard; reasons: string[] }[],
  board: Board,
  anchorId: string | null = null,
): string {
  const existing = board.nodes.flatMap((n) => claimsOf(n)).slice(0, 30);
  const parent = anchorId ? board.nodes.find((n) => n.id === anchorId) : undefined;
  const siblings = board.nodes.filter((n) => anchorId && n.parentId === anchorId).map((n) => n.title).slice(0, 12);
  return `起点问题：${board.topic.slice(0, 200)}
${parent ? `父卡（anchor）：「${parent.title}」${parent.body ? `：${parent.body.slice(0, 300)}` : ""}\n` : ""}${siblings.length ? `已有兄弟卡：${JSON.stringify(siblings)}\n` : ""}原始要求（节选）：${base.slice(0, 300)}
上一轮有 ${rejected.length} 张候选没有通过新知识检查，请只重写这几张（同样的 JSON 格式，id 保持不变），逐条改掉问题：
${rejected.map(({ card, reasons }) => `- ${card.id}「${card.title}」：${reasons.join("；")}`).join("\n")}
已有卡片的关键论断如下，不要重复：${JSON.stringify(existing)}${probeBrief(board) ? `\n${probeBrief(board)}` : ""}`;
}

export interface GateOutcome {
  kept: { card: RawCard; meta: GateMeta }[];
  merges: { card: RawCard; into: string }[];
  dropped: { card: RawCard; reasons: string[] }[];
  calls: { regen: number; judge: number };
  tokens: number;
}
/** Rough token estimate for logs: CJK ≈ 1 token per 1.5 characters. */
export const roughTokens = (...texts: string[]) =>
  Math.round(texts.reduce((n, t) => n + t.length, 0) / 1.5);

export function parseCards(text: string): { cards: RawCard[]; rest: Record<string, unknown> } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { cards: [], rest: {} };
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const { nodes, ...rest } = j ?? {};
    return {
      cards: Array.isArray(nodes) ? nodes.filter((n: any) => n && typeof n.id === "string") : [],
      rest,
    };
  } catch {
    return { cards: [], rest: {} };
  }
}

/**
 * The whole gate for one expansion: cheap checks → at most one regenerate for rejected cards →
 * one batched judge call for borderline cards. `ask` sends a quiet request and resolves its text.
 */
export async function runGate(
  text: string,
  board: Board,
  anchorId: string | null,
  ask: (mode: "regen" | "gate", prompt: string) => Promise<string>,
  regenBase: string,
  /** regenAny: regenerate rejected cards even when most of the batch passed (the learner asked for one card per item). */
  opts: { regenAny?: boolean } = {},
): Promise<GateOutcome & { rest: Record<string, unknown> }> {
  const { cards, rest } = parseCards(text);
  const out: GateOutcome = { kept: [], merges: [], dropped: [], calls: { regen: 0, judge: 0 }, tokens: roughTokens(text) };
  const parentOf = (c: RawCard) =>
    c.parent === "anchor" || c.parent === undefined ? anchorId : (c.parent ?? null);
  const border: { card: RawCard; v: Extract<Verdict, { kind: "borderline" }>; regenerated: boolean }[] = [];
  const pass = (list: RawCard[], regenerated: boolean) => {
    const rejected: { card: RawCard; reasons: string[] }[] = [];
    for (const c of list) {
      const v = cheapGate(c, board, parentOf(c), list);
      if (v.kind === "accept") out.kept.push({ card: c, meta: gateMeta(c, v, regenerated ? { regenerated } : {}) });
      else if (v.kind === "merge") out.merges.push({ card: c, into: v.into });
      else if (v.kind === "borderline") border.push({ card: c, v, regenerated });
      else rejected.push({ card: c, reasons: v.reasons });
    }
    return rejected;
  };
  const rejected = pass(cards, false);
  // Token budget: only spend a regenerate call when more than half the batch failed (or <2 survive), unless regenAny.
  const survivors = out.kept.length + border.length;
  if (rejected.length && !opts.regenAny && survivors >= 2 && rejected.length * 2 <= cards.length) out.dropped.push(...rejected);
  else if (rejected.length) {
    const prompt = regeneratePrompt(regenBase, rejected, board, anchorId);
    out.calls.regen++;
    try {
      const again = await ask("regen", prompt);
      out.tokens += roughTokens(prompt, again);
      const ids = new Set(rejected.map((r) => r.card.id));
      const redo = parseCards(again).cards.filter((c) => ids.has(c.id));
      const still = pass(redo, true);
      const redone = new Set(redo.map((c) => c.id));
      out.dropped.push(...still, ...rejected.filter((r) => !redone.has(r.card.id)));
    } catch {
      out.dropped.push(...rejected);
    }
  }
  if (border.length) {
    const todo = border.filter((b) => !judgeCache.has(judgeKey(b.card, b.v.against)));
    if (todo.length) {
      const prompt = judgePrompt(board, todo.map((b) => ({ card: b.card, against: b.v.against })));
      out.calls.judge++;
      try {
        const reply = await ask("gate", prompt);
        out.tokens += roughTokens(prompt, reply);
        const verdicts = parseJudge(reply);
        for (const b of todo) {
          const v = verdicts.get(b.card.id);
          if (v) judgeCache.set(judgeKey(b.card, b.v.against), v);
        }
      } catch {
        /* No verdict: borderline cards are dropped below. */
      }
    }
    for (const b of border) {
      const v = judgeCache.get(judgeKey(b.card, b.v.against));
      if (v?.pass)
        out.kept.push({
          card: b.card,
          meta: gateMeta(b.card, b.v, { decidedBy: "judge", judgeAdds: v.adds, ...(b.regenerated ? { regenerated: true } : {}) }),
        });
      else out.dropped.push({ card: b.card, reasons: ["和已有卡片差别不够具体"] });
    }
  }
  return { ...out, rest };
}

/** Test hook: forget cached verdicts. */
export const clearJudgeCache = () => judgeCache.clear();
