import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronRight,
  ChevronDown,
  Compass,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import type { BoardSummary } from "../shared/types";
import { api } from "../api";
import {
  listSessions,
  visibleSessions,
  filterSessions,
  sessionClock,
  type SessionEntry,
} from "../model/sessions";
import { MOD } from "../model/shortcuts";
import { tip } from "./Tooltip";

const SESSION_VIEW_KEY = "studyboard.sidebar.sessions.v1";

export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

type WorkspaceSidebarProps = {
  boards: BoardSummary[];
  currentId: string;
  collapsed: boolean;
  switchingId: string | null;
  width: number;
  onWidthChange: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
  onToggle: () => void;
  onPick: (id: string) => void;
  onArchive: (id: string) => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
  sessions: SessionEntry[];
  currentSessionId?: string;
  onOpenSession: (boardId: string, sessionId: string) => Promise<void>;
  onNewSession: () => void;
};

type BoardGroupProps = {
  board: BoardSummary;
  current: boolean;
  collapsed: boolean;
  switchingId: string | null;
  sessions: SessionEntry[];
  currentSessionId?: string;
  onPick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenSession: (sessionId: string) => Promise<void>;
  onNewSession: () => void;
};

type SessionLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: SessionEntry[] };

function BoardGroup({
  board,
  current,
  collapsed,
  switchingId,
  sessions,
  currentSessionId,
  onPick,
  onContextMenu,
  onOpenSession,
  onNewSession,
}: BoardGroupProps): ReactElement {
  const [view, setView] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem(SESSION_VIEW_KEY) ?? "{}")[
          board.id
        ] ?? { open: false, all: false }
      );
    } catch {
      return { open: false, all: false };
    }
  });
  const expanded = view.open === true;
  function updateView(patch: { open?: boolean; all?: boolean }): void {
    const next = { ...view, ...patch };
    setView(next);
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_VIEW_KEY) ?? "{}");
      localStorage.setItem(
        SESSION_VIEW_KEY,
        JSON.stringify({ ...saved, [board.id]: next }),
      );
    } catch {
      /* Storage can be unavailable. */
    }
  }
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const cache = useRef<{
    stamp: string;
    retry: number;
    entries: SessionEntry[];
  } | null>(null);
  useEffect(() => {
    if (expanded && currentSessionId && current)
      activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded, currentSessionId, current]);
  async function open(id: string): Promise<void> {
    if (opening || switchingId) return;
    setOpening(id);
    setOpenError(null);
    try {
      await onOpenSession(id);
      updateView({ open: true });
    } catch {
      setOpenError(id);
    } finally {
      setOpening(null);
    }
  }
  const [savedSessions, setSavedSessions] = useState<SessionLoadState>({
    status: "loading",
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (current || !expanded || collapsed) return;
    if (
      cache.current?.stamp === board.updatedAt &&
      cache.current.retry === retry
    ) {
      setSavedSessions({ status: "ready", entries: cache.current.entries });
      return;
    }
    let cancelled = false;
    setSavedSessions({ status: "loading" });
    void api.loadBoard(board.id).then(
      (value) => {
        if (cancelled) return;
        if (value) {
          const entries = listSessions(value);
          cache.current = { stamp: board.updatedAt, retry, entries };
          setSavedSessions({ status: "ready", entries });
        } else {
          setSavedSessions({ status: "error", message: "画布不存在" });
        }
      },
      () => {
        if (!cancelled)
          setSavedSessions({ status: "error", message: "无法读取对话" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [board.id, board.updatedAt, current, expanded, collapsed, retry]);
  useEffect(() => {
    if (current)
      cache.current = { stamp: board.updatedAt, retry, entries: sessions };
  }, [current, board.updatedAt, retry, sessions]);
  const sessionState: SessionLoadState = current
    ? { status: "ready", entries: sessions }
    : savedSessions;
  const disabled = switchingId !== null || opening !== null;
  const activeSessionId = current ? currentSessionId : undefined;
  const count = current
    ? sessions.length
    : sessionState.status === "ready"
      ? sessionState.entries.length
      : board.sessionCount;
  const filtered =
    sessionState.status === "ready"
      ? filterSessions(sessionState.entries, query)
      : [];
  const { rows, hidden } = visibleSessions(
    filtered,
    activeSessionId,
    view.all || !!query.trim(),
  );
  const disclosureLabel = `${expanded ? "收起" : "展开"}对话（${count ?? "未知"}）`;
  let sessionItems: ReactNode;
  if (sessionState.status === "error") {
    sessionItems = (
      <li className="workspace-empty" role="alert">
        无法读取对话 ·
        <button onClick={() => setRetry((value) => value + 1)}>重试</button>
      </li>
    );
  } else if (sessionState.status === "loading") {
    sessionItems = (
      <li role="status">
        <div className="workspace-empty">正在读取对话…</div>
        {Array.from({ length: Math.min(count ?? 3, 3) }, (_, i) => (
          <div
            className="workspace-session-skeleton"
            aria-hidden="true"
            key={i}
          >
            <i />
            <i />
          </div>
        ))}
      </li>
    );
  } else if (!sessionState.entries.length) {
    sessionItems = <li className="workspace-empty">还没有对话</li>;
  } else {
    sessionItems = rows.length ? (
      rows.map((session) => (
        <li key={session.id} role="none">
          <button
            ref={session.id === activeSessionId ? activeRef : undefined}
            role="treeitem"
            className="workspace-session"
            title={`${session.title} · ${session.anchorTitle} · ${sessionClock(session.time)}`}
            aria-current={session.id === activeSessionId ? "page" : undefined}
            aria-busy={opening === session.id}
            disabled={disabled}
            onClick={() => void open(session.id)}
          >
            {opening === session.id && (
              <span aria-hidden="true" className="workspace-session-spinner spin" />
            )}
            <span className="workspace-session-title">{session.title}</span>
            <span className="workspace-session-meta">
              <span>{session.anchorTitle || "自由批注"}</span>
              <time>· {sessionClock(session.time)}</time>
            </span>
          </button>
          {openError === session.id && (
            <div
              className="workspace-empty workspace-session-error"
              role="alert"
            >
              无法打开 ·{" "}
              <button onClick={() => void open(session.id)}>重试</button>
            </div>
          )}
        </li>
      ))
    ) : (
      <li className="workspace-empty">没有匹配的对话</li>
    );
  }
  return (
    <li
      role="treeitem"
      aria-label={board.title}
      aria-current={current ? "true" : undefined}
      aria-expanded={collapsed ? undefined : expanded}
      onKeyDown={(e) => {
        if (
          e.target instanceof HTMLInputElement ||
          (e.target as HTMLElement).closest(".workspace-sessions")
        )
          return;
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          updateView({ open: e.key === "ArrowRight" });
        }
      }}
    >
      <div
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) onPick();
        }}
        className={`workspace-board-row ${current ? "is-current" : ""} ${count ? "has-sessions" : ""}`}
      >
        {!collapsed && (
          <button
            className={`workspace-disclosure ${count === 0 ? "is-empty" : ""}`}
            aria-label={disclosureLabel}
            aria-expanded={expanded}
            aria-controls={`sessions-${board.id}`}
            onClick={() => updateView({ open: !expanded })}
          >
            <ChevronRight size={16} />
          </button>
        )}
        <button
          className={`workspace-board ${board.done ? "is-done" : ""}`}
          aria-label={board.title}
          title={board.title}
          data-tip={collapsed ? board.title : undefined}
          aria-current={current ? "page" : undefined}
          disabled={disabled}
          onClick={onPick}
          onContextMenu={onContextMenu}
        >
          {collapsed ? (
            <>
              {switchingId === board.id ? (
                <LoaderCircle size={14} className="ico spin" />
              ) : (
                <span className="workspace-initial" aria-hidden="true">
                  {Array.from(board.title)[0]}
                </span>
              )}
              {!!board.total && (
                <i
                  className="workspace-rail-bar"
                  aria-hidden="true"
                  style={{
                    ["--p" as string]: `${Math.round(((board.sealed ?? 0) / board.total) * 100)}%`,
                  }}
                />
              )}
            </>
          ) : (
            <>
              <span className="workspace-copy workspace-board-title">
                {board.title}
              </span>
              <span className="workspace-meta">
                {board.done ? (
                  <span className="workspace-done">
                    <span aria-hidden="true">A</span> 全部讲通
                  </span>
                ) : board.total ? (
                  <>
                    <Segments sealed={board.sealed ?? 0} total={board.total} />
                    <span className="workspace-count">
                      {board.sealed ?? 0}/{board.total}
                    </span>
                  </>
                ) : (
                  <span className="workspace-count">还没有卡片</span>
                )}
                <span className="workspace-date">
                  {switchingId === board.id ? (
                    <LoaderCircle size={12} className="ico spin" />
                  ) : (
                    relativeDay(board.updatedAt)
                  )}
                </span>
              </span>
            </>
          )}
        </button>
        {!collapsed && !!count && (
          <button
            className={`workspace-session-count ${current && !!currentSessionId && !expanded ? "is-open" : ""}`}
            aria-label={disclosureLabel}
            aria-expanded={expanded}
            aria-controls={`sessions-${board.id}`}
            onClick={() => updateView({ open: !expanded })}
          >
            <MessageSquare size={12} />
            <span>{count}</span>
          </button>
        )}
      </div>
      {!collapsed && (
        <ul
          id={`sessions-${board.id}`}
          role="group"
          className="workspace-sessions"
          aria-label={`${board.title}的对话`}
          hidden={!expanded}
        >
          {sessionState.status === "ready" &&
            sessionState.entries.length > 20 && (
              <li>
                <label className="workspace-session-search">
                  <Search size={13} />
                  <input
                    aria-label={`搜索${board.title}的对话`}
                    placeholder="搜索对话"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </li>
            )}
          {sessionItems}
          {hidden > 0 && (
            <li>
              <button
                className="workspace-session-more"
                onClick={() => updateView({ all: true })}
              >
                <ChevronDown size={14} />
                展开更多 · 还有 {hidden} 个
              </button>
            </li>
          )}
          {current && (
            <li>
              <button
                className="workspace-session workspace-new-session"
                disabled={disabled}
                onClick={onNewSession}
              >
                <Plus size={13} className="ico" />
                新对话
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** One segment per card (a long list becomes one proportional bar); sealed segments are filled. */
function Segments({
  sealed,
  total,
}: {
  sealed: number;
  total: number;
}): ReactElement {
  if (total > 12)
    return (
      <span className="workspace-segs long" aria-hidden="true">
        <i className="on" style={{ flexGrow: sealed }} />
        <i style={{ flexGrow: total - sealed }} />
      </span>
    );
  return (
    <span className="workspace-segs" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < sealed ? "on" : ""} />
      ))}
    </span>
  );
}

/** 今天 / 昨天 / 10月15日, in local time. */
export function relativeDay(iso: string, today = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Each entry selects the whole knowledge canvas and its conversations. */
export function WorkspaceSidebar({
  boards,
  currentId,
  collapsed,
  switchingId,
  width,
  onWidthChange,
  onResizingChange,
  onToggle,
  onPick,
  onArchive,
  onNew,
  onSearch,
  onSettings,
  sessions,
  currentSessionId,
  onOpenSession,
  onNewSession,
}: WorkspaceSidebarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    function dismiss(event: Event): void {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      setMenu(null);
    }
    function escape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      menu?.trigger.focus();
    }
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [menu]);
  const resizeOrigin = useRef<{ x: number; width: number } | null>(null);
  function stopResizing(): void {
    if (!resizeOrigin.current) return;
    resizeOrigin.current = null;
    onResizingChange(false);
  }
  useEffect(() => {
    if (collapsed) {
      resizeOrigin.current = null;
      onResizingChange(false);
    }
    return () => onResizingChange(false);
  }, [collapsed, onResizingChange]);
  useEffect(() => {
    if (!boards.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_VIEW_KEY) ?? "{}");
      for (const id of Object.keys(saved))
        if (!boards.some((b) => b.id === id)) delete saved[id];
      localStorage.setItem(SESSION_VIEW_KEY, JSON.stringify(saved));
    } catch {
      /* Storage can be unavailable. */
    }
  }, [boards]);
  const search = query.trim().toLocaleLowerCase();
  const visibleBoards = collapsed
    ? boards
    : boards.filter((b) => b.title.toLocaleLowerCase().includes(search));

  const row = (b: BoardSummary): ReactElement => (
    <BoardGroup
      key={b.id}
      board={b}
      current={b.id === currentId}
      collapsed={collapsed}
      switchingId={switchingId}
      sessions={sessions}
      currentSessionId={currentSessionId}
      onPick={() => onPick(b.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        if (switchingId !== null) return;
        const box = event.currentTarget.getBoundingClientRect();
        setMenu({
          id: b.id,
          x: Math.max(
            8,
            Math.min(event.clientX || box.left, window.innerWidth - 184),
          ),
          y: Math.max(
            8,
            Math.min(event.clientY || box.bottom, window.innerHeight - 56),
          ),
          trigger: event.currentTarget,
        });
      }}
      onOpenSession={(id) => onOpenSession(b.id, id)}
      onNewSession={onNewSession}
    />
  );
  const groups = [
    {
      key: "active",
      label: "进行中",
      items: visibleBoards.filter((b) => !b.done),
    },
    {
      key: "done",
      label: "已完成",
      items: visibleBoards.filter((b) => b.done),
    },
  ];

  return (
    <aside
      className="workspace-sidebar"
      aria-label="学习空间"
      onKeyDown={(e) => {
        if (e.key === "Tab" || e.key === "Enter") e.stopPropagation();
      }}
    >
      <header className="workspace-header">
        <span className="workspace-brand">
          <Compass size={23} strokeWidth={1.5} className="ico" />
          <span className="workspace-copy">Studyboard</span>
        </span>
        <button
          className="workspace-icon workspace-new"
          {...tip("新建画布", `${MOD}N`)}
          onClick={onNew}
          disabled={switchingId !== null}
        >
          <Plus size={17} />
        </button>
        <button
          className="workspace-toggle"
          {...tip(collapsed ? "展开左侧边栏" : "收起左侧边栏", `${MOD}\\`)}
          aria-expanded={!collapsed}
          aria-controls="workspace-navigation"
          onClick={onToggle}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} />
          ) : (
            <PanelLeftClose size={18} />
          )}
        </button>
      </header>
      <div className="workspace-actions">
        {collapsed ? (
          <button
            className="workspace-icon"
            {...tip("搜索画布与卡片", `${MOD}K`)}
            onClick={onSearch}
          >
            <Search size={15} strokeWidth={2} />
          </button>
        ) : (
          <label className="workspace-search">
            <Search size={15} strokeWidth={2} className="ico" />
            <input
              aria-label="搜索知识画布"
              placeholder="搜索画布…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            <kbd
              title="搜索画布与卡片"
              onMouseDown={(e) => {
                e.preventDefault();
                onSearch();
              }}
            >
              {MOD} K
            </kbd>
          </label>
        )}
      </div>
      <nav
        id="workspace-navigation"
        className="workspace-navigation"
        aria-label="知识画布"
        onKeyDown={(e) => {
          if (
            e.target instanceof HTMLInputElement ||
            !["ArrowUp", "ArrowDown"].includes(e.key)
          )
            return;
          const items = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".workspace-board, .workspace-session, .workspace-session-more, .workspace-empty button",
            ),
          ).filter((el) => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length > 0);
          const index = items.indexOf(e.target as HTMLButtonElement);
          if (index < 0) return;
          e.preventDefault();
          e.stopPropagation();
          items[
            Math.max(
              0,
              Math.min(
                items.length - 1,
                index + (e.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ]?.focus();
        }}
        aria-busy={switchingId !== null}
      >
        <div className="workspace-board-list" role="tree" aria-label="知识画布">
          {!boards.length && !collapsed ? (
            <p className="workspace-start">提一个问题，开始第一张画布</p>
          ) : (
            groups.map((g) =>
              g.items.length ? (
                <section
                  key={g.key}
                  className="workspace-group"
                  aria-label={g.label}
                >
                  {!collapsed && (
                    <h2 className="workspace-section">
                      {g.label} <span>{g.items.length}</span>
                    </h2>
                  )}
                  <ul>{g.items.map(row)}</ul>
                </section>
              ) : null,
            )
          )}
        </div>
        {!!boards.length && !visibleBoards.length && (
          <p className="workspace-empty">没有找到画布，换个词试试。</p>
        )}
      </nav>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="画布操作"
            className="workspace-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Tab") setMenu(null);
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              autoFocus
              role="menuitem"
              disabled={switchingId !== null}
              onClick={() => {
                setMenu(null);
                menu.trigger.focus();
                onArchive(menu.id);
              }}
            >
              <Archive size={16} className="ico" />
              归档
            </button>
          </div>,
          document.body,
        )}
      <div className="workspace-settings">
        <button
          className="workspace-action"
          {...tip("设置", `${MOD}.`)}
          onClick={onSettings}
        >
          <Settings2 size={15} className="ico" />
          <span className="workspace-copy">设置</span>
        </button>
      </div>
      {!collapsed && (
        <div
          className="workspace-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return;
            e.preventDefault();
            resizeOrigin.current = { x: e.clientX, width };
            e.currentTarget.setPointerCapture(e.pointerId);
            onResizingChange(true);
          }}
          onPointerMove={(e) => {
            const origin = resizeOrigin.current;
            if (origin)
              onWidthChange(
                clampSidebarWidth(origin.width + e.clientX - origin.x),
              );
          }}
          onPointerUp={(e) => {
            stopResizing();
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={stopResizing}
          onLostPointerCapture={stopResizing}
          onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
          onKeyDown={(e) => {
            let next = width;
            if (e.key === "ArrowLeft") next -= 10;
            else if (e.key === "ArrowRight") next += 10;
            else if (e.key === "Home") next = SIDEBAR_MIN_WIDTH;
            else if (e.key === "End") next = SIDEBAR_MAX_WIDTH;
            else return;
            e.preventDefault();
            e.stopPropagation();
            onWidthChange(clampSidebarWidth(next));
          }}
        />
      )}
    </aside>
  );
}
