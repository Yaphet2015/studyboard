// One assistant turn of the post-probe chat: a plain answer, then at most one proposal —
// an inline route diff (应用 / 取消, then 撤销) or a single 开始第 N 站 button.
import { useEffect, useState } from "react";
import { GoalSummary } from "./GoalSummary";
import { Copy, NotebookPen, Undo2 } from "lucide-react";
import type { Board, ChatMessage } from "../shared/types";
import { previewRoute, routeOf } from "../model/route";
import { AnswerBlocks } from "./AnswerBlocks";

export interface ChatActions {
  board: Board;
  /** A card generation is running (the 重做下层 proposal waits on it). */
  generating?: boolean;
  onApply: (messageId: string) => void;
  onUndo: (messageId: string) => void;
  onCancel: (messageId: string) => void;
  onStart: (messageId: string) => void;
  onSave: (messageId: string) => void;
  onReply?: (text: string) => void;
  onBegin?: () => void;
  onboarding?: boolean;
  planning?: boolean;
  starting?: boolean;
}

export function ChatTurn({ message, chat, busy, onCopy }: { message: ChatMessage; chat: ChatActions; busy: boolean; onCopy: () => void }) {
  const p = message.meta?.proposal;
  return (
    <>
      <AnswerBlocks text={message.text} />
      {!!message.meta?.chips?.length && <div className="answer-chips">{message.meta.chips.map(chip => <button className="btn sm" key={chip} disabled={busy} onClick={() => chat.onReply?.(chip)}>{chip}</button>)}</div>}
      {message.meta?.goalSummary && <>
        <GoalSummary goal={message.meta.goalSummary} />
        {!chat.board.route?.length && chat.onBegin && <div className="acts"><button className="btn primary chat-start" disabled={busy || chat.planning || chat.starting || !chat.board.plan} onClick={chat.onBegin}>{chat.planning ? "正在排路线…" : chat.starting ? "正在开始…" : "开始第 1 站"}</button></div>}
      </>}
      {p?.type === "editRoute" && <RouteDiff message={message} chat={chat} />}
      {p?.type === "reExpand" && <ReExpandDiff message={message} chat={chat} />}
      {p?.type === "startStop" && (() => {
        const stop = routeOf(chat.board).find((n) => n.id === p.stopId);
        const no = routeOf(chat.board).findIndex((n) => n.id === p.stopId) + 1;
        if (!stop) return null;
        if (p.state !== "pending")
          return <p className="chat-done">{p.state === "applied" ? `已开始第 ${no} 站` : "已过期"}</p>;
        return (
          <button className="btn primary chat-start" disabled={busy} onClick={() => chat.onStart(message.id)}>
            开始第 {no} 站 · {stop.title}
          </button>
        );
      })()}
      {message.meta?.artifact && <ArtifactAttachment message={message} board={chat.board} />}
      {!p && !busy && !message.meta?.goalSummary && !message.meta?.chips?.length && !message.meta?.artifact && !chat.onboarding && (
        <div className="acts chat-acts">
          {message.meta?.savedNote ? (
            <span className="chat-saved">已存成批注卡</span>
          ) : (
            <button className="btn sm chat-save" onClick={() => chat.onSave(message.id)}>
              <NotebookPen size={14} className="ico" />
              存成批注卡
            </button>
          )}
          <button className="btn sm" onClick={onCopy}>
            <Copy size={14} className="ico" />
            复制
          </button>
        </div>
      )}
    </>
  );
}

/** 重做下层: the card, what would be replaced, and the rule; 应用 generates first, so the old cards stay until new ones land. */
function ReExpandDiff({ message, chat }: { message: ChatMessage; chat: ChatActions }) {
  const p = message.meta?.proposal;
  if (p?.type !== "reExpand") return null;
  const kids = chat.board.nodes.filter((n) => n.parentId === p.targetId).sort((a, b) => a.order - b.order);
  const stale = p.state === "expired" || p.state === "cancelled";
  const working = p.state === "pending" && !!chat.generating;
  return (
    <div className={`route-diff ${stale ? "stale" : ""}`} role="group" aria-label="重做下层">
      <p className="rd-head">
        将重新生成「{p.title}」的下层（替换 {p.replaces} 张子卡{p.below ? `，含其下 ${p.below} 张孙卡` : ""}）
      </p>
      {p.state === "pending" && kids.length > 0 && (
        <ol className="rd-rows">
          {kids.slice(0, 5).map((k) => (
            <li key={k.id} className="rd-row replace">
              <span className="rd-old"><s>{k.title}</s></span>
            </li>
          ))}
          {kids.length > 5 && <li className="rd-row"><span className="rd-note">…共 {kids.length} 张</span></li>}
        </ol>
      )}
      <p className="rd-new rd-rule">按：{p.instruction}</p>
      <div className="rd-acts">
        {p.state === "pending" && (
          <>
            <button className="btn primary sm" disabled={!!chat.generating} onClick={() => chat.onApply(message.id)}>
              {working ? "正在重新生成…" : "应用"}
            </button>
            <button className="btn sm" disabled={working} onClick={() => chat.onCancel(message.id)}>取消</button>
          </>
        )}
        {p.state === "applied" && (
          <>
            <span className="rd-state">已重做下层{p.added ? `（新 ${p.added} 张，旧卡已归档）` : ""}</span>
            <button className="btn sm" onClick={() => chat.onUndo(message.id)}>
              <Undo2 size={14} className="ico" />
              撤销
            </button>
          </>
        )}
        {p.state === "undone" && <span className="rd-state">已撤销</span>}
        {p.state === "cancelled" && <span className="rd-state">已取消</span>}
        {p.state === "expired" && <span className="rd-state">已过期</span>}
      </div>
    </div>
  );
}

function RouteDiff({ message, chat }: { message: ChatMessage; chat: ChatActions }) {
  const p = message.meta?.proposal;
  if (p?.type !== "editRoute") return null;
  // Once applied, the board already shows the new route; the diff keeps its pre-apply snapshot.
  const rows = (p.rows ?? previewRoute(chat.board, p.ops)).filter((r) => r.kind !== "keep");
  const stale = p.state === "expired" || p.state === "cancelled";
  return (
    <div className={`route-diff ${stale ? "stale" : ""}`} role="group" aria-label="路线改动">
      <ol className="rd-rows">
        {rows.map((r, i) => (
          <li key={i} className={`rd-row ${r.kind}`}>
            {r.kind === "replace" && (
              <>
                <span className="rd-old"><s>{r.from} · {r.was}</s></span>
                <span className="rd-new">{r.to} · {r.title}</span>
                {r.archives && <span className="rd-note">已讲通，会归档</span>}
              </>
            )}
            {r.kind === "remove" && (
              <>
                <span className="rd-old"><s>{r.from} · {r.title}</s></span>
                {r.archives && <span className="rd-note">已讲通，会归档</span>}
              </>
            )}
            {r.kind === "add" && <span className="rd-new">＋ {r.to} · {r.title}<span className="rd-note">新站</span></span>}
            {r.kind === "move" && (
              <span className="rd-new">{r.to} · {r.title}<span className="rd-note">↑↓ 从第 {r.from} 站移来</span></span>
            )}
            {r.kind === "focus" && (
              <>
                <span className="rd-new">{r.to} · {r.title}</span>
                <span className="rd-note">重点：{r.focus}</span>
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="rd-acts">
        {p.state === "pending" && (
          <>
            <button className="btn primary sm" onClick={() => chat.onApply(message.id)}>应用</button>
            <button className="btn sm" onClick={() => chat.onCancel(message.id)}>取消</button>
          </>
        )}
        {p.state === "applied" && (
          <>
            <span className="rd-state">已改路线</span>
            <button className="btn sm" onClick={() => chat.onUndo(message.id)}>
              <Undo2 size={14} className="ico" />
              撤销
            </button>
          </>
        )}
        {p.state === "undone" && <span className="rd-state">已撤销</span>}
        {p.state === "cancelled" && <span className="rd-state">已取消</span>}
        {p.state === "expired" && <span className="rd-state">已过期</span>}
      </div>
    </div>
  );
}

function ArtifactAttachment({ message, board }: { message: ChatMessage; board: Board }) {
  const artifact = message.meta!.artifact!;
  const messages = board.notes.flatMap(n => n.messages).filter(m => m.meta?.artifact).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const latest = messages.at(-1)?.id === message.id;
  const [open, setOpen] = useState(latest && !!artifact.added);
  useEffect(() => { if (!latest) setOpen(false); }, [latest]);
  const stops = routeOf(board);
  return <details className="artifact-attachment" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>我的产出物 · {artifact.parts.length}/{stops.length} 块</summary>
    <table><tbody>{stops.map((s,i) => {
      const part = artifact.parts.find(p => p.stopId === s.id);
      return <tr key={s.id} className={part ? "" : "pending"}><td>{i + 1} · {part?.title || s.title}{part && <p>{part.content}</p>}</td><td>{part ? artifact.added === s.id ? "刚填入" : "已填" : `第 ${i + 1} 站`}</td></tr>;
    })}</tbody></table>
  </details>;
}
