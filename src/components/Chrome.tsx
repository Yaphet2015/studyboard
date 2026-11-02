import { cardMastered } from "../model/progress";
import { useEffect, useMemo, useState } from "react";
import {
  MiniMap,
  useEdges,
  useReactFlow,
  useViewport,
  type MiniMapNodeProps,
} from "@xyflow/react";
import {
  Crosshair,
  Hand,
  Link2,
  Minus,
  MousePointer2,
  Plus,
  Scan,
  ListTree,
  Sparkles,
  SquarePen,
  StickyNote,
} from "lucide-react";
import type { BoardSummary, ConceptNode } from "../shared/types";
import { MOD } from "../model/shortcuts";
import { tip } from "./Tooltip";
import {
  TreeEdge,
  SeqEdge,
  type TreeEdgeType,
  type SeqEdgeType,
} from "./TreeEdge";
import { CrossEdge, type CrossEdgeType } from "./CrossEdge";

export function Palette({
  boards,
  footer,
  currentId,
  onPick,
  onNew,
  onWalkthrough,
  onSettings,
  onClose,
}: {
  boards: BoardSummary[];
  footer?: string;
  currentId?: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onWalkthrough: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const items = useMemo(
    () => [
      ...boards
        .filter((b) => b.title.toLowerCase().includes(q.toLowerCase()))
        .map((b) => ({
          key: b.id,
          label: b.title,
          hint: b.kind === "walkthrough" ? "内置演练" : "我的探索",
          run: () => onPick(b.id),
          current: b.id === currentId,
        })),
      {
        key: "+new",
        label: q.trim() ? `新的问题：${q.trim()}` : "新的问题…",
        hint: "⌘N",
        run: onNew,
        current: false,
      },
      {
        key: "+walk",
        label: "浏览器如何把代码变成画面？",
        hint: "内置演练",
        run: onWalkthrough,
        current: false,
      },
      {
        key: "+ai",
        label: "设置",
        hint: `${MOD}.`,
        run: onSettings,
        current: false,
      },
    ],
    [boards, q, currentId, onPick, onNew, onWalkthrough, onSettings],
  );
  useEffect(() => setCursor(0), [q]);
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section className="chrome palette" role="dialog" aria-label="切换地图">
        <input
          autoFocus
          placeholder="找一张地图，或输入新问题…"
          aria-label="搜索地图"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown")
              setCursor((c) => Math.min(items.length - 1, c + 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
            else if (e.key === "Enter") items[cursor]?.run();
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
          }}
        />
        <ul>
          {items.map((it, i) => (
            <li key={it.key}>
              <button
                className={`${i === cursor ? "cursor" : ""} ${it.current ? "current" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={it.run}
              >
                <span>{it.label}</span>
                <small className="lab">{it.hint}</small>
              </button>
            </li>
          ))}
        </ul>
        {footer && <p className="lab palette-foot">{footer}</p>}
      </section>
    </div>
  );
}

export function Progress({ nodes, known }: { nodes: ConceptNode[]; known?: Set<string> }) {
  const concepts = nodes.filter((n) => n.parentId !== null);
  // Weighted routes: 已会 (摸底) is counted apart from 掌握 and never as a sealed segment.
  const weighted = !!known && concepts.some((n) => known.has(n.id));
  const stateOf = (n: ConceptNode) =>
    weighted ? (known!.has(n.id) ? "known" : cardMastered(n) ? "explained" : n.status === "unseen" ? "unseen" : "exploring") : n.status;
  const done = concepts.filter((n) => stateOf(n) === "explained").length;
  const knownCount = weighted ? concepts.filter((n) => known!.has(n.id)).length : 0;
  return (
    <div className="chrome progress" title={knownCount ? "● 掌握　○ 读过　已会（摸底）" : undefined}>
      <span className="lab">理解进度</span>
      {concepts.length > 16 ? (
        // Many concepts: one continuous bar, filled by share of each state.
        <span className="bar long" aria-hidden="true">
          {(["explained", "known", "exploring", "unseen"] as const).map((st) => {
            const k = concepts.filter((n) => stateOf(n) === st).length;
            return k ? (
              <i key={st} className={`s-${st}`} style={{ flexGrow: k }} />
            ) : null;
          })}
        </span>
      ) : (
        <span className="bar" aria-hidden="true">
          {concepts.map((n) => (
            <i key={n.id} className={`s-${stateOf(n)}`} />
          ))}
        </span>
      )}
      <span
        className="count"
        aria-label={`${concepts.length} 个概念里讲清楚了 ${done} 个${knownCount ? `，摸底已会 ${knownCount} 个` : ""}`}
      >
        {knownCount ? `掌握 ${done} · 已会 ${knownCount} ` : null}
        <b>
          {knownCount ? `/ ${concepts.length}` : `${done} / ${concepts.length}`}
        </b>
      </span>
    </div>
  );
}

export type Tool = "select" | "hand" | "link";
export function Dock({
  tool,
  setTool,
  onAddConcept,
  onNote,
  onAsk,
  onStudy,
  canStudy,
  onOrganize,
  organizeDisabled,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  onAddConcept: () => void;
  onNote: () => void;
  onAsk: () => void;
  onStudy: () => void;
  canStudy: boolean;
  onOrganize: () => void;
  organizeDisabled: boolean;
}) {
  const b = (t: Tool, label: string, key: string, icon: React.ReactNode) => (
    <button
      className={`b ${tool === t ? "on" : ""}`}
      {...tip(label, key)}
      aria-pressed={tool === t}
      onClick={() => setTool(t)}
    >
      {icon}
    </button>
  );
  return (
    <nav className="chrome dock" aria-label="工具">
      {b("select", "选择", "V", <MousePointer2 size={15} className="ico" />)}
      {b("hand", "平移", "H", <Hand size={15} className="ico" />)}
      <span className="sep" />
      <button className="b" {...tip("加概念", "Tab")} onClick={onAddConcept}>
        <SquarePen size={15} className="ico" />
      </button>
      {b("link", "连线", "L", <Link2 size={15} className="ico" />)}
      <button className="b" {...tip("批注", "N")} onClick={onNote}>
        <StickyNote size={15} className="ico" />
      </button>
      <span className="sep" />
      <button className="ask" onClick={onAsk}>
        <Sparkles size={15} className="ico" />
        问一问 <kbd>/</kbd>
      </button>
      <button
        className="ask"
        onClick={onOrganize}
        disabled={organizeDisabled}
        {...tip("以起点为核心，校对全部卡片的层级、关系和内容")}
        aria-label="整理画布"
      >
        <ListTree size={15} className="ico" />
        整理画布
      </button>
      <button className="ask" onClick={onStudy} disabled={!canStudy}>
        <Scan size={15} className="ico" />
        走一遍 <kbd>F</kbd>
      </button>
    </nav>
  );
}

// MiniMap only exposes a node renderer. Draw each incoming edge with its target
// so it shares the map's SVG coordinates and follows the measured node positions.
function MiniNode({ id, x, y, width, height, className }: MiniMapNodeProps) {
  const edges = useEdges<TreeEdgeType | SeqEdgeType | CrossEdgeType>();
  return (
    <>
      <g
        className="mini-edges"
        data-node-id={id}
        pointerEvents="none"
        aria-hidden="true"
      >
        {edges
          .filter((edge) => edge.target === id && !edge.hidden)
          .map((edge) => {
            switch (edge.type) {
              case "tree":
                return <TreeEdge key={edge.id} {...edge} />;
              case "seq":
                return <SeqEdge key={edge.id} {...edge} />;
              case "cross":
                return <CrossEdge key={edge.id} {...edge} />;
              default:
                return null;
            }
          })}
      </g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        className={`mini-node ${className ?? ""}`}
      />
    </>
  );
}

/**
 * Zoom controls, bottom-right, always visible. The minimap floats above them only while the
 * canvas is being panned (or the hand tool is on) and fades out shortly after.
 */
export function MapUnit({ showMap }: { showMap: boolean }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  // Keep the map up while the learner drags inside it.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) return;
    const up = () => setHeld(false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [held]);
  const visible = showMap || held;
  return (
    <div className="map-unit">
      <div
        className={`chrome minimap-card ${visible ? "on" : ""}`}
        aria-hidden={!visible}
        data-visible={visible}
        onPointerDown={() => setHeld(true)}
      >
        <MiniMap
          pannable
          zoomable
          position="top-left"
          className="atlas-minimap"
          // Match the CSS box so the viewBox has the same aspect ratio; otherwise the
          // mask's outer sub-path shows in the letterbox as a second frame.
          style={{ width: 194, height: 120 }}
          nodeComponent={MiniNode}
          nodeClassName={(n) =>
            n.type === "ghost"
              ? "mini-ghost"
              : `${n.type === "root" ? "root" : "concept"} s-${(n.data as { concept?: ConceptNode }).concept?.status ?? "exploring"}`
          }
          maskColor="transparent"
          maskStrokeColor="var(--accent)"
          maskStrokeWidth={1.25}
          bgColor="transparent"
        />
      </div>
      <div className="chrome zoom">
        <button
          {...tip("缩小")}
          onClick={() => flow.zoomOut({ duration: 200 })}
        >
          <Minus size={15} className="ico" />
        </button>
        <span className="lab">{Math.round(zoom * 100)}%</span>
        <button {...tip("放大")} onClick={() => flow.zoomIn({ duration: 200 })}>
          <Plus size={15} className="ico" />
        </button>
        <span className="sep" />
        <button
          {...tip("查看全图", "0")}
          onClick={() => flow.fitView({ padding: 0.16, duration: 400 })}
        >
          <Crosshair size={15} className="ico" />
        </button>
      </div>
    </div>
  );
}
