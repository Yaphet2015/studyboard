// Real-LLM sample for the v2 chat turn: 15 Chinese messages, tokens per turn and proposal hits.
// Reads LLM_TEST_API_KEY / LLM_TEST_BASE_URL / LLM_TEST_MODEL from the environment; skipped without them.
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { boardSchema } from "../src/shared/validation";
import type { Board } from "../src/shared/types";
import { chatPrompt, parseChatReply } from "../src/model/chat";
import { CHAT_INSTRUCTIONS, maxOutputTokens, renderScopedContext, tutorInstructions } from "../electron/prompts";
import type { AIRequest } from "../src/shared/types";
import { contextForNote, leanForGeneration } from "../src/model/context";
import { newNote } from "../src/model/boards";
import { expandPrompt, reExpandNote } from "../src/model/expand";
import { clearBelow, landReExpand } from "../src/model/reexpand";
import { runGate } from "../src/model/novelty";

const key = process.env.LLM_TEST_API_KEY;
const base = process.env.LLM_TEST_BASE_URL;
const model = process.env.LLM_TEST_MODEL;

const n = (id: string, title: string, parentId: string | null, order: number, extra = {}) => ({ id, kind: "concept", title, body: "", parentId, order, status: "unseen", ...extra });
const board = boardSchema.parse({
  version: 3, id: "b", title: "重疾险", topic: "怎么挑一份合适的重疾险", kind: "ai",
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
  nodes: [
    n("q", "怎么挑一份合适的重疾险", null, 0, { question: true }),
    n("s1", "保费豁免条款", "q", 0, { status: "explained", body: "投保人或被保人出险后，后续保费不用再交，合同继续有效。" }),
    n("s2", "保额怎么定才够", "q", 1, { body: "保额一般按 3–5 年收入估算，要覆盖治疗费和康复期的收入缺口，再考虑预算。" }),
    n("s3", "等待期与观察期", "q", 2),
    n("s4", "重疾、中症、轻症的赔付比例", "q", 3),
  ],
  relations: [], notes: [], route: ["s1", "s2", "s3", "s4"],
  scene: { width: 180, color: "#E9AE7E", prediction: "", explanation: "", changed: null },
}) as Board;

// expected: "edit" | "start" | "none"
const sample: [string, "edit" | "start" | "none"][] = [
  ["第 3 站太浅了，换成讲等待期里最容易踩的坑", "edit"],
  ["把第 4 站删了吧，我已经懂了", "edit"],
  ["能不能在保额前面加一站讲健康告知？", "edit"],
  ["先讲赔付比例，再讲等待期", "edit"],
  ["第二站重点讲怎么算收入缺口", "edit"],
  ["等待期是什么意思？", "none"],
  ["保费豁免和保额有关系吗？", "none"],
  ["重疾险和医疗险有什么区别？", "none"],
  ["多次赔付值得买吗？", "none"],
  ["我懂了，继续往下走吧", "start"],
  ["开始下一站", "start"],
  ["我准备好学保额了", "start"],
  ["嗯……感觉有点难", "none"],
  ["第三站换成讲观察期和等待期的区别，另外轻症一般赔多少？", "edit"],
  ["这条路线挺好的，谢谢", "none"],
];

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
/** One chat/completions call the way the app sends structured modes: thinking off, temperature per mode. */
async function post(system: string, user: string, max: number, temperature: number) {
  const res = await fetch(`${base!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature, max_tokens: max, thinking: { type: "disabled" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { choices: { message: { content: string }; finish_reason: string }[]; usage: Usage };
  return { text: json.choices[0].message.content ?? "", finish: json.choices[0].finish_reason, usage: json.usage };
}

// --- 选中卡 + 重做下层: a Skills board whose stop 1 has four expanded children ---
const skillsBoard = (listed: string[]) =>
  boardSchema.parse({
    version: 3, id: "b2", title: "Skills", topic: "怎么用好 AI 编程助手的 Skills", kind: "ai",
    createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
    nodes: [
      n("q", "怎么用好 AI 编程助手的 Skills", null, 0, { question: true }),
      n("s1", "常用 Skills 一览", "q", 0, { status: "explained", body: `Skill 是一份可复用的做事说明，助手按场景自动调用。日常最常用的有：${listed.join("、")}。`, summary: "常用 Skill 的分类" }),
      n("s2", "怎么写自己的 Skill", "q", 1, { body: "写清触发场景、步骤和输出格式，并附一个示例。" }),
      n("s3", "Skill 的触发与调试", "q", 2),
      n("s4", "Skill 之间怎么组合", "q", 3),
      n("k1", "按用途分类", "s1", 0, { status: "explained", body: "Skill 按用途分成审查、测试、文档、发布几类。" }),
      n("k2", "触发条件", "s1", 1, { body: "每个 Skill 靠描述里的触发场景被选中。" }),
      n("k3", "输出格式", "s1", 2, { body: "Skill 规定输出的结构，便于复用。" }),
      n("k4", "风险与边界", "s1", 3, { body: "Skill 不应越权执行危险操作。" }),
    ],
    relations: [], notes: [], route: ["s1", "s2", "s3", "s4"],
    scene: { width: 180, color: "#E9AE7E", prediction: "", explanation: "", changed: null },
  }) as Board;

type Want = "edit" | "start" | "none" | "reExpand";
const selectedSample: [string, Want][] = [
  ["下一层直接按每个 Skills 拆，一个 Skill 一张卡", "reExpand"],
  ["这张卡下面的子卡太笼统了，重新生成，每个 Skill 单独一张", "reExpand"],
  ["把它下面那几张展开的卡重做一遍，按具体的 Skill 来分", "reExpand"],
  ["下一层不要按功能分，按每个 Skill 的使用场景拆", "reExpand"],
  ["第 3 站换成讲 Skill 调试的常见错误", "edit"],
  ["把第 4 站删掉，我不需要", "edit"],
  ["「触发条件」这张子卡是什么意思？", "none"],
  ["Skill 和普通 prompt 有什么区别？", "none"],
  ["好的，谢谢", "none"],
];

it.skipIf(!key || !base || !model)("selected-card chat sample", async () => {
  const b = skillsBoard(["代码审查", "写测试", "文档生成", "部署发布", "数据分析", "会议纪要"]);
  const rows = [];
  for (const [text, want] of selectedSample) {
    const note = { id: "n", title: "", text: "", position: { x: 0, y: 0 }, attachedTo: { kind: "node" as const, id: "s2" }, messages: [] as Board["notes"][number]["messages"] };
    const prompt = chatPrompt(b, note, text, "s1");
    const { text: out, usage } = await post(CHAT_INSTRUCTIONS, `<atlas-selected-data>\n主题：${b.topic}\n</atlas-selected-data>\n\n${prompt}`, 600, 0.3);
    const parsed = parseChatReply(out, b);
    const got: Want = !parsed.proposal ? "none" : parsed.proposal.type === "editRoute" ? "edit" : parsed.proposal.type === "startStop" ? "start" : "reExpand";
    rows.push({ text, want, got, hit: got === want, ...usage, reply: parsed.reply, proposal: parsed.proposal ?? null });
  }
  const summary = {
    model, turns: rows.length, hits: rows.filter((r) => r.hit).length,
    reExpandHits: rows.filter((r) => r.want === "reExpand" && r.hit).length + "/" + rows.filter((r) => r.want === "reExpand").length,
    editRouteInstead: rows.filter((r) => r.want === "reExpand" && r.got === "edit").length,
    prompt_mean: Math.round(rows.reduce((a, r) => a + r.prompt_tokens, 0) / rows.length),
    completion_mean: Math.round(rows.reduce((a, r) => a + r.completion_tokens, 0) / rows.length),
    total_mean: Math.round(rows.reduce((a, r) => a + r.total_tokens, 0) / rows.length),
  };
  writeFileSync(process.env.SAMPLE_OUT_SELECTED ?? "/tmp/chat-selected-sample.json", JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
});

const SKILL_SETS: Record<string, string[]> = {
  six: ["代码审查", "写测试", "文档生成", "部署发布", "数据分析", "会议纪要"],
  ten: ["代码审查", "写测试", "文档生成", "部署发布", "数据分析", "会议纪要", "重构", "性能排查", "安全扫描", "依赖升级"],
};
it.skipIf(!key || !base || !model)("reExpand expansion sample", async () => {
  const runs = [];
  for (const [name, listed] of [["six", SKILL_SETS.six], ["six-again", SKILL_SETS.six], ["ten", SKILL_SETS.ten]] as const) {
    const b = skillsBoard([...listed]);
    const instruction = "下一层直接按每个 Skills 拆，一个 Skill 一张卡";
    const ts = "2026-10-25T00:00:00.000Z";
    const cleared = clearBelow(b, "s1", "m1", ts);
    const virtual = newNote(cleared, { x: 0, y: 0 }, { kind: "node", id: "s1" });
    const context = leanForGeneration(contextForNote({ ...cleared, notes: [...cleared.notes, virtual] }, virtual.id), cleared, "s1");
    const prompt = expandPrompt(cleared, "s1") + reExpandNote(instruction);
    const mode: AIRequest["mode"] = "expand";
    const first = await post(tutorInstructions(mode), `${renderScopedContext(context)}\n\n${prompt}`, maxOutputTokens(model!), 0.4);
    const extra: { mode: string; completion: number; prompt: number }[] = [];
    const ask = async (m: "regen" | "gate", p: string) => {
      const r = await post(tutorInstructions(m), p, maxOutputTokens(model!), m === "gate" ? 0 : 0.4);
      extra.push({ mode: m, prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens });
      return r.text;
    };
    const generated = JSON.parse(first.text.slice(first.text.indexOf("{"), first.text.lastIndexOf("}") + 1) || '{"nodes":[]}').nodes?.length ?? 0;
    const res = await landReExpand(b, "s1", "m1", ts, (c) => runGate(first.text, c, "s1", ask, prompt), context);
    runs.push({
      name, skillsListed: listed.length, finish: first.finish, generated,
      kept: res.added.length, merged: res.mergedInto.length, dropped: res.outcome.dropped.map((d) => ({ title: d.card.title, reasons: d.reasons })),
      replaced: res.replaced, oldChildrenLeft: res.board.nodes.filter((x) => x.parentId === "s1").length,
      titles: res.board.nodes.filter((x) => x.parentId === "s1").map((x) => x.title),
      prompt_tokens: first.usage.prompt_tokens, completion_tokens: first.usage.completion_tokens,
      completion_per_card: generated ? Math.round(first.usage.completion_tokens / generated) : null,
      extraCalls: extra, calls: res.outcome.calls,
    });
  }
  writeFileSync(process.env.SAMPLE_OUT_EXPAND ?? "/tmp/reexpand-sample.json", JSON.stringify(runs, null, 2));
  console.log(JSON.stringify(runs.map((r) => ({ name: r.name, generated: r.generated, kept: r.kept, finish: r.finish, completion: r.completion_tokens, extraCalls: r.extraCalls.length }))));
});

it.skipIf(!key || !base || !model)("chat sample", async () => {
  const rows = [];
  // One running conversation, so later turns carry up to 6 earlier messages like the app does.
  const note = { id: "n", title: "", text: "", position: { x: 0, y: 0 }, attachedTo: { kind: "node" as const, id: "s2" }, messages: [] as Board["notes"][number]["messages"] };
  for (const [text, want] of sample) {
    const prompt = chatPrompt(board, note, text);
    const t0 = Date.now();
    const res = await fetch(`${base!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 600, thinking: { type: "disabled" },
        messages: [
          { role: "system", content: CHAT_INSTRUCTIONS },
          { role: "system", content: `<atlas-selected-data>\n主题：${board.topic}\n</atlas-selected-data>` },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    const out = json.choices[0].message.content;
    const parsed = parseChatReply(out, board);
    const got = !parsed.proposal ? "none" : parsed.proposal.type === "editRoute" ? "edit" : "start";
    const at = new Date().toISOString();
    note.messages.push({ id: `u${rows.length}`, role: "user", text, createdAt: at }, { id: `a${rows.length}`, role: "assistant", text: parsed.reply, createdAt: at });
    rows.push({ text, want, got, hit: got === want, ms: Date.now() - t0, ...json.usage, reply: parsed.reply, proposal: parsed.proposal ?? null });
  }
  const totals = rows.map((r) => r.total_tokens);
  const summary = {
    model, turns: rows.length,
    hits: rows.filter((r) => r.hit).length,
    tokens: { min: Math.min(...totals), max: Math.max(...totals), mean: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) },
    prompt_mean: Math.round(rows.reduce((a, r) => a + r.prompt_tokens, 0) / rows.length),
    completion_mean: Math.round(rows.reduce((a, r) => a + r.completion_tokens, 0) / rows.length),
  };
  writeFileSync(process.env.SAMPLE_OUT ?? "/tmp/chat-sample.json", JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
});
