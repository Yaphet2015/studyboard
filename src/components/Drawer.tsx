import { CardProse, StopBeats, type StudyProps } from "./StopBeats";
import { PlanEditor } from "./PlanEditor";
import type { BoardPlan } from "../shared/types";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  ChevronDown,
  Copy,
  Delete,
  Layers3,
  LoaderCircle,
  Locate,
  MessageSquareQuote,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  SquarePen,
  SquarePlus,
  X,
} from "lucide-react";
import type {
  ChatMessage,
  CanvasRun,
  ConceptNode,
  ContextReference,
  StickyNote,
} from "../shared/types";
import { CanvasRunProgress } from "./CanvasRunProgress";
import { StructuredVisual } from "./StructuredVisual";
import { displayMessage } from "../model/kickoff";
import { outlineOf, type OutlineItem } from "../model/answer";
import { AnswerBlocks } from "./AnswerBlocks";
import { ChatTurn, type ChatActions } from "./ChatTurn";
import { tip } from "./Tooltip";
import { sectionNumbers } from "../model/layout";
import { isQuestionRoot } from "../model/kickoff";
import { StreamStatus } from "./StreamStatus";

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const copy = (text: string) => void navigator.clipboard?.writeText(text);

/** Small popover menu: closes on Esc, on a click elsewhere, or after a pick. */
export function Menu({
  className = "",
  onClose,
  onDelete,
  children,
}: {
  className?: string;
  onClose: () => void;
  /** ⌫ inside the menu. */
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:enabled")?.focus();
    const down = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`menu ${className}`}
      role="menu"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        if (onDelete && (e.key === "Backspace" || e.key === "Delete")) {
          onClose();
          onDelete();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>(
              "button:enabled",
            ) ?? []),
          ];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          items[
            (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
          ]?.focus();
        }
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** The action row under one answer: split primary, copy, re-answer. */
/** The root's kickoff conversation: plan first, then the first level. */
export type KickoffProps = {
  onAccept: () => void;
  busy: boolean;
  planning?: boolean;
  plan?: BoardPlan;
  onPlanChange?: (plan: BoardPlan) => void;
  onPlanConfirm?: () => void;
  onReplan?: () => void;
};

function AnswerActs({
  message,
  outline,
  recommendLay,
  kickoff,
  selected,
  onLay,
  onLocate,
  placed,
  onPromote,
  onRedo,
}: {
  message: ChatMessage;
  outline: OutlineItem[];
  /** The first level is already on the canvas: locate it, never lay duplicates. */
  placed: boolean;
  onLocate: () => void;
  /** The answer has an outline and the anchor has no children yet. */
  recommendLay: boolean;
  kickoff?: KickoffProps;
  selected: () => string;
  onLay: () => void;
  onPromote: (text: string) => void;
  onRedo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Kickoff without an outline in the answer: AI drafts the first level.
  // The kickoff always goes through the learning plan, never the answer's own list.
  const lay = kickoff
    ? kickoff.onAccept
    : outline.length > 1 && !placed
      ? onLay
      : undefined;
  const planStep = !!kickoff && kickoff.plan?.status !== "confirmed";
  const primary = recommendLay || kickoff ? lay : undefined;
  return (
    <div className="acts">
      <span className="split">
        <button
          className="btn sm primary"
          disabled={kickoff?.busy || kickoff?.planning || (planStep && !!kickoff?.plan)}
          title={
            primary
              ? planStep
                ? "先拟一份学习计划，确认后再铺第一层"
                : outline.length > 1 && !kickoff
                ? `骨架 ${outline.length} 块铺成第一层`
                : "让 AI 拆出第一层"
              : "整段作为一张卡"
          }
          onClick={() => (primary ? primary() : onPromote(message.text))}
        >
          {kickoff?.busy || kickoff?.planning ? (
            <LoaderCircle size={15} className="ico spin" />
          ) : (
            <Plus size={15} className="ico" />
          )}
          {kickoff?.busy
            ? "正在拆出第一层…"
            : kickoff?.planning
              ? "正在拟定学习计划…"
              : planStep
                ? "拟定学习计划"
            : kickoff && primary
              ? "铺成第一层"
              : "把回答加进地图"}
        </button>
        <button
          className="btn sm primary caret"
          {...tip("更多加入方式")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={14} />
        </button>
        {open && (
          <Menu className="acts-menu" onClose={() => setOpen(false)}>
            {placed && outline.length > 1 ? (
              <button className="it" role="menuitem" onClick={onLocate}>
                <Locate size={16} className="ico" />
                <span>
                  已铺成第一层 · 在画布上定位
                  <span className="sub">第一层已经在画布上，不会重复添加</span>
                </span>
              </button>
            ) : (
              <button
                className="it"
                role="menuitem"
                disabled={!lay}
                onClick={() => lay?.()}
              >
                <Layers3 size={16} className="ico" />
                <span>
                  铺成第一层{recommendLay || kickoff ? "（推荐）" : ""}
                  <span className="sub">
                    {outline.length > 1
                      ? `骨架里的 ${outline.length} 块，各成一张卡`
                      : kickoff
                        ? "让 AI 按你的回答拆出来"
                        : "这条回答里没有骨架"}
                  </span>
                </span>
              </button>
            )}
            <button
              className="it"
              role="menuitem"
              onClick={() => onPromote(message.text)}
            >
              <SquarePlus size={16} className="ico" />
              整段作为一张卡
            </button>
            <button
              className="it"
              role="menuitem"
              disabled={!selected()}
              onClick={() => onPromote(selected())}
            >
              <MessageSquareQuote size={16} className="ico" />
              <span>
                只加选中的部分
                <span className="sub">先在回答里选中一句</span>
              </span>
            </button>
          </Menu>
        )}
      </span>
      <button
        className="ib"
        {...tip("复制这条回答")}
        onClick={() => copy(message.text)}
      >
        <Copy size={16} />
      </button>
      {onRedo && (
        <button className="ib" {...tip("重新回答")} onClick={onRedo}>
          <RotateCcw size={16} />
        </button>
      )}
    </div>
  );
}

/** AI conversations live in a right-hand drawer, attached to a card or free. */
export function Drawer({
  note,
  opening,
  anchor,
  anchorTitle,
  anchorHasChildren,
  pending,
  busy,
  canvasRun,
  error,
  onChange,
  onAsk,
  kickoff,
  onStop,
  onPromote,
  onLay,
  onLocate,
  onRetry,
  onRemove,
  onClose,
  nodes,
  onNewSession,
  onHistory,
  study,
  lead,
  chat,
}: {
  note: StickyNote;
  /** Reading a selected card keeps focus on the canvas for shortcuts. */
  opening: { autoFocus: boolean };
  /** The card this conversation hangs on; its full content renders here. */
  anchor?: ConceptNode;
  anchorTitle?: string;
  anchorHasChildren: boolean;
  refs: ContextReference[];
  pending?: string;
  busy?: boolean;
  canvasRun?: CanvasRun;
  error?: string;
  onChange: (patch: Partial<StickyNote>) => void;
  onAsk: (prompt: string) => boolean;
  /** Present while this is the root's kickoff conversation and the root has no children yet. */
  kickoff?: KickoffProps;
  onStop: () => void;
  onPromote: (text: string) => void;
  /** Lay items as unseen cards under the anchor; with messageId, that answer counts as laid. */
  onLay: (items: OutlineItem[], messageId?: string) => void;
  onLocate: () => void;
  /** Resend the last question after an error, without repeating it in the thread. */
  onRetry: () => void;
  /** Board cards, for each reference's level and status. */
  nodes: ConceptNode[];
  onRemove: () => void;
  onClose: () => void;
  onNewSession: () => void;
  onHistory: () => void;
  /** The four beats, when the anchor is a card the learner studies. */
  study?: StudyProps;
  /** The root's 摸底 or 合起来讲 panel, shown above the notes. */
  lead?: React.ReactNode;
  /** The post-probe chat's proposal handlers (v2). */
  chat?: ChatActions;
}) {
  const [prompt, setPrompt] = useState("");
  const [menu, setMenu] = useState(false);
  // Screen readers hear the streaming answer at most every 600ms.
  const [spoken, setSpoken] = useState("");
  const latest = useRef(pending);
  latest.current = pending;
  // When the current answer started, for the elapsed time beside 正在思考 / 正在回答.
  const [busySince, setBusySince] = useState(() => Date.now());
  useEffect(() => {
    if (busy) setBusySince(Date.now());
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpoken(latest.current ?? ""), 600);
    return () => clearInterval(t);
  }, [busy]);
  const [scrolled, setScrolled] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const onScroll = () => setScrolled((thread.current?.scrollTop ?? 0) > 4);
  const [sel, setSel] = useState<{ text: string; x: number; y: number }>();
  const root = useRef<HTMLElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Every opening returns to the thread; reading a card starts at its full text.
  useEffect(() => {
    if (opening.autoFocus) composer.current?.focus({ preventScroll: true });
    else {
      thread.current?.scrollTo({ top: 0 });
      setScrolled(false);
    }
  }, [opening]);
  /** Tick a 小练习 step; stored on the message so it survives reloads. */
  const toggleStep = (messageId: string, index: number) =>
    onChange({
      messages: note.messages.map((m) => {
        if (m.id !== messageId) return m;
        const checked = m.meta?.checked ?? [];
        return {
          ...m,
          meta: {
            ...m.meta,
            checked: checked.includes(index)
              ? checked.filter((c) => c !== index)
              : [...checked, index].sort((a, b) => a - b),
          },
        };
      }),
    });
  const answers = note.messages.filter((m) => m.role === "assistant");
  const lastAnswer = answers.at(-1);
  const lastQuestion = note.messages.filter((m) => m.role === "user").at(-1);
  const defaultTitle = kickoff
    ? "带我起步"
    : anchorTitle
      ? `关于「${anchorTitle}」`
      : "我的问题";
  const send = () => {
    if (!prompt.trim() || busy) return;
    if (onAsk(prompt.trim())) setPrompt("");
  };
  const selectedText = () => sel?.text ?? "";
  // Selecting text inside an answer floats a small ink toolbar above it.
  const onMouseUp = () => {
    const s = window.getSelection();
    const text = s?.toString().trim() ?? "";
    const box = root.current?.getBoundingClientRect();
    if (!s || !text || !box || s.rangeCount === 0) return setSel(undefined);
    const node = s.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    if (!el?.closest(".ans") || !root.current?.contains(el))
      return setSel(undefined);
    const r = s.getRangeAt(0).getBoundingClientRect();
    setSel({
      text,
      x: Math.min(
        Math.max(r.left + r.width / 2 - box.left, 120),
        box.width - 120,
      ),
      y: r.top - box.top - 8,
    });
  };
  useEffect(() => {
    if (!sel) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setSel(undefined);
    const down = (e: PointerEvent) =>
      !(e.target as Element).closest?.(".seltb") && setSel(undefined);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down);
    };
  }, [sel]);
  const conversation = () =>
    note.messages
      .map(
        (m) =>
          `${m.role === "user" ? "我" : "AI"}：${displayMessage(m.role, m.text)}`,
      )
      .join("\n\n");
  return (
    <aside
      ref={root}
      role="complementary"
      className="chrome drawer"
      aria-label={`批注：${note.title || defaultTitle}`}
      onMouseUp={onMouseUp}
      onKeyDown={(e) => {
        // Esc from anywhere in the drawer closes it (menus and the composer handle their own).
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
      <header className="dhead">
        <div className="t">
          <input
            ref={title}
            className="drawer-title"
            aria-label="批注标题"
            value={note.title}
            placeholder={defaultTitle}
            onChange={(e) => onChange({ title: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === "Escape")
                e.currentTarget.blur();
            }}
          />
          <div className="m">
            <span>批注</span>
            <span className="dot" />
            <span>
              挂在{" "}
              <button
                className="link"
                onClick={onLocate}
                data-tip="在画布上定位"
              >
                {anchor && !isQuestionRoot(nodes, anchor)
                  ? anchorTitle
                  : "起点问题"}
              </button>
            </span>
            {!!note.contextCards?.length && (
              <>
                <span className="dot" />
                <span className="extra" data-tip="这段对话另外带上的卡片">
                  +{note.contextCards.length} 张卡
                </span>
              </>
            )}
            <span className="dot" />
            <span>{note.messages.length} 条消息</span>
          </div>
        </div>
        <span className="menu-anchor">
          <button
            className={`ib ${menu ? "on" : ""}`}
            {...tip("更多操作")}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <Menu onClose={() => setMenu(false)} onDelete={onRemove}>
              <button
                className="it"
                role="menuitem"
                onClick={() => setTimeout(() => title.current?.select(), 0)}
              >
                <Pencil size={16} className="ico" />
                重命名
              </button>
              <button className="it" role="menuitem" onClick={onLocate}>
                <Locate size={16} className="ico" />
                在画布上定位
              </button>
              <button className="it" role="menuitem" onClick={onNewSession}>
                <SquarePen size={16} className="ico" />
                在这张卡上新开对话
              </button>
              <button className="it" role="menuitem" onClick={onHistory}>
                查看完整对话
              </button>
              <button
                className="it"
                role="menuitem"
                disabled={!note.messages.length}
                onClick={() => copy(conversation())}
              >
                <Copy size={16} className="ico" />
                复制整段对话
              </button>
              <div className="sepm" role="separator" />
              <button className="it danger" role="menuitem" onClick={onRemove}>
                <Delete size={16} className="ico" />
                删除这张批注
                <span className="kbd">⌫</span>
              </button>
            </Menu>
          )}
        </span>
        <button className="ib" {...tip("关闭", "Esc")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="rule-h" />
      <div className="thread" ref={thread} onScroll={onScroll}>
        {scrolled && <div className="fadeTop" aria-hidden="true" />}
        {anchor && (
          <section className="this-card" aria-label="这张卡">
            <span className="lab">
              {study?.station ? `第 ${study.station} 站 · ` : "这张卡 · "}
              {study ? "一站 4 拍" : "完整内容"}
            </span>
            <h2>{anchor.title}</h2>
            {study ? (
              <StopBeats card={anchor} study={study} />
            ) : (
              anchor.body && <CardProse body={anchor.body} cardId={anchor.id} />
            )}
            {anchor.visual && (!study || anchor.status === "explained" || (anchor.beat ?? "guess") !== "guess") && <StructuredVisual visual={anchor.visual} />}
          </section>
        )}
        {lead}
        {note.messages.map((m) => {
          if (m.role === "user")
            return (
              <div key={m.id} className="msg user bubble">
                {displayMessage(m.role, m.text)}
              </div>
            );
          if (m.meta?.chat && chat)
            return (
              <div key={m.id} className="msg assistant ans chat">
                <ChatTurn message={m} chat={chat} busy={!!busy} onCopy={() => copy(m.text)} />
              </div>
            );
          const outline = outlineOf(m.text);
          // Laid from this answer, or the anchor already has its first level.
          const placed = !!m.meta?.laid || anchorHasChildren;
          const layItems = () => onLay(outline, m.id);
          return (
            <div key={m.id} className="msg assistant ans">
              <div className="who">
                <span>AI</span>
                <span>{clock(m.createdAt)}</span>
              </div>
              <AnswerBlocks
                text={m.text}
                actions={{
                  laid: placed,
                  onLocate,
                  onLay: outline.length > 1 ? layItems : undefined,
                  // “+” on one row: just that item, without marking the answer laid.
                  onAddItem: (item) => onLay([item]),
                  checked: m.meta?.checked,
                  onToggleStep: (i) => toggleStep(m.id, i),
                  onAnswerCheck: (text) => onAsk(text),
                }}
              />
              {!busy && (
                <AnswerActs
                  message={m}
                  outline={outline}
                  recommendLay={outline.length > 1 && !placed}
                  placed={placed}
                  onLocate={onLocate}
                  kickoff={m === lastAnswer ? kickoff : undefined}
                  selected={selectedText}
                  onLay={layItems}
                  onPromote={onPromote}
                  onRedo={
                    m === lastAnswer && lastQuestion
                      ? () => onAsk(lastQuestion.text)
                      : undefined
                  }
                />
              )}
            </div>
          );
        })}
        {!note.messages.length && !lead && !busy && !canvasRun && (
          <p className="thread-empty">对这张卡有疑问？直接问</p>
        )}
        {canvasRun && (
          <div
            className="canvas-drawer-progress"
            role="status"
            aria-live="polite"
          >
            <CanvasRunProgress run={canvasRun} />
          </div>
        )}
        {busy && (
          <div
            className="msg assistant ans streaming"
            aria-hidden={!!pending}
            aria-busy="true"
          >
            <div className="who">
              <span>AI</span>
              <StreamStatus
                phase={pending ? "answering" : "thinking"}
                startedAt={busySince}
              />
            </div>
            {pending && (
              <>
                <AnswerBlocks text={pending} streaming />
                <span className="streaming-caret" aria-hidden="true" />
              </>
            )}
          </div>
        )}
        {kickoff && (kickoff.plan || kickoff.planning) && (
          <PlanEditor
            plan={kickoff.plan}
            planning={!!kickoff.planning}
            busy={kickoff.busy}
            onChange={(p) => kickoff.onPlanChange?.(p)}
            onConfirm={() => kickoff.onPlanConfirm?.()}
            onReplan={() => kickoff.onReplan?.()}
          />
        )}
        {kickoff && lastAnswer && !busy && !kickoff.plan && !kickoff.planning && (
          <span className="lab kickoff-tip">
            先在下面回答它的问题，拆得会更贴合你；也可以直接拟定学习计划，确认前都能修改。
          </span>
        )}
        <div className="fadeBot" aria-hidden="true" />
      </div>
      {sel && (
        <div
          className="seltb"
          role="toolbar"
          aria-label="选中的文字"
          style={{ left: sel.x, top: sel.y }}
        >
          <button
            onClick={() => {
              onPromote(sel.text);
              setSel(undefined);
            }}
          >
            <Plus size={14} /> 加成卡片
          </button>
          <button
            onClick={() => {
              setPrompt(`> ${sel.text}\n${prompt}`);
              setSel(undefined);
              setTimeout(() => composer.current?.focus(), 0);
            }}
          >
            追问这句
          </button>
          <button
            onClick={() => {
              copy(sel.text);
              setSel(undefined);
            }}
          >
            复制
          </button>
        </div>
      )}
      <footer
        className={`composer ${error && !busy ? "failed" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) composer.current?.focus();
        }}
      >
        {error && !busy && (
          <div className="composer-error" role="alert">
            <AlertCircle size={15} className="ico" />
            <span>{error} 问题没有丢，可以重试。</span>
          </div>
        )}
        <textarea
          ref={composer}
          aria-label="向 AI 提问"
          placeholder={
            lastAnswer?.meta?.chat
              ? lastAnswer.meta.proposal?.state === "pending"
                ? lastAnswer.meta.proposal.type === "startStop"
                  ? "或者先问点别的…"
                  : "继续说…"
                : lastAnswer.meta.proposal
                  ? "继续说…"
                  : "继续问…"
              : answers.some((m) => /检查/.test(m.text))
              ? "继续追问，或回答上面的检查题…"
              : "继续追问…"
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              if (busy) onStop();
              else onClose();
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="row">
          <span className="grow" />
          <span className="kbd hint-kbd">
            {busy ? "Esc 停止" : prompt.trim() ? "⇧↵ 换行" : "↵ 发送"}
          </span>
          {busy ? (
            <button className="send stop" {...tip("停止回答")} onClick={onStop}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : error && !prompt.trim() && lastQuestion ? (
            <button className="btn sm retry" onClick={onRetry}>
              <RotateCcw size={14} className="ico" />
              重试
            </button>
          ) : (
            <button
              className={`send ${prompt.trim() ? "ready" : ""}`}
              {...tip("发送提问", "↵")}
              disabled={!prompt.trim()}
              onClick={send}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}
