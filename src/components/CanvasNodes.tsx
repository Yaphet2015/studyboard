import { CardSourceLine } from "./CardSourceLine";
import { WeightFooter, type WeightActions } from "./WeightFooter";
import { AgentEditProse, AgentEdits } from "./AgentEditProse";
import { Menu } from "./Drawer";
import {
  ANGLE_HINT,
  ANGLE_LABEL,
  DIG_ANGLES,
  type DigAngle,
} from "../model/angles";
import { useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Handle,
  NodeToolbar,
  Position,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import {
  ArrowRight,
  Check,
  MoreHorizontal,
  BookOpen,
  ChevronRight,
  Image,
  Layers3,
  MessageCircle,
  ChevronDown,
  PencilLine,
  Sparkles,
  StickyNote,
} from "lucide-react";
import type { CardHints, ConceptNode, SceneState } from "../shared/types";
import type { HintSide } from "../model/hints";
import { Seal } from "./Seal";
import { beatProgress } from "../model/next-step";
import { BorderBeam } from "./BorderBeam";
import { tip } from "./Tooltip";

export type CardData = {
  [key: string]: unknown;
  concept: ConceptNode;
  weightActions?: WeightActions;
  /** Hierarchical "§1.2" index shown top-right. */
  no?: string;
  topic?: string;
  createdAt?: string;
  scene?: SceneState;
  editing?: boolean;
  /** Part of a multi-select: the per-card toolbar steps aside for the multi bar. */
  multi?: boolean;
  linkMode?: boolean;
  dimmed?: boolean;
  /** The drawer is open on this card's note. */
  noteOpen?: boolean;
  onRename?: (id: string, title: string) => void;
  onEditDone?: () => void;
  onAddChild?: (id: string) => void;
  onAddSibling?: (id: string) => void;
  /** Roots only: grow upward (a broader parent) or sideways (another root). */
  onAddParent?: (id: string) => void;
  onAddRoot?: (id: string) => void;
  /** AI ghost hints for the '+' handles (only with a provider configured). */
  hints?: CardHints;
  onWantHints?: (id: string, on: boolean) => void;
  onHint?: (id: string, side: HintSide, title: string, angle?: DigAngle) => void;
  onPreviewAdd?: (id: string | null) => void;
  onScene?: (patch: Partial<SceneState>) => void;
  onNote?: (id: string) => void;
  onStatus?: (id: string, status: ConceptNode["status"]) => void;
  onStartEdit?: (id: string) => void;
  onAsk?: (id: string) => void;
  onExpand?: (id: string, angle?: DigAngle) => void;
  canExpand?: boolean;
  expandBusy?: boolean;
  generating?: boolean;
  /** Root only, while an AI board has no first level yet: the obvious next step. */
  onKickoff?: () => void;
  kickoffStarted?: boolean;
  /** Station number on the learning route (第 n 站). */
  station?: number;
  /** This card is the one next step: red outline + 下一步 label. */
  isNext?: boolean;
  /** 合起来讲 reached this station: it lights up. */
  lit?: boolean;
  /** A pending chat route edit would replace or remove this stop (shown before 应用). */
  preview?: "replace" | "remove";
  onStartNext?: () => void;
};
export type GhostData = { [key: string]: unknown; w: number };
export type CardNode = Node<CardData, "concept" | "root">;
export type GhostNode = Node<GhostData, "ghost">;
export type CanvasNode = CardNode | GhostNode;

function Ports({ linkMode }: { linkMode?: boolean }) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        id="t"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="b"
        isConnectable={false}
      />
      {linkMode && (
        <Handle
          type="source"
          position={Position.Right}
          id="link"
          className="link-handle"
        />
      )}
    </>
  );
}

/** Card title; double-click or F2 turns it into an input. */
function Title({ data, as: Tag }: { data: CardData; as: "h2" | "h3" }) {
  const n = data.concept;
  const [draft, setDraft] = useState(n.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(n.title), [n.title, data.editing]);
  useEffect(() => {
    if (!data.editing) return;
    // React Flow moves focus to the node wrapper on select; take it back.
    const t = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 30);
    return () => clearTimeout(t);
  }, [data.editing]);
  if (data.editing)
    return (
      <input
        ref={input}
        className="title-input nodrag nopan"
        aria-label="概念标题"
        value={draft}
        maxLength={160}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim()) data.onRename?.(n.id, draft.trim());
          data.onEditDone?.();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    );
  if (Tag === "h3") return <h3>{n.title}</h3>;
  // A bracketed aside in the root question gets its own quieter line.
  const text = data.topic ?? n.title;
  const m = text.match(/^(.+?)([（(].+[）)])$/);
  return m ? (
    <h2>
      {m[1]}
      <span className="sub">{m[2]}</span>
    </h2>
  ) : (
    <h2>{text}</h2>
  );
}

/** Hangs on the card the drawer is talking about. */
const NoteTab = () => (
  <span className="note-tab" aria-hidden="true">
    <StickyNote size={13} className="ico" />
    批注
  </span>
);

const HINT_LABEL: Record<HintSide, string> = {
  below: "加子概念",
  right: "加并列概念",
  above: "加更大的问题",
};

/** A faded AI suggestion beside a '+': clicking it grows the card in that direction. */
function GhostHint({ data, side }: { data: CardData; side: HintSide }) {
  const text = data.hints?.[side];
  if (!text || !data.onHint) return null;
  const label =
    side === "right" && data.concept.parentId === null
      ? "加并列的起点"
      : HINT_LABEL[side];
  const angle = data.hints?.angles?.[side];
  const more = side === "below" ? (data.hints?.more ?? []) : [];
  return (
    <>
      <GhostButton
        className={`ghost-hint ${side}`}
        label={label}
        text={text}
        angle={angle}
        onPick={() => data.onHint?.(data.concept.id, side, text, angle)}
      />
      {more.map((m, i) => (
        <GhostButton
          key={m.angle}
          className={`ghost-hint alt alt-${i + 1}`}
          label={label}
          text={m.text}
          angle={m.angle}
          onPick={() => data.onHint?.(data.concept.id, "below", m.text, m.angle)}
        />
      ))}
    </>
  );
}

function GhostButton({
  className,
  label,
  text,
  angle,
  onPick,
}: {
  className: string;
  label: string;
  text: string;
  angle?: DigAngle;
  onPick: () => void;
}) {
  // The angle tag is drawn by CSS from data-angle-label, so the button's text stays the title.
  return (
    <button
      className={`${className} nodrag nopan`}
      data-angle={angle}
      data-angle-label={angle ? ANGLE_LABEL[angle] : undefined}
      aria-label={`AI 提示 · ${label}${angle ? ` · ${ANGLE_LABEL[angle]}` : ""}：${text}`}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
    >
      <Sparkles size={11} className="ico" aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}

/**
 * Lazy hints: a card asks for its hints only after it has been hovered or selected for a
 * moment (App debounces; leaving cancels).
 */
function useHintAttention(data: CardData, selected: boolean) {
  const id = data.concept.id;
  const want = data.onWantHints;
  const hovered = useRef(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [controlsActive, setControlsActive] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!want) return;
    if (selected) want(id, true);
    else if (!hovered.current) want(id, false);
  }, [selected, want, id]);
  useEffect(() => () => want?.(id, false), [want, id]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  return {
    hintsOpen,
    controlsActive,
    onMouseEnter: () => {
      clearTimeout(hideTimer.current);
      setHintsOpen(true);
      hovered.current = true;
      want?.(id, true);
    },
    onMouseOver: (event: MouseEvent<HTMLElement>) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".plus, .ghost-hint")
      )
        setControlsActive(true);
    },
    onMouseLeave: () => {
      // Keep the controls clickable while the pointer crosses the gaps between them.
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setHintsOpen(false);
        setControlsActive(false);
      }, 300);
      hovered.current = false;
      if (!selected) want?.(id, false);
    },
  };
}

function AddHandles({ data }: { data: CardData }) {
  const id = data.concept.id;
  const isRoot = data.concept.parentId === null;
  return (
    <>
      <GhostHint data={data} side="below" />
      <GhostHint data={data} side="right" />
      {isRoot && <GhostHint data={data} side="above" />}
      {isRoot && data.onAddParent && (
        <button
          className="plus above nodrag nopan"
          {...tip("加更大的问题")}
          onClick={(e) => {
            e.stopPropagation();
            data.onAddParent?.(id);
          }}
        >
          +
        </button>
      )}
      <button
        className="plus below nodrag nopan"
        {...tip("加子概念", "Tab")}
        onMouseEnter={() => data.onPreviewAdd?.(id)}
        onMouseLeave={() => data.onPreviewAdd?.(null)}
        onClick={(e) => {
          e.stopPropagation();
          data.onAddChild?.(id);
        }}
      >
        +
      </button>
      {!isRoot ? (
        <button
          className="plus right nodrag nopan"
          {...tip("加并列概念", "Enter")}
          onClick={(e) => {
            e.stopPropagation();
            data.onAddSibling?.(id);
          }}
        >
          +
        </button>
      ) : (
        data.onAddRoot && (
          <button
            className="plus right nodrag nopan"
            {...tip("加并列的起点")}
            onClick={(e) => {
              e.stopPropagation();
              data.onAddRoot?.(id);
            }}
          >
            +
          </button>
        )
      )}
    </>
  );
}

const STATUS: [ConceptNode["status"], string][] = [
  ["unseen", "待探索"],
  ["exploring", "探索中"],
  ["explained", "我能解释"],
];
/**
 * Selection toolbar under the card. It carries an opaque paper halo so the tree
 * line leaving the card bottom passes *behind* it instead of through it.
 */
function SelectToolbar({
  data,
  visible,
}: {
  data: CardData;
  visible: boolean;
}) {
  const n = data.concept;
  const [digOpen, setDigOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!visible) {
      setDigOpen(false);
      setMoreOpen(false);
    }
  }, [visible]);
  return (
    <NodeToolbar
      isVisible={visible}
      position={Position.Bottom}
      offset={20}
      className="select-toolbar"
    >
      <button
        className="icon"
        {...tip("改标题", "F2")}
        onClick={() => data.onStartEdit?.(n.id)}
      >
        <PencilLine size={15} className="ico" />
      </button>
      {data.canExpand && (
        <span className="dig">
          <button
            className="icon"
            {...tip("再看一层")}
            disabled={data.expandBusy}
            onClick={() => data.onExpand?.(n.id)}
          >
            <Layers3 size={15} className="ico" />
          </button>
          <button
            className="icon caret"
            aria-label="往哪挖"
            aria-haspopup="menu"
            aria-expanded={digOpen}
            title="往哪挖"
            disabled={data.expandBusy}
            onClick={() => setDigOpen((o) => !o)}
          >
            <ChevronDown size={12} className="ico" />
          </button>
          {digOpen && (
            <Menu className="dig-menu" onClose={() => setDigOpen(false)}>
              <div className="dig-head">往哪挖</div>
              {DIG_ANGLES.map((a) => (
                <button
                  key={a}
                  className="it"
                  role="menuitem"
                  data-angle={a}
                  onClick={() => data.onExpand?.(n.id, a)}
                >
                  <span className="dig-name">{ANGLE_LABEL[a]}</span>
                  <span className="dig-sub">{ANGLE_HINT[a]}</span>
                </button>
              ))}
            </Menu>
          )}
        </span>
      )}
      <button
        className="icon accent"
        {...tip("问一问", "/")}
        onClick={() => data.onAsk?.(n.id)}
      >
        <Sparkles size={15} className="ico" />
      </button>
      <span className="more">
        <button
          className="icon"
          {...tip("更多操作")}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <MoreHorizontal size={15} className="ico" />
        </button>
        {moreOpen && (
          <Menu className="card-menu" onClose={() => setMoreOpen(false)}>
            {/* Mastery comes from the four beats; this is only a manual override. */}
            <div className="dig-head">手动标记掌握度</div>
            {STATUS.map(([s, label]) => (
              <button
                key={s}
                className="it"
                role="menuitemradio"
                aria-checked={n.status === s}
                onClick={() => {
                  data.onStatus?.(n.id, s);
                  setMoreOpen(false);
                }}
              >
                {n.status === s ? <Check size={14} className="ico" /> : <span className="ico-gap" />}
                {label}
              </button>
            ))}
          </Menu>
        )}
      </span>
    </NodeToolbar>
  );
}

/** The card face shows the first one or two sentences of the body. */
export function faceText(body: string): string {
  const parts = body.replace(/\s*\n+\s*/g, " ").match(/[^。！？!?]+[。！？!?]?/g) ?? [body];
  let out = parts[0] ?? "";
  if (parts[1] && [...out].length + [...parts[1]].length <= 70) out += parts[1];
  return out.trim();
}

export function ConceptCard({ data, selected }: NodeProps<CardNode>) {
  const n = data.concept;
  const edits = useContext(AgentEdits);
  // Stamp only when the status changes while mounted, not on first paint.
  const first = useRef(n.status);
  const animate = first.current !== n.status;
  const { hintsOpen, controlsActive, ...attention } = useHintAttention(
    data,
    !!selected,
  );
  function openNote(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    data.onNote?.(n.id);
  }
  return (
    <article
      {...attention}
      className={`card s-${n.status} ${selected || data.noteOpen ? "is-selected" : ""} ${animate ? "animate" : ""} ${data.dimmed ? "dimmed" : ""} ${data.lit ? "lit" : ""} ${data.preview ? `pv-${data.preview}` : ""} ${hintsOpen ? "hints-open" : ""} ${controlsActive ? "hint-controls-active" : ""}`}
      aria-busy={data.generating || undefined}
    >
      {data.generating && <BorderBeam />}
      {data.noteOpen && <NoteTab />}
      <Ports linkMode={data.linkMode} />
      {n.status === "explained" && data.station === undefined && <Seal light={n.seal === "probe"} />}
      {data.preview === "replace" && <span className="pv-tag">待替换</span>}
      {data.station !== undefined && data.preview !== "remove" && (
        <span className={`station ${data.isNext ? "next" : ""} ${n.status === "explained" ? "sealed" : ""}`} aria-label={`第 ${data.station} 站`}>
          {n.status !== "unseen" && <i className={`station-dot ${n.status === "explained" ? "mastered" : "read"}`} aria-label={n.status === "explained" ? "掌握" : "读过"} />}
          <span>第 {data.station} 站</span>
        </span>
      )}
      {data.isNext && <span className="next-tag">下一步</span>}
      <div className="card-heading">
        <Title data={data} as="h3" />
        {data.no && <span className="no">{data.no}</span>}
      </div>
      {/* Compact face: the first sentence or two of the prose; the drawer shows all of it. */}
      {(n.body || edits.get(n.id)?.after === n.body) && <AgentEditProse body={n.body} cardId={n.id} className="face-body" project={n.weight ? undefined : faceText} />}
      <CardSourceLine card={n} />
      {data.weightActions && <WeightFooter card={n} actions={data.weightActions} />}
      {!data.weightActions && data.isNext && data.onStartNext && (
        <button
          className="btn primary start-stop nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            data.onStartNext?.();
          }}
        >
          {n.beat ? "继续这一站" : "开始这一站"}
        </button>
      )}
      {!data.weightActions && data.station !== undefined && n.status !== "explained" && (n.beat || data.isNext) && (
        <span className="beat-line" aria-hidden="true">
          <i style={{ width: `${beatProgress(n) * 100}%` }} />
        </span>
      )}
      {(data.onNote || n.visual || n.hand) && (
        <div className="meta">
          {data.onNote && (
            <button className="chip-fig nodrag nopan" onClick={openNote}>
              <BookOpen size={13} className="ico" />
              查看全文
            </button>
          )}
          {n.visual && (
            <button
              className="chip-fig nodrag nopan"
              data-tip="在批注里看图示"
              onClick={openNote}
            >
              <Image size={13} className="ico" />
              含图示
            </button>
          )}
          {n.hand && <span className="hand">{n.hand}</span>}
        </div>
      )}
      {!data.linkMode && <AddHandles data={data} />}
      <SelectToolbar
        data={data}
        visible={!!selected && !data.editing && !data.multi}
      />
    </article>
  );
}

const dateLabel = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

export function RootCard({ data, selected }: NodeProps<CardNode>) {
  const n = data.concept;
  const [open, setOpen] = useState(false);

  const { hintsOpen, controlsActive, ...attention } = useHintAttention(
    data,
    !!selected,
  );
  return (
    <article
      {...attention}
      className={`origin ${selected || data.noteOpen ? "is-selected" : ""} ${hintsOpen ? "hints-open" : ""} ${controlsActive ? "hint-controls-active" : ""}`}
      aria-busy={data.generating || undefined}
    >
      {data.generating && <BorderBeam />}
      {data.noteOpen && <NoteTab />}
      <Ports linkMode={data.linkMode} />
      <div className="origin-head">
        <span className="eyebrow">起点 · 问题</span>
        <span className="date">{dateLabel(data.createdAt)}</span>
      </div>
      <Title data={data} as="h2" />
      {n.kind === "scene" && data.scene && (
        <>
          <button
            className="text-button nodrag nopan"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            {open ? "收起小实验" : "动手看一看 · 改一行 CSS"}
            <ChevronRight size={13} className={open ? "rot" : ""} />
          </button>
          {open && (
            <div className="scene-body nodrag nopan">
              <SceneExperiment
                scene={data.scene}
                onScene={(p) => data.onScene?.(p)}
                onNote={() => data.onNote?.(n.id)}
              />
            </div>
          )}
        </>
      )}
      {data.onKickoff && (
        <div className="kickoff nodrag nopan">
          <button
            className="btn kickoff-btn"
            onClick={(e) => {
              e.stopPropagation();
              data.onKickoff?.();
            }}
          >
            <Sparkles size={15} className="ico" />
            {data.kickoffStarted ? "继续：AI 带我开始" : "让 AI 带我开始"}
          </button>
          <span className="lab">
            AI 先问清你想做出什么，再排好路线，由你开始第一站。
          </span>
        </div>
      )}
      {!data.linkMode && <AddHandles data={data} />}
    </article>
  );
}

/** Insertion preview: a vermilion dashed slot. */
export function GhostCard({ data }: NodeProps<GhostNode>) {
  return <div className="ghost" style={{ width: data.w }} />;
}

export function SceneExperiment({
  scene: s,
  onScene,
  onNote,
}: {
  scene: SceneState;
  onScene: (patch: Partial<SceneState>) => void;
  onNote: () => void;
}) {
  const [tab, setTab] = useState<"experiment" | "explain">("experiment");
  return (
    <div className="scene">
      <div className="seg">
        <button
          className={tab === "experiment" ? "on" : ""}
          onClick={() => setTab("experiment")}
        >
          小实验
        </button>
        <button
          className={tab === "explain" ? "on" : ""}
          onClick={() => setTab("explain")}
        >
          我的理解
        </button>
      </div>
      {tab === "experiment" ? (
        <>
          <div className="experiment-row nodrag nopan">
            <div className="code-lab">
              <span className="tiny-label">试着改变这个盒子</span>
              <div className="css-line">
                <span>width</span>
                <strong>{s.width}px</strong>
              </div>
              <input
                aria-label="盒子宽度"
                type="range"
                min="110"
                max="230"
                step="10"
                value={s.width}
                onChange={(e) =>
                  onScene({
                    width: Number(e.target.value),
                    changed: "width",
                  })
                }
              />
              <div className="css-line">
                <span>background</span>
                <div className="swatches">
                  {["#789b8d", "#dca779", "#8e9ec4"].map((c) => (
                    <button
                      key={c}
                      aria-label={`颜色 ${c}`}
                      className={s.color === c ? "selected" : ""}
                      style={{ background: c }}
                      onClick={() => onScene({ color: c, changed: "color" })}
                    />
                  ))}
                </div>
              </div>
              <span className="code-comment">拖动宽度，再换个颜色</span>
            </div>
            <ArrowRight className="experiment-arrow" size={18} />
            <div className="browser-preview">
              <div className="browser-chrome">
                <i />
                <i />
                <i />
                <span>live preview</span>
              </div>
              <div className="preview-page">
                <div
                  className="preview-box"
                  style={{ width: s.width, background: s.color }}
                >
                  A little change.
                  <br />A different picture.
                </div>
                <div className="preview-follow">我会跟着盒子的高度移动 ↕</div>
              </div>
            </div>
          </div>
          <div className="pipeline nodrag nopan">
            <span className="pipeline-step">结构</span>
            <ChevronRight size={12} />
            <span className="pipeline-step">样式</span>
            <ChevronRight size={12} />
            <span
              className={`pipeline-step ${s.changed === "width" ? "lit layout" : ""}`}
            >
              布局 {s.changed === "width" && "↻"}
            </span>
            <ChevronRight size={12} />
            <span className={`pipeline-step ${s.changed ? "lit paint" : ""}`}>
              绘制 {s.changed && "↻"}
            </span>
            <span className="pipeline-caption">
              {s.changed === "width"
                ? "宽度改变 → 重新计算几何位置"
                : s.changed === "color"
                  ? "颜色改变 → 几何不变，更新绘制"
                  : "先预测：哪些步骤会重新发生？"}
            </span>
          </div>
          <input
            className="prediction-input nodrag nopan"
            aria-label="我的预测"
            placeholder="先猜一猜：改颜色与改宽度，区别在哪？（可跳过）"
            value={s.prediction}
            onChange={(e) => onScene({ prediction: e.target.value })}
          />
        </>
      ) : (
        <div className="explain-lab nodrag nopan">
          <span className="tiny-label">
            用自己的话，讲给一个刚接触网页的人听
          </span>
          <textarea
            aria-label="我的理解"
            placeholder="我认为改宽度会……因为……；而改颜色……"
            value={s.explanation}
            onChange={(e) => onScene({ explanation: e.target.value })}
          />
          <p>
            这段解释会留在你的白板。你可以把它放进批注，向 AI
            提问、找反例或修正地图。
          </p>
          <button className="subtle-button" onClick={() => onNote()}>
            <MessageCircle size={14} />
            带着解释提问
          </button>
        </div>
      )}
    </div>
  );
}
