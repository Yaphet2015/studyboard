// The post-probe chat (v2): one ordinary chat call per message, a slim context, and at most one
// structured proposal per answer. No classifier and no modes; free text never writes cards.
import type { AIRequest, Board, ChatMessage, ChatProposal, StickyNote } from "../shared/types";
import { chatProposalSchema, routeOpSchema } from "../shared/validation";
import { descendantIds, routeOf, sealed, stationOf, validRouteOps } from "./route";
import { z } from "zod";

/** Rough token estimate (CJK ≈ 1 token per 1.5 characters; ASCII is cheaper, so this overshoots). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 1.5);
/** Per-turn budget: the system prompt + this prompt + the answer stay under 2.5k tokens. */
export const TURN_CAP = 2_500;
const SYSTEM_TOKENS = 800;
const OUTPUT_TOKENS = 400;
const HISTORY = 6;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const plain = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Which stop the chat is about: the card selected on the canvas when it is on the route, else the
 * thread's card when it is, else the next unsealed one.
 */
export function currentStop(board: Board, note?: StickyNote, selectedId?: string) {
  const stops = routeOf(board);
  const anchor = note?.attachedTo?.kind === "node" ? note.attachedTo.id : undefined;
  return (
    stops.find((s) => s.id === selectedId) ?? stops.find((s) => s.id === anchor) ?? stops.find((s) => !sealed(s))
  );
}

const SHOWN_CHILDREN = 8;
/** What the learner has selected on the canvas, with the cards directly below it (L2): title + 40 chars. */
function selectedBlock(board: Board, selectedId?: string): string {
  const card = board.nodes.find((n) => n.id === selectedId);
  // The root's L2 is the route itself, which the prompt already lists.
  if (!card || card.parentId === null) return "";
  const no = stationOf(board, card.id);
  const kids = board.nodes.filter((n) => n.parentId === card.id).sort((a, b) => a.order - b.order);
  const list = kids
    .slice(0, SHOWN_CHILDREN)
    .map((k) => `- 「${clip(plain(k.title), 24)}」${k.summary || k.body ? `：${clip(plain(k.summary || k.body), 40)}` : ""}`);
  if (kids.length > SHOWN_CHILDREN) list.push(`- …共 ${kids.length} 张`);
  return (
    `选中卡：${no ? `第 ${no} 站` : ""}「${clip(plain(card.title), 40)}」\n` +
    (list.length ? `下层(L2) ${kids.length} 张：\n${list.join("\n")}\n` : "下层(L2)：还没有\n")
  );
}

/** The user prompt: topic, numbered route, current stop, the last 6 turns and the new message. */
export function chatPrompt(board: Board, note: StickyNote | undefined, text: string, selectedId?: string): string {
  const stops = routeOf(board);
  const current = currentStop(board, note, selectedId);
  const route = stops.length
    ? stops.map((s, i) => `${i + 1}. ${clip(plain(s.title), 40)}${sealed(s) ? " ✓" : ""}`).join("\n")
    : "（还没有路线）";
  const head =
    `主题：${clip(plain(board.topic), 120)}\n` +
    `路线（✓ 为已讲通）：\n${route}\n` +
    (current
      ? `当前站：第 ${stationOf(board, current.id)} 站「${clip(plain(current.title), 40)}」${current.body ? `：${clip(plain(current.body), 200)}` : ""}\n`
      : "") +
    selectedBlock(board, selectedId);
  // A card off the route that the thread hangs on, and cards the learner added on purpose.
  const anchorId = note?.attachedTo?.kind === "node" ? note.attachedTo.id : undefined;
  const anchor = board.nodes.find((n) => n.id === anchorId);
  const extra = [
    ...(anchor && anchor.id !== current?.id && anchor.parentId !== null && !stops.includes(anchor) ? [anchor] : []),
    ...(note?.contextCards ?? []).map((id) => board.nodes.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n),
  ]
    .filter((n, i, all) => all.indexOf(n) === i)
    .slice(0, 4);
  const cards = extra.length
    ? `学习者带上的卡片：\n${extra.map((n) => `- 「${clip(plain(n.title), 40)}」${n.body ? `：${clip(plain(n.body), 120)}` : ""}`).join("\n")}\n`
    : "";
  const tail = `学习者现在说：「${clip(text.trim(), 600)}」`;
  const turns = (note?.messages ?? [])
    .slice(-HISTORY)
    .map((m) => `${m.role === "user" ? "学习者" : "教练"}：${clip(plain(m.text), 300)}`);
  // Over the cap, drop the oldest turns first.
  const budget = TURN_CAP - SYSTEM_TOKENS - OUTPUT_TOKENS;
  while (turns.length && estimateTokens(head + cards + turns.join("\n") + tail) > budget) turns.shift();
  return head + cards + (turns.length ? `最近对话：\n${turns.join("\n")}\n` : "") + tail;
}

/** One chat turn: an ordinary answer call that can never write cards. */
export function chatRequest(
  board: Board,
  note: StickyNote | undefined,
  text: string,
  ids: { requestId: string; stickyId: string; selectedId?: string },
): AIRequest {
  return {
    boardId: board.id,
    stickyId: ids.stickyId,
    requestId: ids.requestId,
    prompt: chatPrompt(board, note, text, ids.selectedId),
    context: { topic: board.topic, references: [], summary: "" },
    mode: "chat",
    canvas: false,
  };
}

const rawProposal = z.union([
  z.object({ type: z.literal("editRoute"), ops: z.array(z.unknown()).min(1) }).passthrough(),
  z.object({ type: z.literal("startStop"), stop: z.number() }).passthrough(),
  z
    .object({ type: z.literal("reExpand"), stop: z.union([z.number(), z.string()]), instruction: z.string() })
    .passthrough(),
]);

/** Where the answer text ends: a trailing ```json block or a bare {"proposal":…} tail. */
function tailStart(text: string): number {
  const fence = text.search(/```(?:json)?\s*\{[\s\S]*$/i);
  if (fence >= 0) return fence;
  const bare = text.search(/\{\s*"proposal"[\s\S]*$/);
  return bare;
}

/** The answer text to show while it streams: never the JSON tail, even half-written. */
export function displayChat(text: string): string {
  const fence = text.indexOf("```");
  const bare = text.search(/\{\s*"proposal"/);
  const cut = [fence, bare].filter((i) => i >= 0);
  return (cut.length ? text.slice(0, Math.min(...cut)) : text).trimEnd();
}

/** Split a reply into text and a proposal checked against the board. Bad JSON ⇒ text only. */
export function parseChatReply(text: string, board: Board): { reply: string; proposal?: ChatProposal } {
  const start = tailStart(text);
  const reply = (start >= 0 ? text.slice(0, start) : text).trim() || displayChat(text).trim();
  if (start < 0) return { reply };
  let raw = text.slice(start).replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  raw = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply };
  }
  const p = rawProposal.safeParse((parsed as { proposal?: unknown })?.proposal ?? parsed);
  if (!p.success) return { reply };
  const proposal = checkProposal(p.data, board);
  return proposal ? { reply, proposal } : { reply };
}

/** A station number, or a card title that exactly one non-root card has; the root cannot be re-expanded. */
function reExpandTarget(board: Board, ref: number | string) {
  if (typeof ref === "number") return routeOf(board)[ref - 1];
  const title = plain(ref);
  const hits = board.nodes.filter((n) => n.parentId !== null && plain(n.title) === title);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Local validation: unknown stations are dropped; startStop only for an unsealed stop; reExpand only for a real card. */
export function checkProposal(raw: z.infer<typeof rawProposal>, board: Board): ChatProposal | undefined {
  if (raw.type === "reExpand") {
    const target = reExpandTarget(board, raw.stop as number | string);
    const instruction = clip(plain(raw.instruction as string), 200);
    if (!target || !instruction) return undefined;
    const kids = board.nodes.filter((n) => n.parentId === target.id).length;
    const result = chatProposalSchema.safeParse({
      type: "reExpand",
      targetId: target.id,
      title: clip(plain(target.title), 200),
      instruction,
      replaces: kids,
      below: descendantIds(board, target.id).length - kids,
      state: "pending",
    });
    return result.success ? result.data : undefined;
  }
  if (raw.type === "startStop") {
    const stop = routeOf(board)[(raw.stop as number) - 1];
    if (!stop || sealed(stop)) return undefined;
    return { type: "startStop", stop: raw.stop as number, stopId: stop.id, state: "pending" };
  }
  const ops = (raw.ops as unknown[]).flatMap((o) => {
    const r = routeOpSchema.safeParse(o);
    return r.success ? [r.data] : [];
  });
  const kept = validRouteOps(board, ops);
  if (!kept.length) return undefined;
  const result = chatProposalSchema.safeParse({ type: "editRoute", ops: kept, state: "pending" });
  return result.success ? result.data : undefined;
}

/** A short go-ahead (「好」「开始吧」「应用」) that, right after a proposal, equals clicking its button. */
export function isGoAhead(text: string): boolean {
  return /^(好|好的|好啊|好吧|行|可以|嗯|对|ok|okay|yes|开始|开始吧|走吧|来吧|应用|就这样|改吧)([，,、\s]*(开始吧?|吧|呀|啊|改吧|应用吧?|就这样))?[。！!~～\s]*$/i.test(
    text.trim(),
  );
}

/** The latest assistant message, when its proposal still waits for a decision. */
export function pendingProposal(note?: StickyNote): ChatMessage | undefined {
  const last = note?.messages.at(-1);
  return last?.role === "assistant" && last.meta?.proposal?.state === "pending" ? last : undefined;
}

/** A new message makes an unhandled proposal stale (shown greyed as 已过期). */
export function expireProposals(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.meta?.proposal?.state === "pending"
      ? { ...m, meta: { ...m.meta, proposal: { ...m.meta.proposal, state: "expired" as const } } }
      : m,
  );
}

/** One message's proposal with some fields changed (state, rows, added…). Pure, so it can ride along with other board changes. */
export function withProposal(board: Board, noteId: string, messageId: string, patch: Partial<ChatProposal>): Board {
  return {
    ...board,
    notes: board.notes.map((n) =>
      n.id === noteId
        ? {
            ...n,
            messages: n.messages.map((m) =>
              m.id === messageId && m.meta?.proposal
                ? { ...m, meta: { ...m.meta, proposal: { ...m.meta.proposal, ...patch } as ChatProposal } }
                : m,
            ),
          }
        : n,
    ),
  };
}

/** The links a board change may cut (notes pinned to deleted cards), so an undo can put them back. */
export type NoteLinks = { id: string; attachedTo?: StickyNote["attachedTo"]; contextCards?: string[] }[];
export const noteLinks = (board: Board): NoteLinks =>
  board.notes.map(({ id, attachedTo, contextCards }) => ({ id, attachedTo, contextCards }));
export const restoreLinks = (notes: StickyNote[], links: NoteLinks): StickyNote[] =>
  notes.map((n) => {
    const l = links.find((x) => x.id === n.id);
    return l ? { ...n, attachedTo: l.attachedTo, contextCards: l.contextCards } : n;
  });
