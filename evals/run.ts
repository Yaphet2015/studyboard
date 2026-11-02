/**
 * Generation eval harness. Runs the app's REAL prompt builders (tutorInstructions,
 * renderScopedContext, contextForNote, firstLevelPrompt, expandPrompt) and parser
 * (buildMapFromAI) against an OpenAI-compatible model from env, then scores the trees.
 *
 * Env (required): LLM_TEST_API_KEY, LLM_TEST_BASE_URL, LLM_TEST_MODEL.
 * Optional: EVAL_TOPICS=id,id  EVAL_PLAN=0  EVAL_CONCURRENCY=3  EVAL_ROUND2=first|all  EVAL_OUT=dir
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canvasBundle,
  canvasTutorInstructions,
  maxOutputTokens,
  modeTemperature,
  renderScopedContext,
  tutorInstructions,
} from "../electron/prompts";
import { buildMapFromAI, createEmptyBoard, newNote } from "../src/model/boards";
import { contextForNote, leanForGeneration } from "../src/model/context";
import { answerProbe, applyExpand, applyRefine, chainPrompt, newProbe, nextStep, parsePoints, probeOutcome, refinePrompt, localGrade } from "../src/model/probe";
import { parseWrap, wrapPrompt } from "../src/model/wrap";
import {
  firstLevelPrompt,
  kickoffNote,
  kickoffPrompt,
  kickoffSkeleton,
  learnerAnswers,
} from "../src/model/kickoff";
import {
  confirmPlan,
  coveredBlocks,
  parsePlan,
  planFirstLevelPrompt,
  planPrompt,
} from "../src/model/plan";
import type { BoardPlan } from "../src/shared/types";
import { expandPrompt } from "../src/model/expand";
import { ANGLE_DEPTH, DIG_ANGLES } from "../src/model/angles";
import { runGate, FILLER } from "../src/model/novelty";
import { applyGate } from "../src/model/gate";
import { markPrompt, parseMark, testPoints } from "../src/model/mark";
import type { Board, ContextBundle, StickyNote } from "../src/shared/types";
import { TOPICS, type EvalTopic } from "./topics";
import { treeMetrics, type EvalNode } from "./metrics";

const KEY = process.env.LLM_TEST_API_KEY;
const BASE = (process.env.LLM_TEST_BASE_URL ?? "").replace(/\/$/, "");
const MODEL = process.env.LLM_TEST_MODEL ?? "";
if (!KEY || !BASE || !MODEL) {
  console.log(
    "eval:generation skipped: set LLM_TEST_API_KEY, LLM_TEST_BASE_URL, LLM_TEST_MODEL.",
  );
  process.exit(0);
}
// Same output budget as the app gives this model (electron/prompts.ts maxOutputTokens).
const MAX_TOKENS = maxOutputTokens(MODEL);
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 3));

interface Usage {
  prompt: number;
  completion: number;
  reasoning: number;
  cached: number;
}
const totals: Usage & {
  calls: number;
  failures: number;
  retries: number;
  retryMs: number;
  retryReasons: string[];
} = {
  retries: 0,
  retryMs: 0,
  retryReasons: [],
  prompt: 0,
  completion: 0,
  reasoning: 0,
  cached: 0,
  calls: 0,
  failures: 0,
};

type Msg = { role: "system" | "user" | "assistant"; content: string };
async function chat(
  system: string,
  user: string | Msg[],
  opts: { temperature?: number; effort?: "low" | "high" } = {},
  tries = 3,
) {
  const turns: Msg[] =
    typeof user === "string" ? [{ role: "user", content: user }] : user;
  let last = "";
  for (let i = 0; i < tries; i++) {
    const started = Date.now();
    try {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("timeout"));
        }, Number(process.env.EVAL_TIMEOUT_MS ?? 150_000));
      });
      deadline.catch(() => {});
      const res = await Promise.race([fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
          ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
          // Same as the app: DeepSeek V4 runs structured calls with thinking off unless asked
          // (EVAL_THINKING=on reproduces the old default-thinking baseline).
          ...(/deepseek/i.test(BASE) && process.env.EVAL_THINKING !== "on"
            ? { thinking: { type: opts.effort ? "enabled" : "disabled" } }
            : {}),
          messages: [{ role: "system", content: system }, ...turns],
        }),
        signal: abort.signal,
      }), deadline]);
      // The deadline also covers the body: a stalled stream (keep-alive bytes, no end) used to
      // hold a step for ~9 minutes and then come back empty.
      const json: any = await Promise.race([
        res.json().catch(() => ({ __bodyError: true })),
        deadline,
      ]);
      if (json.__bodyError) throw new Error(`body read failed after ${Math.round((Date.now() - started) / 1000)}s`);
      clearTimeout(timer);
      totals.calls++;
      if (!res.ok) {
        last = `HTTP ${res.status}: ${String(json?.error?.message ?? "").slice(0, 200)}`;
      } else {
        const msg = json.choices?.[0]?.message ?? {};
        const u = json.usage ?? {};
        totals.prompt += u.prompt_tokens ?? 0;
        totals.completion += u.completion_tokens ?? 0;
        totals.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0;
        totals.cached +=
          u.prompt_cache_hit_tokens ??
          u.prompt_tokens_details?.cached_tokens ??
          0;
        const content: string = msg.content ?? "";
        const finish = json.choices?.[0]?.finish_reason;
        if (content.trim())
          return {
            content,
            reasoningChars: (msg.reasoning_content ?? "").length,
            finish,
            usage: u,
            ms: Date.now() - started,
          };
        last = `empty content (finish_reason=${finish})`;
      }
    } catch (e) {
      last = String((e as Error).message ?? e).slice(0, 200);
    }
    // Failed attempts (timeouts, HTTP errors, empty content) are counted so slow steps are explainable.
    totals.retries++;
    totals.retryMs += Date.now() - started;
    if (totals.retryReasons.length < 40)
      totals.retryReasons.push(`${Math.round((Date.now() - started) / 1000)}s ${last.slice(0, 80)}`);
    console.error(`  retry ${i + 1}/${tries} after ${Math.round((Date.now() - started) / 1000)}s: ${last.slice(0, 120)}`);
    // Balance (402), rate (429) and server (5xx) errors are often transient: wait longer before retrying.
    const transient = /^HTTP (402|429|5\d\d)/.test(last);
    await new Promise((r) => setTimeout(r, (transient ? 20_000 : 2000) * (i + 1)));
  }
  totals.failures++;
  throw new Error(last);
}

interface Step {
  kind: "map" | "expand" | "kickoff" | "plan";
  parseRetries?: number;
  round: number;
  anchor: string;
  anchorTitle: string;
  systemChars: number;
  prompt: string;
  raw?: string;
  reasoningChars?: number;
  finish?: string;
  ms?: number;
  usage?: unknown;
  added: number;
  error?: string;
}

/** One generation exactly as App.tsx builds it: a virtual note on the anchor, full review context. */
async function generate(
  board: Board,
  anchorId: string,
  mode: "map" | "expand",
  prompt: string,
  round: number,
  steps: Step[],
) {
  const virtual = newNote(
    board,
    { x: 0, y: 0 },
    { kind: "node", id: anchorId },
  );
  const context: ContextBundle = contextForNote(
    { ...board, notes: [...board.notes, virtual] },
    virtual.id,
  );
  const system = `${tutorInstructions(mode)}\n\n${renderScopedContext(context)}`;
  const anchor = board.nodes.find((n) => n.id === anchorId)!;
  const step: Step = {
    kind: mode,
    round,
    anchor: anchorId,
    anchorTitle: anchor.title,
    systemChars: system.length,
    prompt,
    added: 0,
  };
  steps.push(step);
  // A reply that fails to parse is asked for once more (same request), as a learner's retry would.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat(system, prompt, {
        temperature: modeTemperature(mode),
      });
      Object.assign(step, {
        raw: r.content,
        reasoningChars: r.reasoningChars,
        finish: r.finish,
        ms: r.ms,
        usage: r.usage,
      });
      const next = buildMapFromAI(r.content, board, anchorId, mode, context);
      step.added = next.nodes.length - board.nodes.length;
      delete step.error;
      return next;
    } catch (e) {
      step.error = String((e as Error).message ?? e);
      if (!/图谱|JSON/.test(step.error)) break;
      step.parseRetries = (step.parseRetries ?? 0) + 1;
    }
  }
  return board;
}


function levels(board: Board): EvalNode[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const depth = (id: string): number => {
    let d = 0,
      p = byId.get(id)?.parentId ?? null;
    while (p) {
      d++;
      p = byId.get(p)?.parentId ?? null;
    }
    return d;
  };
  return board.nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    title: n.title,
    // Rich cards (PR-C): the judge and the text metrics read everything the card says.
    body: [
      n.depthType ? `〔${n.depthType}〕` : "",
      n.summary ?? "",
      n.body,
      ...(n.keyPoints ?? []).map((k) => `· ${k}`),
      n.whyItMatters ? `作用：${n.whyItMatters}` : "",
      n.example ? `例：${n.example}` : "",
      n.misconception ?? "",
    ]
      .filter(Boolean)
      .join(" "),
    level: depth(n.id),
    rich: !!n.keyPoints?.length,
  }));
}

function outlineText(nodes: EvalNode[]): string {
  const kids = new Map<string | null, EvalNode[]>();
  for (const n of nodes)
    kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const lines: string[] = [];
  const walk = (n: EvalNode) => {
    lines.push(
      `${"  ".repeat(n.level)}- [L${n.level}] ${n.title}${n.body ? `：${n.body}` : ""}`,
    );
    for (const k of kids.get(n.id) ?? []) walk(k);
  };
  for (const r of kids.get(null) ?? []) walk(r);
  return lines.join("\n");
}

const JUDGE_SYSTEM = `你是严格的学习内容评审。你会看到一个学习者的起点问题、问题类型、一份人工编写的"必须覆盖要点"清单，以及 AI 生成的学习画布（树形大纲，L0 是起点，L1 第一层，L2/L3 是继续深挖）。
按下面的标准打 1–5 分（整数），严格、有区分度，3 分表示"及格但平庸"：
- goalFit（贴题）：整棵树是否围绕起点问题的真实意图（例如"怎么选"要落到决策维度与取舍，"如何学"要落到学习路径与方法，"为什么"要回答原因），而不是泛泛介绍该领域。5=每层都直接服务问题意图；1=大量偏题或答非所问。
- coverage（覆盖）：对照清单逐条判断是否被画布实质覆盖（标题或正文明确讲到该要点，不是只出现关键词）。另外判断是否有清单外但重要的遗漏。
- depth（深度）：卡片内容是否超出定义和复述，给出机制/因果、具体例子或数字、误区、判断标准；深层（L2/L3）是否真的比上层更深。5=多数卡片有实质信息；1=多数是标题式空话。
- nonRedundancy（不重复）：卡片之间、上下层之间是否避免同义改写和重复；深挖是否带来新信息。5=几乎无重复；1=大量换说法重复。
- newInfoPerCard（每卡新信息）：逐张看非起点卡片，它的要点里有多少是父卡、兄弟卡或其他卡片没说过的新事实、机制、例子或判断标准。5=几乎每张都有实质新信息；3=约一半卡片只是换说法；1=多数卡片没有新信息。
depth 要依据卡片的全部内容（结论、正文、要点、例子、误解）评，而不只是标题。
只输出一个 JSON 对象，不要代码围栏：{"goalFit":n,"coverage":n,"depth":n,"nonRedundancy":n,"newInfoPerCard":n,"checklist":[{"item":"清单原文","covered":true或false,"where":"覆盖它的卡片标题或空"}],"missingImportant":["清单外的重要遗漏"],"redundantPairs":[["卡片A","卡片B"]],"shallowExamples":["最空泛的卡片标题：原因"],"verdict":"两三句总评"}`;

/** The plan request as App.tsx requestPlan sends it; the harness auto-confirms the draft. */
async function plan(board: Board, steps: Step[]): Promise<BoardPlan> {
  const root = board.nodes[0];
  const virtual = newNote(board, { x: 0, y: 0 }, { kind: "node", id: root.id });
  const context = contextForNote(
    { ...board, notes: [virtual] },
    virtual.id,
    undefined,
    false,
    "references",
  );
  const system = `${tutorInstructions("plan")}\n\n${renderScopedContext(context)}`;
  const prompt = planPrompt(board.topic, learnerAnswers(kickoffNote(board)));
  const step: Step = {
    kind: "plan",
    round: -1,
    anchor: root.id,
    anchorTitle: root.title,
    systemChars: system.length,
    prompt,
    added: 0,
  };
  steps.push(step);
  const r = await chat(system, prompt, { temperature: modeTemperature("plan") });
  Object.assign(step, {
    raw: r.content,
    reasoningChars: r.reasoningChars,
    finish: r.finish,
    ms: r.ms,
    usage: r.usage,
  });
  return confirmPlan(parsePlan(r.content));
}

const PLAN_JUDGE_SYSTEM = `你是严格的教学设计评审。给你一个起点问题、它的“必须覆盖要点”清单和一份学习计划骨架。逐条判断清单中的每个要点是否被骨架中的某个块明确规划（块的标题或理由点到了它；只是相关不算）。再给 1–5 分：intentFit（类型判断与目标是否切合起点问题的真实意图），structure（块是否互不重叠、粒度合适、顺序合理）。
只输出一个 JSON 对象，不要代码围栏：{"checklist":[{"item":"清单原文","covered":true或false,"block":"块id或空"}],"intentFit":n,"structure":n,"verdict":"一两句"}`;

async function judgePlan(t: EvalTopic, p: BoardPlan) {
  const skeleton = p.blocks
    .map((b) => `${b.parent ? "  " : ""}- [${b.id}]${b.core ? "（核心）" : ""} ${b.title}：${b.why}`)
    .join("\n");
  const user = `起点问题：「${t.topic}」\n必须覆盖要点：\n${t.mustHave.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n计划：类型 ${p.intent}；目标 ${p.goal}；学习者 ${p.learner}\n骨架：\n${skeleton}\n不展开：${p.outOfScope.join("、")}`;
  const r = await chat(PLAN_JUDGE_SYSTEM, user);
  const s = r.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  const covered = (j.checklist ?? []).filter((c: any) => c.covered).length;
  return { ...j, planChecklistCoverage: +(covered / t.mustHave.length).toFixed(3) };
}

async function judge(t: EvalTopic, nodes: EvalNode[]) {
  const user = `起点问题：「${t.topic}」\n问题类型：${t.type}\n必须覆盖要点：\n${t.mustHave.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n画布：\n${outlineText(nodes)}`;
  const r = await chat(JUDGE_SYSTEM, user);
  const s = r.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  const covered = (j.checklist ?? []).filter((c: any) => c.covered).length;
  return { ...j, checklistCoverage: +(covered / t.mustHave.length).toFixed(3) };
}

/**
 * 「让 AI 带我开始」 as the Electron app runs it: a drawer conversation on the root, answered by
 * the canvas-agent tutor with the request's references (App.tsx askNote → ai-runtime canvasBundle).
 * The harness has no tools, so the tutor answers from the provided context only.
 */
async function kickoff(
  board: Board,
  t: EvalTopic,
  steps: Step[],
): Promise<Board> {
  const root = board.nodes[0].id;
  const at = () => new Date().toISOString();
  const ask = async (n: StickyNote, text: string): Promise<StickyNote> => {
    const asked: StickyNote = {
      ...n,
      messages: [
        ...n.messages,
        { id: `u${n.messages.length}`, role: "user", text, createdAt: at() },
      ],
    };
    const context = contextForNote(
      { ...board, notes: [...board.notes, asked] },
      n.id,
      undefined,
      false,
      "outline",
    );
    const system = `${canvasTutorInstructions()}\n\n${renderScopedContext(canvasBundle(context))}`;
    const step: Step = {
      kind: "kickoff",
      round: -1,
      anchor: root,
      anchorTitle: t.topic,
      systemChars: system.length,
      prompt: text,
      added: 0,
    };
    steps.push(step);
    const r = await chat(
      system,
      asked.messages.map((m) => ({ role: m.role, content: m.text })),
      answerOptions(),
    );
    Object.assign(step, {
      raw: r.content,
      reasoningChars: r.reasoningChars,
      finish: r.finish,
      ms: r.ms,
      usage: r.usage,
    });
    return {
      ...asked,
      messages: [
        ...asked.messages,
        {
          id: `a${asked.messages.length}`,
          role: "assistant",
          text: r.content,
          createdAt: at(),
        },
      ],
    };
  };
  const start: StickyNote = {
    ...newNote(board, { x: 0, y: 0 }, { kind: "node", id: root }),
    title: "AI 带我开始",
  };
  const first = await ask(start, kickoffPrompt(t.topic));
  const done = await ask(first, t.kickoff!);
  return { ...board, notes: [...board.notes, done] };
}
/** Request options of a drawer answer, as the app sends them. */
const answerOptions = () => ({ temperature: modeTemperature("answer") });

async function runTopic(t: EvalTopic, out: string) {
  const started = Date.now();
  const steps: Step[] = [];
  let board = createEmptyBoard(t.topic);
  const root = board.nodes[0].id;
  // Topics with a scripted learner reply go through the kickoff conversation first; the first
  // level is then built exactly as 「铺成第一层」 does (App.tsx proposeFirstLevel).
  if (t.kickoff && process.env.EVAL_KICKOFF !== "0") {
    try {
      board = await kickoff(board, t, steps);
    } catch (e) {
      steps.push({
        kind: "kickoff",
        round: -1,
        anchor: root,
        anchorTitle: t.topic,
        systemChars: 0,
        prompt: "",
        added: 0,
        error: String((e as Error).message ?? e),
      });
    }
  }
  // Plan, then expand (App.tsx proposeFirstLevel → requestPlan → confirm). EVAL_PLAN=0 keeps the PR-A path.
  let planJudgement: any;
  if (process.env.EVAL_PLAN !== "0") {
    try {
      board = { ...board, plan: await plan(board, steps) };
    } catch (e) {
      const last = steps[steps.length - 1];
      if (last?.kind === "plan") last.error = String((e as Error).message ?? e);
    }
  }
  const kick = kickoffNote(board);
  board = await generate(
    board,
    root,
    "map",
    board.plan
      ? planFirstLevelPrompt(board)
      : firstLevelPrompt(t.topic, learnerAnswers(kick), kickoffSkeleton(kick)),
    0,
    steps,
  );
  const l1 = board.nodes.filter((n) => n.parentId === root).map((n) => n.id);
  // Round 1: expand every L1 card. Sequential, like the app (one non-answer request at a time).
  for (const id of l1)
    board = await generate(
      board,
      id,
      "expand",
      expandPrompt(board, id),
      1,
      steps,
    );
  // Round 2: dig one more level under each L1 branch (its first child), or every L2 card with EVAL_ROUND2=all.
  const l2 = l1.flatMap((id) => {
    const kids = board.nodes
      .filter((n) => n.parentId === id)
      .sort((a, b) => a.order - b.order)
      .map((n) => n.id);
    return process.env.EVAL_ROUND2 === "all" ? kids : kids.slice(0, 1);
  });
  for (const id of l2)
    board = await generate(
      board,
      id,
      "expand",
      expandPrompt(board, id),
      2,
      steps,
    );
  const nodes = levels(board);
  const metrics: any = treeMetrics(nodes);
  const generated = nodes.filter((n: any) => n.level > 0);
  metrics.richShare = generated.length
    ? +(generated.filter((n: any) => n.rich).length / generated.length).toFixed(3)
    : 0;
  if (board.plan) {
    metrics.planBlocks = board.plan.blocks.length;
    metrics.blockCoverage = +(
      coveredBlocks(board).size / board.plan.blocks.length
    ).toFixed(3);
    try {
      planJudgement = await judgePlan(t, board.plan);
    } catch (e) {
      planJudgement = { error: String((e as Error).message) };
    }
  }
  let judgement: any;
  try {
    judgement = await judge(t, nodes);
  } catch (e) {
    judgement = { error: String((e as Error).message) };
  }
  const result = {
    topic: t,
    model: MODEL,
    steps,
    nodes,
    relations: board.relations,
    metrics,
    judgement,
    plan: board.plan,
    planJudgement,
    outline: outlineText(nodes),
    ms: Date.now() - started,
  };
  await writeFile(join(out, `${t.id}.json`), JSON.stringify(result, null, 2));
  console.log(
    `✓ ${t.id} (${t.type}) ${metrics.nodes} cards, ${Math.round(result.ms / 1000)}s` +
      (judgement.error
        ? ` judge error: ${judgement.error}`
        : ` fit ${judgement.goalFit} cov ${judgement.coverage}/${judgement.checklistCoverage} depth ${judgement.depth} nonred ${judgement.nonRedundancy}`),
  );
  return result;
}

const mean = (xs: number[]) =>
  xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : NaN;

/**
 * EVAL_MODE=angles: does 「往哪挖」 steer? Lay the first level, then expand one L1 card once per
 * angle (each from the same board), and have a blinded judge say which angle each new card digs.
 */
const ANGLE_JUDGE_SYSTEM = `你是学习材料审阅者。给你一张父卡片和它下面新加的一张子卡片。判断子卡片主要在往哪个方向深入，只能选一个：
why（解释原因、机制）、how（步骤、做法、如何运作）、example（具体例子、算例、案例）、edge（边界条件、例外、误区、何时不成立）、compare（与相近概念对照、区别）、apply（在实际决策或练习中怎么用）。
只输出 JSON：{"angle":"why|how|example|edge|compare|apply","confidence":1-5}`;
async function angleCheck(t: EvalTopic, out: string) {
  const steps: Step[] = [];
  let board = createEmptyBoard(t.topic);
  const root = board.nodes[0].id;
  board = await generate(board, root, "map", firstLevelPrompt(t.topic, []), 0, steps);
  const anchorId = board.nodes.find((n) => n.parentId === root)?.id;
  if (!anchorId) throw new Error("no first level");
  const anchor = board.nodes.find((n) => n.id === anchorId)!;
  const rows: any[] = [];
  for (const angle of DIG_ANGLES) {
    const next = await generate(board, anchorId, "expand", expandPrompt(board, anchorId, angle), 1, steps);
    const added = next.nodes.filter((n) => !board.nodes.some((o) => o.id === n.id));
    for (const n of added) {
      const user = `父卡片：「${anchor.title}」${anchor.body}\n\n子卡片：「${n.title}」\n${n.summary ?? ""}\n${n.body}\n要点：${(n.keyPoints ?? []).join("；")}${n.example ? `\n例子：${n.example}` : ""}${n.misconception ? `\n误解：${n.misconception}` : ""}`;
      let judged: any = {};
      try {
        const r = await chat(ANGLE_JUDGE_SYSTEM, user, { temperature: 0 });
        judged = JSON.parse(r.content.slice(r.content.indexOf("{"), r.content.lastIndexOf("}") + 1));
      } catch (e) {
        judged = { error: String((e as Error).message) };
      }
      rows.push({ topic: t.id, asked: angle, title: n.title, depthType: n.depthType, judged: judged.angle, confidence: judged.confidence, match: judged.angle === angle, depthMatch: n.depthType === ANGLE_DEPTH[angle] });
    }
    if (!added.length) rows.push({ topic: t.id, asked: angle, title: null, match: false, depthMatch: false });
  }
  await writeFile(join(out, `${t.id}.angles.json`), JSON.stringify({ anchor: anchor.title, rows, steps }, null, 2));
  return rows;
}

/**
 * EVAL_MODE=gate: a small real-LLM sample of the new-knowledge gate. Lays the first level and
 * expands EVAL_EXPANDS L1 cards through runGate exactly as App.tsx does, marks one check answer,
 * and reports real token usage per step plus field completeness and filler/label hits.
 */
async function gateSample(t: EvalTopic, out: string) {
  let board = createEmptyBoard(t.topic);
  const root = board.nodes[0].id;
  const steps: any[] = [];
  const usageNow = () => ({ prompt: totals.prompt, completion: totals.completion });
  const expandOnce = async (anchorId: string, mode: "map" | "expand", prompt: string) => {
    const before = usageNow();
    const virtual = newNote(board, { x: 0, y: 0 }, { kind: "node", id: anchorId });
    const context = leanForGeneration(contextForNote({ ...board, notes: [...board.notes, virtual] }, virtual.id), board, anchorId);
    const system = (m: string) => `${tutorInstructions(m as any)}\n\n${renderScopedContext(context)}`;
    if (process.env.EVAL_DEBUG) {
      const { topic, structure, review, plan, ...sel } = context as any;
      console.error("sizes", mode, JSON.stringify({ tutor: tutorInstructions(mode).length, structure: structure?.length ?? 0, review: JSON.stringify(review ?? "").length, selected: JSON.stringify(sel).length, prompt: prompt.length }));
    }
    const first = await chat(system(mode), prompt, { temperature: modeTemperature(mode) });
    const firstTokens = { prompt: totals.prompt - before.prompt, completion: totals.completion - before.completion };
    const outcome = await runGate(first.content, board, anchorId, async (m, p) =>
      (await chat(tutorInstructions(m), p, { temperature: modeTemperature(m) })).content, prompt);
    const applied = applyGate(board, anchorId, outcome, mode, context);
    board = applied.board;
    const after = usageNow();
    steps.push({
      mode,
      anchor: anchorId,
      kept: outcome.kept.map((k) => ({ title: k.card.title, by: k.meta.decidedBy, regenerated: !!k.meta.regenerated })),
      merged: outcome.merges.length,
      dropped: outcome.dropped.map((d) => ({ title: d.card.title, reasons: d.reasons })),
      calls: outcome.calls,
      roughTokens: outcome.tokens,
      firstCall: firstTokens,
      tokens: { prompt: after.prompt - before.prompt, completion: after.completion - before.completion },
    });
    return applied.added;
  };
  const l1 = await expandOnce(root, "map", firstLevelPrompt(t.topic, []));
  for (const id of l1.slice(0, Number(process.env.EVAL_EXPANDS ?? 2))) await expandOnce(id, "expand", expandPrompt(board, id));
  const cards = board.nodes.filter((n) => n.parentId !== null);
  const withCheck = cards.find((n) => n.check?.q);
  let mark: any;
  if (withCheck) {
    const before = usageNow();
    const r = await chat(tutorInstructions("mark"), markPrompt(withCheck.check!.q, testPoints(withCheck), "我不太确定，可能是因为条款写得复杂。"), { temperature: 0 });
    mark = { verdict: parseMark(r.content), tokens: { prompt: totals.prompt - before.prompt, completion: totals.completion - before.completion } };
  }
  const g = (n: any) => n.meta?.gate ?? {};
  const report = {
    topic: t.id,
    cards: cards.length,
    fieldsComplete: cards.filter((n) => n.check?.q && g(n).newIdea && g(n).substance?.length && g(n).addsBeyond && g(n).claims?.length).length,
    fillerHits: cards.filter((n) => FILLER.some((w) => n.title.includes(w) || n.body.includes(w))).length,
    labelHits: cards.filter((n) => /(^|\n)\s*(新知识点|机制|例子|要点)\s*[:：]/.test(n.body)).length,
    steps,
    mark,
    sample: cards.slice(0, 6).map((n) => ({ title: n.title, body: n.body, check: n.check?.q })),
  };
  await writeFile(join(out, `${t.id}.gate.json`), JSON.stringify(report, null, 2));
  return report;
}

/**
 * EVAL_MODE=probe: a small real-LLM sample of the v2 摸底 (README). Batched chain generation, MCQ graded
 * locally; two simulated learners per topic: "mid" knows the first 2 points of the initial chain,
 * "expert" knows everything (should expand and never land on an intro point). Real tokens per probe.
 */
async function probeSample(t: EvalTopic, out: string) {
  const runs: any[] = [];
  for (const who of ["mid", "expert"] as const) {
    const before = { p: totals.prompt, c: totals.completion };
    const calls: string[] = [];
    const gen = async (prompt: string, tag: string) => {
      calls.push(tag);
      const r = await chat(tutorInstructions("probe"), prompt, { temperature: modeTemperature("probe") });
      return parsePoints(r.content);
    };
    const first = await gen(chainPrompt(t.topic), "chain");
    if (!first || first.points.length < 3) {
      runs.push({ who, error: "no chain" });
      continue;
    }
    let state = newProbe(first.points);
    const initial = state.ladder.map((p) => p.id);
    const log: any[] = [];
    for (let guard = 0; state.status === "asking" && guard < 40; guard++) {
      const step = nextStep(state);
      if (step.kind === "done") {
        state = { ...state, status: "done", frontier: step.frontier, meta: { ...state.meta!, stopReason: step.reason } };
        break;
      }
      if (step.kind === "expand") {
        const r = await gen(chainPrompt(t.topic, state.ladder.at(-1), undefined, state.ladder.map((p) => p.desc)), "expand");
        state = applyExpand(state, r?.points ?? []);
        continue;
      }
      if (step.kind === "refine") {
        const r = await gen(refinePrompt(t.topic, state.ladder[step.lo], state.ladder[step.hi]), "refine");
        state = applyRefine(state, step.lo, step.hi, r?.points ?? [], r?.adjacent ?? true);
        continue;
      }
      const p = state.ladder[step.index];
      // Mid learner: knows the 2 shallowest initial points and anything refined below them.
      const k = who === "expert" || state.ladder.indexOf(p) < state.ladder.findIndex((x) => x.id === initial[2]);
      const ans = p.probe.answer ?? 0;
      const choice = k ? ans : (ans + 1) % (p.probe.options?.length ?? 4);
      const verdict = localGrade(p, choice, "") ?? "unsure";
      log.push({ q: p.desc, knows: k, verdict });
      state = answerProbe(state, { pointId: p.id ?? "", verdict, ...(step.recheck ? { recheck: true } : {}) });
    }
    const o = probeOutcome(state);
    runs.push({
      who,
      calls,
      tokens: { prompt: totals.prompt - before.p, completion: totals.completion - before.c, total: totals.prompt - before.p + totals.completion - before.c },
      questions: o.questions,
      stop: state.meta?.stopReason,
      start: o.start?.desc,
      startIsIntro: o.start?.id === initial[0],
      known: o.known?.desc,
      chain: state.ladder.map((p) => p.desc),
      log,
    });
  }
  const report = { topic: t.id, runs };
  await writeFile(join(out, `${t.id}.probe.json`), JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  if (process.env.EVAL_MODE === "probe") {
    const pick = process.env.EVAL_TOPICS?.split(",").map((s) => s.trim()) ?? ["critical-illness"];
    const out = process.env.EVAL_OUT ?? join("evals", "results", "probe");
    await mkdir(out, { recursive: true });
    const reports = [];
    for (const t of TOPICS.filter((x) => pick.includes(x.id))) reports.push(await probeSample(t, out));
    const summary = { model: MODEL, usage: totals, reports };
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 1));
    return;
  }
  if (process.env.EVAL_MODE === "gate") {
    const pick = process.env.EVAL_TOPICS?.split(",").map((s) => s.trim()) ?? ["critical-illness"];
    const out = process.env.EVAL_OUT ?? join("evals", "results", "gate");
    await mkdir(out, { recursive: true });
    const reports = [];
    for (const t of TOPICS.filter((x) => pick.includes(x.id))) reports.push(await gateSample(t, out));
    const summary = { model: MODEL, usage: totals, reports: reports.map(({ sample, ...r }) => r) };
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 1));
    return;
  }
  if (process.env.EVAL_MODE === "angles") {
    const pick = process.env.EVAL_TOPICS?.split(",").map((s) => s.trim());
    const topics = pick ? TOPICS.filter((t) => pick.includes(t.id)) : TOPICS.slice(0, 2);
    const out = process.env.EVAL_OUT ?? join("evals", "results", "angles");
    await mkdir(out, { recursive: true });
    const all = (await Promise.all(topics.map((t) => angleCheck(t, out).catch((e) => (console.log(`✗ ${t.id}: ${e.message}`), []))))).flat();
    const by = Object.fromEntries(
      DIG_ANGLES.map((a) => {
        const rs = all.filter((r) => r.asked === a && r.title);
        return [a, { cards: rs.length, judgedMatch: rs.filter((r) => r.match).length, depthTagMatch: rs.filter((r) => r.depthMatch).length }];
      }),
    );
    const cards = all.filter((r) => r.title);
    const summary = { model: MODEL, topics: topics.map((t) => t.id), cards: cards.length, judgedMatch: +(cards.filter((r) => r.match).length / (cards.length || 1)).toFixed(3), depthTagMatch: +(cards.filter((r) => r.depthMatch).length / (cards.length || 1)).toFixed(3), byAngle: by, usage: totals, rows: all.map(({ topic, asked, title, depthType, judged, confidence }) => ({ topic, asked, title, depthType, judged, confidence })) };
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ cards: summary.cards, judgedMatch: summary.judgedMatch, depthTagMatch: summary.depthTagMatch, byAngle: by }, null, 1));
    return;
  }
  const pick = process.env.EVAL_TOPICS?.split(",").map((s) => s.trim());
  const topics = pick ? TOPICS.filter((t) => pick.includes(t.id)) : TOPICS;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = process.env.EVAL_OUT ?? join("evals", "results", stamp);
  await mkdir(out, { recursive: true });
  const started = Date.now();
  console.log(
    `eval:generation → ${out} (${topics.length} topics, model ${MODEL}, concurrency ${CONCURRENCY})`,
  );
  const results: any[] = [];
  const queue = [...topics];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          results.push(await runTopic(t, out));
        } catch (e) {
          console.log(`✗ ${t.id}: ${(e as Error).message}`);
        }
      }
    }),
  );
  results.sort((a, b) => TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic));
  const ok = results.filter((r) => !r.judgement.error);
  const dims = [
    "goalFit",
    "coverage",
    "depth",
    "nonRedundancy",
    "newInfoPerCard",
  ] as const;
  const row = (rs: any[]) => ({
    n: rs.length,
    ...Object.fromEntries(
      dims.map((d) => [d, mean(rs.map((r) => r.judgement[d]))]),
    ),
    checklistCoverage: mean(rs.map((r) => r.judgement.checklistCoverage)),
    planChecklistCoverage: mean(
      rs.map((r) => r.planJudgement?.planChecklistCoverage).filter((x) => x != null),
    ),
    blockCoverage: mean(
      rs.map((r) => r.metrics.blockCoverage).filter((x) => x != null),
    ),
    cards: mean(rs.map((r) => r.metrics.nodes)),
    richShare: mean(rs.map((r) => r.metrics.richShare)),
    textDupRate: mean(rs.map((r) => r.metrics.textPairs.dupRate)),
    newInfoL2: mean(
      rs.map((r) => r.metrics.newInfoRatio[2]).filter((x) => x != null),
    ),
    newInfoL3: mean(
      rs.map((r) => r.metrics.newInfoRatio[3]).filter((x) => x != null),
    ),
    bodyL1: mean(
      rs.map((r) => r.metrics.avgBodyChars[1]).filter((x) => x != null),
    ),
    bodyL3: mean(
      rs.map((r) => r.metrics.avgBodyChars[3]).filter((x) => x != null),
    ),
  });
  const types = [...new Set(TOPICS.map((t) => t.type))];
  const summary = {
    stamp,
    model: MODEL,
    topics: results.length,
    wallMs: Date.now() - started,
    usage: totals,
    overall: row(ok),
    byType: Object.fromEntries(
      types.map((ty) => [ty, row(ok.filter((r) => r.topic.type === ty))]),
    ),
    byTopic: results.map((r) => ({
      id: r.topic.id,
      type: r.topic.type,
      ...Object.fromEntries(dims.map((d) => [d, r.judgement[d]])),
      checklistCoverage: r.judgement.checklistCoverage,
      planChecklistCoverage: r.planJudgement?.planChecklistCoverage,
      planIntent: r.plan?.intent,
      planIntentFit: r.planJudgement?.intentFit,
      planStructure: r.planJudgement?.structure,
      blockCoverage: r.metrics.blockCoverage,
      cards: r.metrics.nodes,
      richShare: r.metrics.richShare,
      byLevel: r.metrics.byLevel,
      textDupRate: r.metrics.textPairs.dupRate,
      newInfo: r.metrics.newInfoRatio,
      avgBody: r.metrics.avgBodyChars,
      failedSteps: r.steps.filter((s: Step) => s.error).length,
      parseRetries: r.steps.reduce((a: number, s: Step) => a + (s.parseRetries ?? 0), 0),
      emptyExpansions: r.steps.filter(
        (s: Step) => s.kind === "expand" && !s.error && s.added === 0,
      ).length,
      verdict: r.judgement.verdict,
    })),
  };
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  const fmt = (r: any) =>
    dims
      .map((d) => r[d])
      .concat([
        r.checklistCoverage,
        r.planChecklistCoverage ?? "",
        r.blockCoverage ?? "",
        r.cards,
        r.textDupRate,
        r.newInfoL2 ?? r.newInfo?.[2],
        r.newInfoL3 ?? r.newInfo?.[3],
      ])
      .join(" | ");
  const head =
    "| 项 | 贴题 | 覆盖 | 深度 | 不重复 | 每卡新信息 | 清单覆盖率 | 计划清单覆盖 | 块落地率 | 卡片数 | 近重复对比例 | L2 新信息率 | L3 新信息率 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const md = [
    `# Generation eval ${stamp}`,
    `模型 ${MODEL}；${results.length} 个主题；用时 ${Math.round(summary.wallMs / 1000)}s；调用 ${totals.calls} 次（失败 ${totals.failures}）；tokens 输入 ${totals.prompt}（缓存命中 ${totals.cached}）/ 输出 ${totals.completion}（其中推理 ${totals.reasoning}）。`,
    "",
    "## 总体与按类型",
    head,
    `| 全部 | ${fmt(summary.overall)} |`,
    ...types.map((ty) => `| ${ty} | ${fmt(summary.byType[ty])} |`),
    "",
    "## 按主题",
    head,
    ...summary.byTopic.map((r) => `| ${r.id} | ${fmt(r)} |`),
    "",
    "## 评审总评",
    ...summary.byTopic.map(
      (r) => `- **${r.id}**：${r.verdict ?? "（评审失败）"}`,
    ),
  ].join("\n");
  await writeFile(join(out, "summary.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
