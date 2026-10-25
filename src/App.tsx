import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ReactFlow,
  ConnectionMode,
  SelectionMode,
  useReactFlow,
  type Edge,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import { ArrowRight, LoaderCircle, Plus, X } from "lucide-react";
import type {
  AIRequest,
  AISettings,
  AIUpdate,
  CanvasRun,
  Board,
  BoardSummary,
  Selection,
  StickyNote,
  Understanding,
  ChatProposal,
} from "./shared/types";
import { api, isDesktop } from "./api";
import {
  createWalkthroughBoard,
  createEmptyBoard,
  newId,
  newNote,
  expandWalkthrough,
  buildMapFromAI,
} from "./model/boards";
import { reconcileCanvasResult } from "./model/canvas-result";
import { CanvasRunProgress } from "./components/CanvasRunProgress";
import { CanvasActivity } from "./components/CanvasActivity";
import { boardProgress } from "./model/progress";
import { CanvasMenu, PausedPill } from "./components/CanvasMenu";
import { contextForNote, leanForGeneration } from "./model/context";
import {
  HINT_DELAY,
  cachedHints,
  hintPrompt,
  hintSignature,
  parseHints,
  withHints,
  type HintSide,
} from "./model/hints";
import { plain } from "./model/answer";
import {
  boxPick,
  chatContext,
  manyCardsTitle,
  selectedCards,
  toggleCard,
} from "./model/selection";
import { tip, TooltipLayer } from "./components/Tooltip";
import { latestNoteOn, listSessions } from "./model/sessions";
import { WINDOW_CHROME_CLASSES, windowChromeClasses } from "./model/platform";
import { CoveragePanel } from "./components/CoveragePanel";
import { coverTarget } from "./model/plan";
import { ANGLE_DEPTH, type DigAngle } from "./model/angles";
import { expandPrompt, hintCardNote, reExpandNote } from "./model/expand";
import { clearBelow, landReExpand, type ReExpandJob } from "./model/reexpand";
import { applyEnrichment, enrichPrompt } from "./model/enrich";
import {
  confirmPlan,
  parsePlan,
  planFirstLevelPrompt,
  planPrompt,
} from "./model/plan";
import type { BoardPlan, ConceptNode, LadderLevel, ProbeState } from "./shared/types";
import {
  firstLevelPrompt,
  kickoffNote,
  kickoffPrompt,
  kickoffSkeleton,
  learnerAnswers,
  isQuestionRoot,
  needsKickoff,
  questionId,
  rootOf,
  rootsOf,
} from "./model/kickoff";
import {
  addChild,
  addParent,
  addRoot,
  addSibling,
  cacheMessages,
  layOutline,
  mergeHistory,
  removeSelection,
  reorder,
  reparent,
} from "./model/editor";
import {
  cardWidth,
  insertSlot,
  layoutTree,
  sectionNumbers,
  type Slot,
} from "./model/layout";
import { flushBoardCache, loadBoardForNavigation } from "./model/persistence";
import {
  ConceptCard,
  GhostCard,
  RootCard,
  type CanvasNode,
} from "./components/CanvasNodes";
import { TreeEdge, SeqEdge } from "./components/TreeEdge";
import { CrossEdge } from "./components/CrossEdge";
import { LevelGuides } from "./components/LevelGuides";
import { TopicOverviews } from "./components/TopicOverviews";
import {
  Dock,
  MapUnit,
  Palette,
  Progress,
  type Tool,
} from "./components/Chrome";
import {
  WorkspaceSidebar,
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
} from "./components/WorkspaceSidebar";
import { Drawer } from "./components/Drawer";
import { NextStepBar } from "./components/NextStep";
import { nextStep } from "./model/next-step";
import { applyRouteOps, defaultRoute, descendantIds, previewRoute, routeOf, stationOf } from "./model/route";
import {
  chatRequest,
  displayChat,
  expireProposals,
  isGoAhead,
  noteLinks,
  parseChatReply,
  pendingProposal,
  restoreLinks,
  withProposal,
  type NoteLinks,
} from "./model/chat";
import { runGate, roughTokens } from "./model/novelty";
import { applyGate } from "./model/gate";
import { answerProbe, applyExpand, applyFrontier, applyRefine, bounds as probeBounds, cacheChain, cachedChain, chainKey, chainPrompt, failRecheck, gradePrompt, localGrade, newProbe, nextStep as probeStep, parseGrade, parsePoints, probeLearner, refinePrompt, restartProbe, skipProbe } from "./model/probe";
import { afterChildSealed, analogyPrompt, isStuck, parseAnalogy, putOff, splitNote } from "./model/stuck";
import { parseWrap, wrapPrompt } from "./model/wrap";
import { ProbePanel } from "./components/ProbePanel";
import { StuckExits } from "./components/StuckExits";
import { WrapPanel } from "./components/WrapPanel";
import { explainPoints, localMark, markPrompt, parseMark, testPoints, type Mark } from "./model/mark";
import { questionNode } from "./shared/canvas";
import { StudyMode } from "./components/StudyMode";
import { Outline } from "./components/Outline";
import { Settings } from "./components/Settings";
import { BoardExport } from "./components/BoardExport";
import { ConversationHistory } from "./components/ConversationHistory";
import { canvasImage } from "./canvas-image";
import { TRANSFER_BYTES, type ExportFormat } from "./shared/transfer";

const nodeTypes = { concept: ConceptCard, root: RootCard, ghost: GhostCard };
const edgeTypes = { tree: TreeEdge, seq: SeqEdge, cross: CrossEdge };
const GHOST = "ghost-slot";
function applySlot(board: Board, id: string, slot: Slot): Board {
  return slot.kind === "reorder"
    ? reorder(board, id, slot.order)
    : reparent(board, id, slot.parentId, slot.order);
}
function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
const defaults: AISettings = {
  configured: false,
  source: "none",
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
};
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("AI_NOT_CONFIGURED")
    ? "先连接 AI，才能继续这个问题。内置演练与白板编辑仍然可用。"
    : text
        .replace(/^Error invoking remote method '[^']+': Error: /, "")
        .slice(0, 500);
}
export default function App() {
  const [board, setBoard] = useState<Board | null>(null),
    [boards, setBoards] = useState<BoardSummary[]>([]),
    [selection, setSelection] = useState<Selection>(null),
    /** Two or more cards picked together (Shift/⌘-click or a marquee). */
    [picked, setPicked] = useState<string[]>([]),
    /** Space held: the canvas pans on drag instead of drawing a marquee. */
    [spacePan, setSpacePan] = useState(false),
    /** The canvas is being panned: the minimap shows meanwhile. */
    [panning, setPanning] = useState(false),
    [settings, setSettings] = useState<AISettings>(defaults),
    [showSettings, setShowSettings] = useState(false),
    [showNew, setShowNew] = useState(false),
    [topic, setTopic] = useState(""),
    [toast, setToast] = useState(""),
    [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
      "saved",
    ),
    [loaded, setLoaded] = useState(false),
    [past, setPast] = useState<Board[]>([]),
    [pending, setPending] = useState<
      Record<string, { text: string; busy: boolean; error?: string }>
    >({}),
    [mapBusy, setMapBusy] = useState(false),
    [planBusy, setPlanBusy] = useState(false),
    [promote, setPromote] = useState<{
      noteId: string;
      text: string;
      title: string;
    } | null>(null),
    [drawer, setDrawer] = useState<{
      id: string;
      autoFocus: boolean;
    } | null>(null),
    [palette, setPalette] = useState(false),
    [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
      try {
        return localStorage.getItem("studyboard-sidebar-collapsed") === "true";
      } catch {
        return false;
      }
    }),
    [switchingBoardId, setSwitchingBoardId] = useState<string | null>(null),
    [study, setStudy] = useState<{ startId?: string } | null>(null),
    [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set()),
    [tool, setTool] = useState<Tool>("select"),
    [editingId, setEditingId] = useState<string | null>(null),
    [preview, setPreview] = useState<Board | null>(null),
    [measured, setMeasured] = useState<
      Record<string, { width: number; height: number }>
    >({}),
    [dragPos, setDragPos] = useState<{
      id: string;
      x: number;
      y: number;
    } | null>(null),
    [dark, setDark] = useState(
      () => matchMedia("(prefers-color-scheme: dark)").matches,
    ),
    mobile = useMedia("(max-width: 720px)");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("studyboard-sidebar-width"));
      if (Number.isFinite(saved) && saved > 0) return clampSidebarWidth(saved);
    } catch {
      // Use the default when browser preference storage is unavailable.
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  useEffect(() => {
    if (sidebarResizing) return;
    try {
      localStorage.setItem("studyboard-sidebar-width", String(sidebarWidth));
    } catch {
      // Resizing still works when browser preference storage is unavailable.
    }
  }, [sidebarWidth, sidebarResizing]);
  const [closing, setClosing] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [historyNoteId, setHistoryNoteId] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(
        "studyboard-sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {
      // The sidebar still works if browser preference storage is unavailable.
    }
  }, [sidebarCollapsed]);
  const [canvasRuns, setCanvasRuns] = useState<CanvasRun[]>([]);
  const [canvasPreview, setCanvasPreview] = useState<Board | null>(null);
  const canvasPreviewRunId = useRef<string | null>(null);
  const [showCanvasActivity, setShowCanvasActivity] = useState(false);
  const canvasWriteLocked = useRef(false);
  const canvasPreparing = useRef(new Set<string>());
  const canvasCommitting = useRef(new Set<string>());
  const appliedCanvas = useRef(new Set<string>());
  const currentCanvasRun =
    canvasRuns.find(
      (run) =>
        run.boardId === board?.id &&
        ["running", "ready"].includes(run.status) &&
        (run.changed || run.phase === "locking"),
    ) ??
    canvasRuns.find(
      (run) =>
        run.boardId === board?.id && ["running", "ready"].includes(run.status),
    );
  const organizing = currentCanvasRun?.origin === "organize";
  const canvasLocked =
    !!currentCanvasRun &&
    (currentCanvasRun.changed || currentCanvasRun.phase === "locking");
  canvasWriteLocked.current = canvasLocked;
  const editingLocked = useRef(false);
  /** True while a board switch/transfer is in flight or a canvas agent run owns the board. */
  const locked = () => editingLocked.current || canvasWriteLocked.current;
  const boardCache = useRef(new Map<string, Board>()),
    completionQueues = useRef(new Map<string, Promise<void>>());
  /** The chat turn in flight per note (its own stickyId), so 停止 can stop it. */
  const chatActive = useRef(new Map<string, string>());
  /** Stops a just-applied route edit changed: highlighted for 1.2s. */
  const [flash, setFlash] = useState<Set<string>>(() => new Set());
  /** Act on a chat proposal: 应用 / 撤销 / 取消 / 开始第 N 站. Set once the handlers exist. */
  const proposalActRef = useRef<(noteId: string, messageId: string, act: "apply" | "undo" | "cancel" | "start") => void>(() => {});
  /** Route snapshots from before each applied proposal, for its 撤销 (this session only). */
  const routeSnapshots = useRef(
    new Map<string, Pick<Board, "nodes" | "relations" | "route" | "cardArchives"> & { links: NoteLinks }>(),
  );
  const askQuietRef = useRef<
    (mode: "gate" | "mark" | "expand" | "probe" | "regen", prompt: string, stickyId: string, context?: AIRequest["context"]) => Promise<string>
  >(() => Promise.reject(new Error("not ready")));
  const boardRef = useRef<Board | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    requestMeta = useRef(
      new Map<
        string,
        {
          request: AIRequest;
          anchor?: string;
          hintSignature?: string;
          /** enrich: the new cards it decorates. */
          newIds?: string[];
          /** expand from a stuck stop (往下拆): the new cards are its split children. */
          split?: boolean;
          /** A picked ghost hint: select the card it becomes. */
          selectNew?: boolean;
          /** 重做下层 from a chat proposal: the old cards below the anchor are archived when new ones land. */
          reExpand?: ReExpandJob;
          /** chat: the note whose thread this turn belongs to (each turn has its own stickyId). */
          noteId?: string;
          /** Quiet requests (gate judge, regenerate, check marking) resolve a promise. */
          resolve?: (text: string) => void;
          reject?: (error: Error) => void;
        }
      >(),
    ),
    enrichRef = useRef<
      (board: Board, anchor: string | undefined, ids: string[]) => void
    >(() => {});
  // Ghost hints: in flight (by card), failed (by card|signature), and hover debounce timers.
  const hintBusy = useRef(new Set<string>());
  const hintFailed = useRef(new Set<string>());
  const hintTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const configured = useRef(false);
  const flow = useReactFlow<CanvasNode>();
  const showToast = useCallback((text: string) => {
    setToast(text);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const refreshList = useCallback(async () => {
    setBoards(
      (await api.listBoards()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
  }, []);
  const putBoard = useCallback((next: Board, record = true) => {
    const previous = boardRef.current;
    if (record && previous?.id === next.id)
      setPast((p) => [...p.slice(-29), structuredClone(previous)]);
    const value = { ...next, updatedAt: now() };
    boardRef.current = value;
    boardCache.current.set(value.id, value);
    setBoard(value);
    setSaveStatus("saving");
  }, []);
  const edit = useCallback(
    (fn: (b: Board) => Board, record = true) => {
      if (editingLocked.current || !boardRef.current) return;
      const current = boardRef.current;
      const next = fn(current);
      if (
        canvasWriteLocked.current &&
        (next.nodes !== current.nodes ||
          next.relations !== current.relations ||
          next.scene !== current.scene)
      )
        return;
      putBoard(next, record);
    },
    [putBoard],
  );
  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await flushBoardCache(boardCache.current, api.saveBoard, () => [
      ...completionQueues.current.values(),
    ]);
    setSaveStatus("saved");
    await refreshList();
  }, [refreshList]);
  const receiveCanvasRun = useCallback(
    (run: CanvasRun) => {
      setCanvasRuns((previous) => [
        run,
        ...previous.filter((item) => item.id !== run.id),
      ]);
      const isCurrent = boardRef.current?.id === run.boardId;
      if (
        run.status === "running" &&
        run.phase === "locking" &&
        !canvasPreparing.current.has(run.id)
      ) {
        canvasPreparing.current.add(run.id);
        if (isCurrent) {
          canvasWriteLocked.current = true;
          canvasPreviewRunId.current = run.id;
          setEditingId(null);
          setPreview(null);
          setDragPos(null);
        }
        void (async () => {
          try {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            const current =
              boardRef.current?.id === run.boardId
                ? boardRef.current
                : boardCache.current.get(run.boardId);
            if (current) await api.saveBoard(current);
            await api.prepareCanvasRun(run.boardId, run.id);
          } catch (error) {
            showToast(errorText(error));
            await api.cancelCanvasRun(run.boardId, run.id);
          } finally {
            canvasPreparing.current.delete(run.id);
          }
        })();
      }
      if (isCurrent && run.changed && run.status === "running" && run.draft) {
        canvasPreviewRunId.current = run.id;
        setCanvasPreview(reconcileCanvasResult(boardRef.current!, run.draft));
      }
      if (run.status === "ready" && !canvasCommitting.current.has(run.id)) {
        canvasCommitting.current.add(run.id);
        void (async () => {
          try {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            const current =
              boardRef.current?.id === run.boardId
                ? boardRef.current
                : boardCache.current.get(run.boardId);
            if (current) await api.saveBoard(current);
            const result = await api.commitCanvasRun(run.boardId, run.id);
            if (!appliedCanvas.current.has(run.id)) {
              appliedCanvas.current.add(run.id);
              const local =
                boardRef.current?.id === run.boardId
                  ? boardRef.current
                  : boardCache.current.get(run.boardId);
              const next = local
                ? reconcileCanvasResult(local, result, current ?? undefined)
                : result;
              if (boardRef.current?.id === run.boardId) {
                putBoard(next, run.changed);
                setCanvasPreview(null);
                canvasWriteLocked.current = false;
              } else boardCache.current.set(run.boardId, next);
            }
            showToast(run.summary || "画布修改已完成，可撤销恢复。");
          } catch (error) {
            setCanvasPreview(null);
            canvasWriteLocked.current = false;
            await api.cancelCanvasRun(run.boardId, run.id).catch(() => {});
            showToast(errorText(error));
          } finally {
            canvasCommitting.current.delete(run.id);
          }
        })();
      }
      if (
        isCurrent &&
        ["paused", "cancelled", "failed", "conflict"].includes(run.status)
      ) {
        if (canvasPreviewRunId.current === run.id) {
          setCanvasPreview(null);
          canvasWriteLocked.current = false;
          canvasPreviewRunId.current = null;
        }
        if (run.status === "paused")
          showToast("画布任务已暂停，进度已保存。可在画布右上角 ⋯ 的「整理记录与恢复」中继续。");
        if (run.error) showToast(errorText(run.error));
      }
    },
    [putBoard, showToast],
  );
  useEffect(
    () => api.onCanvasRun(({ run }) => receiveCanvasRun(run)),
    [receiveCanvasRun],
  );
  useEffect(() => {
    if (!board?.id) return;
    let cancelled = false;
    void api
      .listCanvasRuns(board.id)
      .then(async (runs) => {
        if (cancelled) return;
        setCanvasRuns((previous) => [
          ...runs,
          ...previous.filter((run) => run.boardId !== board.id),
        ]);
        for (const summary of runs)
          if (["running", "ready"].includes(summary.status)) {
            const run = await api.getCanvasRun(board.id, summary.id);
            if (run && !cancelled) receiveCanvasRun(run);
          }
      })
      .catch((error) => showToast(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [board?.id, receiveCanvasRun, showToast]);
  const closeFlush = useCallback(async () => {
    editingLocked.current = true;
    setClosing(true);
    try {
      await flush();
    } catch (error) {
      editingLocked.current = false;
      setClosing(false);
      setSaveStatus("error");
      throw error;
    }
  }, [flush]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await api.listBoards()).filter((b) => !b.archivedAt);
        const settings = await api.getAISettings();
        let initial = list.length
          ? await api.loadBoard(
              [...list].sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
              )[0].id,
            )
          : null;
        if (!initial) {
          initial = createWalkthroughBoard();
          await api.saveBoard(initial);
        }
        if (cancelled) return;
        boardRef.current = initial;
        boardCache.current.set(initial.id, initial);
        setBoard(initial);
        setSettings(settings);
        await refreshList();
        setLoaded(true);
        setTimeout(() => flow.fitView({ padding: 0.16, duration: 500 }), 160);
      } catch (error) {
        if (!cancelled) {
          showToast(errorText(error));
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => api.onBeforeClose(closeFlush), [closeFlush]);
  useEffect(() => {
    if (!loaded || !board) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api
        .saveBoard(board)
        .then(() => {
          if (boardRef.current?.updatedAt === board.updatedAt)
            setSaveStatus("saved");
          void refreshList();
        })
        .catch((e) => {
          if (boardRef.current?.canvasVersion !== board.canvasVersion) return;
          setSaveStatus("error");
          showToast(`保存失败：${errorText(e)}`);
        });
    }, 450);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [board, loaded, refreshList, showToast]);
  useEffect(() => {
    if (!board?.id) return;
    let cancelled = false;
    void (async () => {
      for (const note of board.notes) {
        try {
          const history = await api.getHistory(board.id, note.id);
          if (cancelled) return;
          if (history.messages.length)
            edit(
              (current) =>
                current.id === board.id
                  ? {
                      ...current,
                      notes: current.notes.map((n) =>
                        n.id === note.id
                          ? {
                              ...n,
                              messages: mergeHistory(
                                n.messages,
                                history.messages,
                              ),
                            }
                          : n,
                      ),
                    }
                  : current,
              false,
            );
        } catch {
          /* Notes remain available offline; runtime history is optional before setup. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board?.id]);
  useEffect(
    () =>
      api.onAIUpdate((update: AIUpdate) => {
        if (update.stickyId.startsWith("canvas-run-")) return;
        const quiet = requestMeta.current.get(update.requestId);
        if (quiet?.resolve) {
          if (update.status === "streaming") return;
          requestMeta.current.delete(update.requestId);
          if (update.status === "done") quiet.resolve(update.text);
          else quiet.reject?.(new Error(update.error ?? update.status));
          return;
        }
        // Ghost hints are a quiet cache: no thread, no toast, no busy state.
        const hintMeta = requestMeta.current.get(update.requestId);
        if (hintMeta?.request.mode === "hint") {
          if (update.status === "streaming") return;
          requestMeta.current.delete(update.requestId);
          const id = hintMeta.anchor!;
          hintBusy.current.delete(id);
          const b = boardRef.current;
          if (update.status !== "done" || b?.id !== update.boardId) return;
          if (hintMeta.hintSignature !== hintSignature(b, id)) return;
          const hints = parseHints(update.text, b, id);
          if (!hints) hintFailed.current.add(`${id}|${hintSignature(b, id)}`);
          else if (!locked()) putBoard(withHints(b, id, hints), false);
          return;
        }
        // The learning plan: a draft the learner reviews before the first level.
        if (hintMeta?.request.mode === "plan") {
          if (update.status === "streaming") return;
          requestMeta.current.delete(update.requestId);
          setPlanBusy(false);
          const b = boardRef.current;
          if (update.status === "cancelled") return;
          if (update.status !== "done") {
            showToast(errorText(update.error ?? "学习计划没有拟好，请重试。"));
            return;
          }
          if (b?.id !== update.boardId) return;
          try {
            putBoard({ ...b, plan: parsePlan(update.text) }, false);
          } catch (error) {
            showToast(errorText(error));
          }
          return;
        }
        // Diagrams and overviews for new cards: quiet, optional decoration.
        if (hintMeta?.request.mode === "enrich") {
          if (update.status === "streaming") return;
          requestMeta.current.delete(update.requestId);
          const b = boardRef.current;
          if (update.status !== "done" || b?.id !== update.boardId || locked())
            return;
          const next = applyEnrichment(
            update.text,
            b,
            hintMeta.newIds ?? [],
            hintMeta.request.context,
          );
          if (next !== b) putBoard(next, false);
          return;
        }
        // The post-probe chat: an ordinary answer plus at most one proposal; never writes cards.
        if (hintMeta?.request.mode === "chat") {
          const noteId = hintMeta.noteId!;
          const chatKey = `${update.boardId}/${noteId}`;
          if (update.status === "streaming") {
            setPending((p) => ({ ...p, [chatKey]: { text: displayChat(update.text), busy: true } }));
            return;
          }
          requestMeta.current.delete(update.requestId);
          if (chatActive.current.get(noteId) === update.stickyId) chatActive.current.delete(noteId);
          setPending((p) => ({
            ...p,
            [chatKey]: { text: "", busy: false, ...(update.status === "error" ? { error: errorText(update.error ?? "AI 暂时无法回答") } : {}) },
          }));
          if (update.status === "error") return;
          const b = boardRef.current;
          if (b?.id !== update.boardId) return;
          const { reply, proposal } = update.status === "done" ? parseChatReply(update.text, b) : { reply: displayChat(update.text), proposal: undefined };
          if (!reply && !proposal) {
            if (update.status === "cancelled") showToast("已停止回答。");
            return;
          }
          edit(
            (current) => ({
              ...current,
              notes: current.notes.map((n) =>
                n.id === noteId
                  ? {
                      ...n,
                      messages: cacheMessages([
                        ...n.messages,
                        {
                          id: update.requestId + "-answer",
                          role: "assistant" as const,
                          text: reply || "好。",
                          createdAt: now(),
                          meta: { chat: true, ...(proposal ? { proposal } : {}) },
                        },
                      ]),
                    }
                  : n,
              ),
            }),
            false,
          );
          return;
        }
        const key = `${update.boardId}/${update.stickyId}`;
        setPending((p) => ({
          ...p,
          [key]: {
            text: update.text,
            busy: update.status === "streaming",
            error: update.error,
          },
        }));
        if (update.status === "streaming") return;
        const meta = requestMeta.current.get(update.requestId);
        requestMeta.current.delete(update.requestId);
        if (meta && ["map", "expand"].includes(meta.request.mode))
          setMapBusy(false);
        if (update.status === "error") {
          showToast(errorText(update.error ?? "AI 暂时无法回答"));
          return;
        }
        if (update.status === "cancelled") {
          showToast("已停止回答，已保存的对话仍在。");
          return;
        }
        const previous =
          completionQueues.current.get(update.boardId) ?? Promise.resolve();
        const task = previous
          .then(async () => {
            const loaded =
              boardCache.current.get(update.boardId) ??
              (await api.loadBoard(update.boardId));
            const target =
              boardRef.current?.id === update.boardId
                ? boardRef.current
                : (boardCache.current.get(update.boardId) ?? loaded);
            if (!target) return;
            let next = target;
            try {
              if (meta && (meta.request.mode === "map" || meta.request.mode === "expand")) {
                const mode = meta.request.mode;
                let reExpandDone = "";
                const anchorId = meta.anchor ?? questionNode(target)?.id ?? target.nodes[0].id;
                setMapBusy(true);
                const gate = (against: Board) =>
                  runGate(
                    update.text,
                    against,
                    anchorId,
                    (m, prompt) => askQuietRef.current(m, prompt, `${m}-gate-${anchorId}`),
                    meta.request.prompt,
                    { regenAny: !!meta.reExpand },
                  ).finally(() => setMapBusy(false));
                // 重做下层: gate the new cards against the board without the old children; only when
                // some land are the old ones archived (otherwise `target` is returned untouched).
                const job = meta.reExpand;
                let outcome: Awaited<ReturnType<typeof gate>>;
                let applied: { board: Board; added: string[]; mergedInto: string[] };
                if (job) {
                  const r = await landReExpand(target, anchorId, job.messageId, now(), gate, meta.request.context);
                  outcome = r.outcome;
                  applied = r;
                } else {
                  outcome = await gate(target);
                  applied = applyGate(target, anchorId, outcome, mode, meta.request.context);
                }
                const tokens = outcome.tokens + roughTokens(meta.request.prompt, JSON.stringify(meta.request.context));
                if (import.meta.env.DEV)
                  console.info(
                    `[gate] ${mode} ~${tokens} tokens · kept ${outcome.kept.length} · merged ${outcome.merges.length} · dropped ${outcome.dropped.length} · regen ${outcome.calls.regen} · judge ${outcome.calls.judge}`,
                  );
                next = applied.board;
                if (meta.selectNew && applied.added[0]) {
                  const born = applied.added[0];
                  setTimeout(() => setSelection({ kind: "node", id: born }), 0);
                }
                if (meta.split && applied.added.length) {
                  const born = new Set(applied.added);
                  next = { ...next, nodes: next.nodes.map((n) => (born.has(n.id) ? { ...n, meta: { ...n.meta, split: true } } : n)) };
                }
                if (mode === "map" && !target.route?.length && anchorId === questionNode(target)?.id) {
                  const route = defaultRoute(next);
                  // 摸底 done: stations below the frontier get the light A seal.
                  if (route.length) next = applyFrontier({ ...next, route });
                }
                if (job && applied.added.length) {
                  // The proposal flips to 已应用 in the same board change; 撤销 restores this snapshot.
                  const oldCount = descendantIds(target, anchorId).length;
                  routeSnapshots.current.set(job.messageId, {
                    nodes: target.nodes,
                    relations: target.relations,
                    route: target.route,
                    cardArchives: target.cardArchives,
                    links: noteLinks(target),
                  });
                  next = withProposal(next, job.noteId, job.messageId, { state: "applied", added: applied.added.length });
                  reExpandDone = `已按你的要求重做下层：新增 ${applied.added.length} 张，原来的 ${oldCount} 张已归档，可以在这条回复里撤销。`;
                } else if (job) reExpandDone = "这次没有生成可用的新卡，原来的下层没动。可以换个说法，再点应用重试。";
                showToast(
                  reExpandDone ? reExpandDone :
                  applied.added.length
                    ? applied.mergedInto.length
                      ? `已展开新的概念；有一点已在「${next.nodes.find((n) => n.id === applied.mergedInto[0])?.title}」里，已补充进去。`
                      : "已展开新的概念。你可以继续调整它们。"
                    : applied.mergedInto.length
                      ? `这一点已在「${next.nodes.find((n) => n.id === applied.mergedInto[0])?.title}」里，已补充进去。`
                      : outcome.dropped.length
                        ? "这一块暂时挖不出新东西了，试试换个角度？（再看一层旁的「往哪挖」）"
                        : "这次没有找到值得补充的新概念。你仍可以继续提问或稍后再试。",
                );
              } else if (meta && meta.request.mode !== "answer") {
                next = buildMapFromAI(
                  update.text,
                  target,
                  meta.anchor,
                  meta.request.mode === "expand" ? "expand" : "map",
                  meta.request.context,
                );
                showToast(
                  next.nodes.length === target.nodes.length
                    ? "这次没有找到值得补充的新概念。你仍可以继续提问或稍后再试。"
                    : "已展开新的概念。你可以继续调整它们。",
                );
              } else {
                next = {
                  ...target,
                  notes: target.notes.map((n) =>
                    n.id === update.stickyId
                      ? {
                          ...n,
                          messages: cacheMessages([
                            ...n.messages,
                            {
                              id: update.requestId + "-answer",
                              role: "assistant" as const,
                              text: update.text,
                              createdAt: now(),
                            },
                          ]),
                        }
                      : n,
                  ),
                };
              }
              if (next !== target) {
                const known = new Set(target.nodes.map((n) => n.id));
                const added = next.nodes
                  .filter((n) => !known.has(n.id))
                  .map((n) => n.id);
                if (meta && meta.request.mode !== "answer" && added.length)
                  enrichRef.current(next, meta.anchor, added);
                if (boardRef.current?.id === target.id) {
                  // A re-expansion that landed is one ⌘Z step; a plain expansion has never been.
                  putBoard(next, !!meta?.reExpand);
                } else {
                  next = { ...next, updatedAt: now() };
                  boardCache.current.set(next.id, next);
                  await api.saveBoard(next);
                }
              }
              setPending((p) => ({ ...p, [key]: { text: "", busy: false } }));
            } catch (error) {
              showToast(`回答未加入地图：${errorText(error)}`);
            }
          })
          .catch((error) => showToast(errorText(error)));
        completionQueues.current.set(update.boardId, task);
        void task.finally(() => {
          if (completionQueues.current.get(update.boardId) === task)
            completionQueues.current.delete(update.boardId);
        });
      }),
    [putBoard, showToast],
  );
  const center = useCallback(
    () =>
      flow.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
    [flow],
  );
  // What is selected right now, for chatContext (read inside stable callbacks).
  const chatSelection = useRef<string[]>([]);
  const openDrawer = useCallback((id: string, autoFocus = true) => {
    setDrawer({ id, autoFocus });
  }, []);
  /**
   * Open (or start) a conversation. Unless `cards: false`, the selected cards come along as
   * context via chatContext; a conversation with extra cards is always a fresh one.
   */
  const addNote = useCallback(
    (
      attachment?: StickyNote["attachedTo"],
      opts: {
        fresh?: boolean;
        cards?: boolean;
        autoFocus?: boolean;
      } = {},
    ) => {
      const b = boardRef.current;
      if (!b) return;
      const exists = (id: string) => b.nodes.some((n) => n.id === id);
      const ctx = chatContext(
        opts.cards === false ? [] : chatSelection.current,
        attachment?.kind === "node" ? attachment.id : undefined,
        exists,
      );
      // A free note (no anchor) keeps its selected cards only as context.
      const extra =
        attachment?.kind === "node"
          ? ctx.contextCards
          : [
              ...new Set(opts.cards === false ? [] : chatSelection.current),
            ].filter(exists);
      const existing =
        attachment && !opts.fresh && !extra.length
          ? latestNoteOn(b, attachment)
          : undefined;
      if (existing) {
        openDrawer(existing.id, opts.autoFocus);
        return existing.id;
      }
      const note = newNote(b, { x: 0, y: 0 }, attachment);
      if (attachment?.kind === "node")
        note.title = b.nodes.find((n) => n.id === attachment.id)?.title ?? "";
      if (extra.length) {
        note.contextCards = extra;
        if (attachment?.kind === "node")
          note.title = manyCardsTitle(note.title, extra.length);
      }
      edit((current) => ({ ...current, notes: [...current.notes, note] }));
      openDrawer(note.id, opts.autoFocus);
      return note.id;
    },
    [edit, openDrawer],
  );
  const sendAI = useCallback(
    async (request: AIRequest, anchor?: string, extra?: { selectNew?: boolean; split?: boolean; reExpand?: ReExpandJob }) => {
      requestMeta.current.set(request.requestId, { request, anchor, ...extra });
      setPending((p) => ({
        ...p,
        [`${request.boardId}/${request.stickyId}`]: { text: "", busy: true },
      }));
      try {
        if (request.canvas) {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          const target =
            boardRef.current?.id === request.boardId
              ? boardRef.current
              : boardCache.current.get(request.boardId);
          if (target) await api.saveBoard(target);
        }
        await api.ask(request);
      } catch (error) {
        requestMeta.current.delete(request.requestId);
        setPending((p) => ({
          ...p,
          [`${request.boardId}/${request.stickyId}`]: {
            text: "",
            busy: false,
            error: errorText(error),
          },
        }));
        setMapBusy(false);
        showToast(errorText(error));
      }
    },
    [showToast],
  );
  /** A quiet request (no thread, no toast) whose reply text resolves the promise. */
  const askQuiet = useCallback(
    (mode: "gate" | "mark" | "expand" | "probe" | "regen", prompt: string, stickyId: string, context?: AIRequest["context"]) =>
      new Promise<string>((resolve, reject) => {
        const b = boardRef.current;
        if (!b) return reject(new Error("no board"));
        const request: AIRequest = {
          boardId: b.id,
          stickyId,
          requestId: uid(),
          mode,
          prompt,
          context: context ?? { topic: b.topic, references: [], summary: "" },
        };
        requestMeta.current.set(request.requestId, { request, resolve, reject });
        api.ask(request).catch((error) => {
          requestMeta.current.delete(request.requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }),
    [],
  );
  askQuietRef.current = askQuiet;
  const askNote = useCallback(
    (noteId: string, prompt: string, retry = false) => {
      if (editingLocked.current) return false;
      const b = boardRef.current;
      if (!b) return false;
      if (!settings.configured) {
        setShowSettings(true);
        return false;
      }
      const note = b.notes.find((n) => n.id === noteId);
      // 「好 / 开始吧 / 应用」right after a proposal is the same as clicking its button.
      const waiting = !retry ? pendingProposal(note) : undefined;
      if (waiting && isGoAhead(prompt)) {
        proposalActRef.current(noteId, waiting.id, waiting.meta?.proposal?.type === "startStop" ? "start" : "apply");
        return true;
      }
      // Free text is an ordinary chat turn: canvas:false, so it can never write cards.
      const requestId = uid();
      const request = chatRequest(
        b,
        retry && note ? { ...note, messages: note.messages.slice(0, -1) } : note,
        prompt,
        {
          requestId,
          stickyId: `chat-${noteId}-${requestId}`,
          // The card selected on the canvas (not a multi-pick) is what 「这一层」「下一层」 means.
          selectedId: chatSelection.current.length === 1 ? chatSelection.current[0] : undefined,
        },
      );
      chatActive.current.set(noteId, request.stickyId);
      edit(
        (current) => ({
          ...current,
          notes: current.notes.map((n) =>
            n.id === noteId
              ? {
                  ...n,
                  messages: cacheMessages(
                    retry
                      ? n.messages
                      : [
                          ...expireProposals(n.messages),
                          { id: requestId, role: "user" as const, text: prompt, createdAt: now(), meta: { chat: true } },
                        ],
                  ),
                }
              : n,
          ),
        }),
        false,
      );
      requestMeta.current.set(request.requestId, { request, noteId });
      setPending((p) => ({ ...p, [`${b.id}/${noteId}`]: { text: "", busy: true } }));
      api.ask(request).catch((error) => {
        requestMeta.current.delete(request.requestId);
        chatActive.current.delete(noteId);
        setPending((p) => ({ ...p, [`${b.id}/${noteId}`]: { text: "", busy: false, error: errorText(error) } }));
      });
      return true;
    },
    [settings.configured, edit],
  );
  const expand = useCallback(
    (id: string, angle?: DigAngle, promptOverride?: string, extra?: { selectNew?: boolean; split?: boolean; reExpand?: ReExpandJob }): boolean => {
      if (locked()) return false;
      if (
        [...requestMeta.current.values()].some(
          (meta) =>
            meta.request.mode !== "answer" &&
            meta.request.mode !== "enrich" &&
            meta.request.mode !== "plan" &&
            meta.request.mode !== "chat" &&
            // Background ghost-hint fetches must not swallow a click on 再看一层.
            meta.request.mode !== "hint",
        )
      ) {
        showToast("还有一个生成任务在进行，等它结束后再试。");
        return false;
      }
      const current = boardRef.current;
      if (!current) return false;
      if (current.kind === "walkthrough") {
        const next = expandWalkthrough(current, id);
        if (next === current) {
          showToast("这一小步已展开。可以写下自己的解释，或在批注中继续问。");
          return false;
        }
        putBoard(next);
        return true;
      }
      if (!settings.configured) {
        setShowSettings(true);
        return false;
      }
      // 重做下层: the prompt and the context see the card without its old children (they are archived
      // when the new ones land), so the "already on the board" rules do not push the new cards away.
      const b = extra?.reExpand ? clearBelow(current, id, extra.reExpand.messageId, now()) : current;
      const node = b.nodes.find((n) => n.id === id);
      if (!node) return false;
      const virtual = newNote(b, { x: 0, y: 0 }, { kind: "node", id });
      const context = leanForGeneration(
        contextForNote({ ...b, notes: [...b.notes, virtual] }, virtual.id),
        b,
        id,
      );
      setMapBusy(true);
      void sendAI(
        {
          boardId: b.id,
          stickyId: "expand-" + id,
          requestId: uid(),
          mode: "expand",
          prompt: promptOverride ?? expandPrompt(b, node.id, angle) + (extra?.reExpand ? reExpandNote(extra.reExpand.instruction) : ""),
          context,
        },
        id,
        extra,
      );
      return true;
    },
    [putBoard, settings.configured, sendAI, showToast],
  );
  const coverBlock = useCallback(
    (blockId: string) => {
      const b = boardRef.current;
      const target = b && coverTarget(b, blockId);
      if (target) expand(target.anchorId, undefined, target.prompt);
    },
    [expand],
  );
  const organizeBoard = useCallback(() => {
    const current = boardRef.current;
    if (!current || locked()) return;
    if (!settings.configured) {
      setShowSettings(true);
      return;
    }
    void (async () => {
      try {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        await api.saveBoard(current);
        const run = await api.startCanvasRun(current.id);
        setCanvasRuns((previous) => [
          run,
          ...previous.filter((item) => item.id !== run.id),
        ]);
      } catch (error) {
        showToast(errorText(error));
      }
    })();
  }, [settings.configured, showToast]);
  const generateMap = useCallback(
    (target: Board, prompt?: string) => {
      if (!settings.configured) {
        showToast("白板已创建。连接 AI 后就能探索这个问题。");
        setShowSettings(true);
        return;
      }
      const anchor = rootOf(target);
      if (!anchor) return;
      const virtual = newNote(
        target,
        { x: 0, y: 0 },
        { kind: "node", id: anchor.id },
      );
      const context = contextForNote(
        { ...target, notes: [virtual] },
        virtual.id,
      );
      setMapBusy(true);
      void sendAI(
        {
          boardId: target.id,
          stickyId: "map-root",
          requestId: uid(),
          mode: "map",
          prompt:
            prompt ??
            `为这个问题创建学习地图的第一层：「${target.topic}」。给 3–5 个并列的大图景子问题，具体、直观、少文字，适合初学者。`,
          context,
        },
        anchor.id,
      );
    },
    [settings.configured, sendAI, showToast],
  );
  /** 「让 AI 带我开始」: open the root's drawer conversation and let the tutor probe what the learner knows. */
  const startKickoff = useCallback(() => {
    if (locked()) return;
    const b = boardRef.current;
    const root = b && rootOf(b);
    if (!b || !root) return;
    if (!settings.configured) {
      showToast("先连接 AI，它就能带你从这个问题开始。");
      setShowSettings(true);
      return;
    }
    // Selected cards come along (chatContext); with extra cards it is a fresh start.
    const extra = chatContext(chatSelection.current, root.id, (id) =>
      b.nodes.some((n) => n.id === id),
    ).contextCards;
    const existing = kickoffNote(b);
    if (existing?.messages.length && !extra.length) {
      openDrawer(existing.id);
      return;
    }
    let noteId =
      existing && !existing.messages.length ? existing.id : undefined;
    if (!noteId) {
      const note = newNote(b, { x: 0, y: 0 }, { kind: "node", id: root.id });
      note.title = "AI 带我开始";
      if (extra.length) note.contextCards = extra;
      noteId = note.id;
      edit((current) => ({ ...current, notes: [...current.notes, note] }));
    } else if (extra.length) {
      const id = noteId;
      edit((current) => ({
        ...current,
        notes: current.notes.map((n) =>
          n.id === id ? { ...n, contextCards: extra } : n,
        ),
      }));
    }
    openDrawer(noteId);
    askNote(noteId, kickoffPrompt(b.topic));
  }, [settings.configured, showToast, edit, askNote, openDrawer]);
  /** Accept: turn the kickoff conversation into the first level of child questions on the canvas. */
  const proposeFirstLevel = useCallback(() => {
    const b = boardRef.current;
    if (!b || locked()) return;
    if (b.plan?.status === "confirmed") {
      generateMap(b, planFirstLevelPrompt(b));
      return;
    }
    if (b.plan || planBusy) return;
    requestPlan(b);
  }, [generateMap, planBusy, settings.configured]);
  /** One plan request after the kickoff (or straight from the question): the learner edits it, then confirms. */
  const requestPlan = useCallback(
    (b: Board) => {
      if (!settings.configured) {
        showToast("先连接 AI，它就能为这个问题拟定学习计划。");
        setShowSettings(true);
        return;
      }
      const root = rootOf(b);
      if (!root) return;
      const note = kickoffNote(b);
      const virtual = newNote(b, { x: 0, y: 0 }, { kind: "node", id: root.id });
      const request: AIRequest = {
        boardId: b.id,
        stickyId: "plan-" + root.id,
        requestId: uid(),
        mode: "plan",
        prompt: planPrompt(
          b.topic,
          b.probe && b.probe.status !== "asking" ? [probeLearner(b.probe), ...learnerAnswers(note)] : learnerAnswers(note),
        ),
        context: contextForNote(
          { ...b, notes: [virtual] },
          virtual.id,
          undefined,
          false,
          "references",
        ),
      };
      requestMeta.current.set(request.requestId, {
        request,
        anchor: root.id,
      });
      setPlanBusy(true);
      api.ask(request).catch((e) => {
        requestMeta.current.delete(request.requestId);
        setPlanBusy(false);
        showToast(errorText(e));
      });
    },
    [settings.configured, showToast],
  );
  const [probeBusy, setProbeBusy] = useState(false);
  /** Which skeleton the probe shows while a generation call runs (README §9). */
  const [probePhase, setProbePhase] = useState<"first" | "deeper" | "refine" | null>(null);
  /** Prefetched expansion for the current top point (README §7 预取). */
  const probePrefetch = useRef<{ key: string; promise: Promise<LadderLevel[]> } | null>(null);
  /** One batched generation call (points + their questions); one retry. Tokens go to probe.meta. */
  const genPoints = useCallback(async (prompt: string, sticky: string): Promise<{ points: LadderLevel[]; adjacent: boolean }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await askQuietRef.current("probe", prompt, sticky);
        const tokens = roughTokens(prompt, reply);
        if (import.meta.env.DEV) console.info(`[probe] gen ~${tokens} tokens`);
        edit((current) => {
          const p = current.probe;
          if (!p) return current;
          const t = p.meta?.tokens ?? { gen: 0, grade: 0 };
          return { ...current, probe: { ...p, meta: { ...(p.meta ?? { expansions: 0, refines: 0, refined: [], adjacent: [] }), tokens: { ...t, gen: t.gen + tokens } } } };
        }, false);
        const parsed = parsePoints(reply);
        if (parsed && (parsed.points.length || parsed.adjacent)) return parsed;
      } catch {
        /* retried once below */
      }
    }
    throw new Error("probe-gen");
  }, [edit]);
  const expandPoints = useCallback(
    (topic: string, chain: LadderLevel[]) => {
      const from = chain.at(-1);
      const key = chainKey(topic, from);
      const cached = cachedChain(key);
      if (cached) return Promise.resolve(cached);
      if (probePrefetch.current?.key === key) return probePrefetch.current.promise;
      const promise = genPoints(chainPrompt(topic, from, undefined, chain.map((p) => p.desc)), `probe-gen-${chain.length}`).then((r) => {
        cacheChain(key, r.points);
        return r.points;
      });
      probePrefetch.current = { key, promise };
      promise.catch(() => {
        if (probePrefetch.current?.key === key) probePrefetch.current = null;
      });
      return promise;
    },
    [genPoints],
  );
  /** Converged: re-seal a laid map, or go on to the plan. */
  const finishProbe = useCallback(
    (state: ProbeState) => {
      let next: Board = { ...boardRef.current!, probe: state };
      if (next.route?.length) next = applyFrontier(next);
      edit(() => next);
      if (!next.route?.length && !next.plan) requestPlan(next);
    },
    [edit, requestPlan],
  );
  /** Run the machine until it needs an answer (ask) or is done; EXPAND / REFINE are generation calls. */
  const advanceProbe = useCallback(
    async (start: ProbeState) => {
      const topic = boardRef.current?.topic ?? "";
      let state = start;
      for (let guard = 0; guard < 12; guard++) {
        const step = probeStep(state);
        if (step.kind === "ask") {
          edit((current) => ({ ...current, probe: state }));
          // At the top of an open range: prefetch the deeper segment while the learner thinks.
          const { hi } = probeBounds(state);
          if (step.index === state.ladder.length - 1 && hi === Infinity && (state.meta?.expansions ?? 0) < 3)
            void expandPoints(topic, state.ladder).catch(() => undefined);
          return;
        }
        if (step.kind === "done") return finishProbe(state.status === "asking" ? { ...state, status: "done", frontier: step.frontier, meta: { ...state.meta!, stopReason: step.reason } } : state);
        try {
          if (step.kind === "expand") {
            const first = !state.ladder.length;
            setProbePhase(first ? "first" : "deeper");
            if (first) {
              const key = chainKey(topic);
              let points = cachedChain(key);
              if (!points) {
                points = (await genPoints(chainPrompt(topic), "probe-gen-0")).points;
                if (points.length < 3) throw new Error("probe-gen");
                cacheChain(key, points);
              }
              state = { ...newProbe(points), meta: { ...newProbe(points).meta!, tokens: boardRef.current?.probe?.meta?.tokens } };
            } else state = applyExpand(state, await expandPoints(topic, state.ladder));
          } else {
            setProbePhase("refine");
            const r = await genPoints(refinePrompt(topic, state.ladder[step.lo], state.ladder[step.hi]), `probe-refine-${state.ladder.length}`);
            state = applyRefine(state, step.lo, step.hi, r.points, r.adjacent);
          }
        } catch {
          setProbePhase(null);
          if (boardRef.current?.probe?.status !== "asking") return;
          if (!state.ladder.length) {
            showToast("没出好题，先从头开始。可以在画布右上角 ⋯ 里重新摸底。");
            return finishProbe(skipProbe(undefined));
          }
          // A deeper segment failed: stop at what we know.
          return finishProbe({ ...state, status: "done", frontier: Math.min(probeBounds(state).lo + 1, state.ladder.length - 1), meta: { ...state.meta!, stopReason: "cap" } });
        } finally {
          setProbePhase(null);
        }
        // Skipped (or restarted) while the call ran: drop this result.
        if (boardRef.current?.probe?.status !== "asking") return;
        // Keep the latest tokens written by genPoints.
        const t = boardRef.current?.probe?.meta?.tokens;
        if (t && state.meta) state = { ...state, meta: { ...state.meta, tokens: t } };
      }
    },
    [edit, expandPoints, finishProbe, genPoints, showToast],
  );
  /** 摸底 step 1: open the root's kickoff drawer and draft the first chain (one batched call). */
  const startProbe = useCallback(() => {
    const b = boardRef.current;
    const root = b && rootOf(b);
    if (!b || !root) return;
    let note = kickoffNote(b);
    if (!note) {
      note = newNote(b, { x: 0, y: 0 }, { kind: "node", id: root.id });
      note.title = "AI 带我开始";
    }
    const created = note;
    const empty = newProbe([]);
    edit((current) => ({
      ...current,
      probe: empty,
      notes: current.notes.some((n) => n.id === created.id) ? current.notes : [...current.notes, created],
    }));
    openDrawer(created.id);
    void advanceProbe(empty);
  }, [edit, openDrawer, advanceProbe]);
  /** One answer: graded locally (MCQ, no reason), else one short call; then advance the machine. */
  const answerProbeQ = useCallback(
    async (choice: number | null, text: string) => {
      const b = boardRef.current;
      const state = b?.probe;
      if (!b || !state || state.status !== "asking" || probePhase) return;
      const step = probeStep(state);
      if (step.kind !== "ask") return;
      const point = state.ladder[step.index];
      let verdict = localGrade(point, choice, text);
      let missing = "";
      let gradeTokens = 0;
      if (!verdict) {
        setProbeBusy(true);
        const answer = choice !== null && choice >= 0 ? `${point.probe.options?.[choice] ?? ""}。理由：${text}` : text;
        const prompt = gradePrompt(point, answer);
        try {
          const reply = await askQuietRef.current("mark", prompt, `probe-mark-${b.id}`);
          gradeTokens = roughTokens(prompt, reply);
          const g = parseGrade(reply);
          verdict = g?.verdict ?? "unsure";
          missing = g?.missing ?? "";
        } catch {
          verdict = "unsure";
        } finally {
          setProbeBusy(false);
        }
      }
      const current = boardRef.current?.probe;
      if (!current) return;
      let next = answerProbe(current, {
        pointId: point.id ?? `p${point.level}`,
        verdict,
        ...(text.trim() ? { text: text.slice(0, 1000) } : {}),
        ...(missing ? { missing } : {}),
        ...(step.recheck ? { recheck: true } : {}),
      });
      if (gradeTokens && next.meta) {
        const t = next.meta.tokens ?? { gen: 0, grade: 0 };
        next = { ...next, meta: { ...next.meta, tokens: { ...t, grade: t.grade + gradeTokens } } };
      }
      if (next.status !== "asking") return finishProbe(next);
      await advanceProbe(next);
    },
    [advanceProbe, finishProbe, probePhase],
  );
  const skipProbeQ = useCallback(() => {
    const b = boardRef.current;
    if (!b) return;
    finishProbe(skipProbe(b.probe));
  }, [finishProbe]);
  const reprobe = useCallback(() => {
    const b = boardRef.current;
    if (!b?.probe?.ladder.length) return startProbe();
    const again = restartProbe(b.probe);
    edit((current) => ({ ...current, probe: again }));
    const note = kickoffNote(b);
    if (note) openDrawer(note.id);
    void advanceProbe(again);
  }, [edit, startProbe, openDrawer, advanceProbe]);
  const fromStart = useCallback(
    () =>
      edit((current) =>
        current.probe ? applyFrontier({ ...current, probe: { ...current.probe, frontier: 0 } }) : current,
      ),
    [edit],
  );
  const editPlan = useCallback(
    (plan: BoardPlan | undefined) =>
      edit((current) => {
        const { plan: _old, ...rest } = current;
        return plan ? { ...rest, plan } : rest;
      }),
    [edit],
  );
  const confirmBoardPlan = useCallback(() => {
    const b = boardRef.current;
    if (!b?.plan || locked()) return;
    const next = { ...b, plan: confirmPlan(b.plan) };
    edit(() => next);
    generateMap(next, planFirstLevelPrompt(next));
  }, [edit, generateMap]);
  const resetBoardView = useCallback(() => {
    setPast([]);
    setCanvasPreview(null);
    setSelection(null);
    setPicked([]);
    setDrawer(null);
    setEditingId(null);
    setPreview(null);
    setDragPos(null);
    setMeasured({});
    setTool("select");
    setStudy(null);
    setPromote(null);
  }, []);
  async function switchBoard(id: string) {
    if (boardRef.current?.id === id || editingLocked.current) return;
    editingLocked.current = true;
    setSwitchingBoardId(id);
    try {
      await flush();
      await completionQueues.current.get(id);
      const b = await loadBoardForNavigation(
        id,
        boardCache.current,
        api.loadBoard,
        flush,
      );
      if (!b) throw new Error("白板不存在");
      boardRef.current = b;
      boardCache.current.set(b.id, b);
      setBoard(b);
      resetBoardView();
      setTimeout(() => flow.fitView({ padding: 0.16, duration: 400 }), 60);
    } catch (e) {
      showToast(errorText(e));
    } finally {
      editingLocked.current = false;
      setSwitchingBoardId(null);
    }
  }
  async function setBoardArchived(
    id: string,
    archived: boolean,
  ): Promise<void> {
    if (locked()) return;
    editingLocked.current = true;
    setSwitchingBoardId(id);
    try {
      await flush();
      const target = boardCache.current.get(id) ?? (await api.loadBoard(id));
      if (!target) throw new Error("画布不存在");
      let replacement: Board | null = null;
      if (archived && boardRef.current?.id === id) {
        const next = boards.find((b) => b.id !== id && !b.archivedAt);
        replacement = next
          ? await loadBoardForNavigation(
              next.id,
              boardCache.current,
              api.loadBoard,
              flush,
            )
          : createEmptyBoard("新的知识主题");
        if (!replacement) throw new Error("无法读取下一张画布");
        if (!next) await api.saveBoard(replacement);
      }
      const value = {
        ...(boardCache.current.get(id) ?? target),
        updatedAt: now(),
      };
      if (archived) value.archivedAt = now();
      else delete value.archivedAt;
      await api.saveBoard(value);
      boardCache.current.set(id, value);
      if (replacement) {
        boardRef.current = replacement;
        boardCache.current.set(replacement.id, replacement);
        setBoard(replacement);
        resetBoardView();
        setTimeout(() => flow.fitView({ padding: 0.16, duration: 400 }), 60);
      }
      await refreshList();
      showToast(
        archived ? "画布已归档，可在设置中恢复。" : "画布已恢复到侧栏。",
      );
    } catch (error) {
      showToast(errorText(error));
    } finally {
      editingLocked.current = false;
      setSwitchingBoardId(null);
    }
  }
  async function openSession(
    boardId: string,
    sessionId: string,
  ): Promise<void> {
    if (locked()) throw new Error("正在切换画布");
    if (boardRef.current?.id !== boardId) await switchBoard(boardId);
    const current = boardRef.current;
    if (current?.id !== boardId) throw new Error("无法打开画布");
    const target = current.notes.find((note) => note.id === sessionId);
    if (!target) throw new Error("对话不存在");
    openDrawer(sessionId);
    const at = target.attachedTo;
    const anchorExists =
      at?.kind === "node"
        ? current.nodes.some((n) => n.id === at.id)
        : at?.kind === "relation"
          ? current.relations.some((r) => r.id === at.id)
          : false;
    if (at && anchorExists) setSelection(at);
    if (at && !anchorExists) {
      setSelection(null);
      setTimeout(() => flow.fitView({ padding: 0.16, duration: 400 }), 80);
      showToast("锚点卡已不在画布上");
    }
    if (at?.kind === "node" && anchorExists) {
      // Let React Flow render the selected board before locating its card.
      setTimeout(() => frameFamily(at.id, true), 80);
    } else if (at?.kind === "relation" && anchorExists) {
      const relation = current.relations.find((r) => r.id === at.id)!;
      setTimeout(() => flow.fitView({
        nodes: [{ id: relation.source }, { id: relation.target }],
        padding: 0.2,
        duration: 320,
      }), 80);
    }
  }
  async function createBoard(walkthrough = false) {
    if (locked() || (!walkthrough && !topic.trim())) return;
    editingLocked.current = true;
    let kickoff = false;
    try {
      await flush();
      const next = walkthrough
        ? createWalkthroughBoard()
        : createEmptyBoard(topic.trim());
      await api.saveBoard(next);
      boardRef.current = next;
      boardCache.current.set(next.id, next);
      setBoard(next);
      resetBoardView();
      setShowNew(false);
      setTopic("");
      await refreshList();
      setTimeout(() => flow.fitView({ padding: 0.22, duration: 450 }), 80);
      kickoff = !walkthrough;
    } catch (e) {
      showToast(errorText(e));
    } finally {
      editingLocked.current = false;
    }
    // A new question starts the guided kickoff (or leads to AI settings) instead of a silent map.
    if (kickoff) {
      if (settings.configured) startProbe();
      else startKickoff();
    }
  }
  async function importBoardFile(file: File) {
    if (locked()) return;
    editingLocked.current = true;
    setTransferBusy(true);
    try {
      if (file.size > TRANSFER_BYTES)
        throw new Error("文件超过 64 MB，无法导入。");
      await flush();
      const next = await api.importBoard(await file.text());
      boardRef.current = next;
      boardCache.current.set(next.id, next);
      setBoard(next);
      resetBoardView();
      await refreshList();
      setSaveStatus("saved");
      setTimeout(() => flow.fitView({ padding: 0.16, duration: 400 }), 60);
      showToast("画板已导入，学习记录和对话已恢复。");
    } catch (error) {
      showToast(errorText(error));
    } finally {
      editingLocked.current = false;
      setTransferBusy(false);
    }
  }
  async function exportCurrentBoard(format: ExportFormat) {
    if (locked() || !boardRef.current) return;
    editingLocked.current = true;
    setTransferBusy(true);
    try {
      const id = boardRef.current.id;
      if (
        Object.entries(pending).some(
          ([key, state]) => key.startsWith(`${id}/`) && state.busy,
        )
      )
        throw new Error("对话尚未结束，请等待回答完成或停止回答后再导出。");
      await flush();
      const current = boardRef.current;
      const image =
        format === "png" ? await canvasImage(flow.getNodes()) : undefined;
      if (await api.exportBoard(current, format, image)) {
        setShowExport(false);
        showToast("画板已导出。");
      }
    } catch (error) {
      throw new Error(errorText(error));
    } finally {
      editingLocked.current = false;
      setTransferBusy(false);
    }
  }
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  /** Close the drawer and hand focus back to the card it hung on. */
  const closeDrawer = useCallback(() => {
    const id = boardRef.current?.notes.find(
      (n) => n.id === drawerRef.current?.id,
    )?.attachedTo?.id;
    setDrawer(null);
    if (id)
      setTimeout(
        () =>
          document
            .querySelector<HTMLElement>(
              `.react-flow__node[data-id="${CSS.escape(id)}"]`,
            )
            ?.focus({ preventScroll: true }),
        0,
      );
  }, []);
  const undo = useCallback(() => {
    if (locked()) return;
    setPast((p) => {
      if (!p.length) return p;
      const prior = p[p.length - 1];
      const snapshot = {
        ...prior,
        canvasVersion: boardRef.current?.canvasVersion,
        appliedCanvasRuns: boardRef.current?.appliedCanvasRuns,
      };
      const previous =
        prior.canvasVersion !== boardRef.current?.canvasVersion
          ? reconcileCanvasResult(boardRef.current!, snapshot)
          : snapshot;
      boardRef.current = previous;
      boardCache.current.set(previous.id, previous);
      setBoard(previous);
      setSaveStatus("saving");
      return p.slice(0, -1);
    });
  }, []);
  const setStatus = useCallback(
    (id: string, status: Understanding, hand?: string) =>
      edit((b) => ({
        ...b,
        nodes: b.nodes.map((n) =>
          n.id === id ? { ...n, status, ...(hand ? { hand } : {}) } : n,
        ),
      })),
    [edit],
  );
  const patchNode = useCallback(
    (id: string, patch: Partial<ConceptNode>) =>
      edit((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      })),
    [edit],
  );
  /** Mark a 讲 or 测 answer: a choice locally when possible, else one short call with key points only. */
  const markCard = useCallback(
    async (id: string, kind: "explain" | "test", answer: string, choice: number | null): Promise<Mark | null> => {
      const n = boardRef.current?.nodes.find((x) => x.id === id);
      if (!n) return null;
      if (kind === "test") {
        const local = localMark(n, choice, answer.split("理由：").at(-1) ?? "");
        if (local) return local;
      }
      const q = kind === "explain" ? `用自己的话讲清「${n.title}」` : (n.check?.q ?? n.title);
      const prompt = markPrompt(q, kind === "explain" ? explainPoints(n) : testPoints(n), answer);
      try {
        const text = await askQuietRef.current("mark", prompt, `mark-${id}`);
        if (import.meta.env.DEV) console.info(`[mark] ${kind} ~${roughTokens(prompt, text)} tokens`);
        return parseMark(text);
      } catch {
        return null;
      }
    },
    [],
  );
  const [stuckBusy, setStuckBusy] = useState<{ id: string; kind: "split" | "analogy" } | null>(null);
  /** 往下拆: one gated expansion into exactly two smaller children under the stuck card. */
  const splitStuck = useCallback(
    (id: string) => {
      const b = boardRef.current;
      const n = b?.nodes.find((x) => x.id === id);
      if (!b || !n) return;
      if (b.nodes.some((c) => c.parentId === id && c.meta?.split)) return;
      expand(id, undefined, expandPrompt(b, id) + splitNote(n), { split: true });
    },
    [expand],
  );
  const analogyStuck = useCallback(
    async (id: string) => {
      const n = boardRef.current?.nodes.find((x) => x.id === id);
      if (!n) return;
      setStuckBusy({ id, kind: "analogy" });
      const prompt = analogyPrompt(n);
      try {
        const reply = await askQuietRef.current("probe", prompt, `analogy-${id}`);
        if (import.meta.env.DEV) console.info(`[stuck] analogy ~${roughTokens(prompt, reply)} tokens`);
        const analogy = parseAnalogy(reply);
        if (analogy) patchNode(id, { analogy, beat: "learn", fails: 0 });
        else showToast("这次没想出类比，换个办法试试？");
      } catch (e) {
        showToast(errorText(e));
      } finally {
        setStuckBusy(null);
      }
    },
    [patchNode, showToast],
  );
  /** 合起来讲: one short call says which stations the answer reached. */
  const submitWrap = useCallback(
    async (text: string): Promise<boolean> => {
      const b = boardRef.current;
      if (!b) return false;
      const prompt = wrapPrompt(b, text);
      try {
        const reply = await askQuietRef.current("mark", prompt, `wrap-${b.id}`);
        if (import.meta.env.DEV) console.info(`[wrap] ~${roughTokens(prompt, reply)} tokens`);
        const current = boardRef.current;
        const w = current && parseWrap(current, reply);
        if (!w) return false;
        edit((x) => ({
          ...x,
          wrap: { text: text.slice(0, 4000), lit: w.lit, ...(w.pass ? {} : { missing: w.missing || "再串进几站" }), done: w.pass },
        }));
        return true;
      } catch {
        return false;
      }
    },
    [edit],
  );
  const rename = useCallback(
    (id: string, title: string) =>
      edit((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === id ? { ...n, title } : n)),
      })),
    [edit],
  );
  const addChildOf = useCallback(
    (parentId: string) => {
      const id = newId("concept");
      setPreview(null);
      edit((b) => addChild(b, parentId, id));
      setSelection({ kind: "node", id });
      setEditingId(id);
    },
    [edit],
  );
  const addSiblingOf = useCallback(
    (siblingId: string) => {
      const b = boardRef.current;
      const node = b?.nodes.find((n) => n.id === siblingId);
      if (!node) return;
      if (!node.parentId) return addChildOf(siblingId);
      const id = newId("concept");
      edit((current) => addSibling(current, siblingId, id));
      setSelection({ kind: "node", id });
      setEditingId(id);
    },
    [edit, addChildOf],
  );
  /** Grow a root upward: a broader question above it; the old root becomes its child. */
  const addParentOf = useCallback(
    (rootId: string) => {
      const id = newId("root");
      edit((b) => addParent(b, rootId, id));
      setSelection({ kind: "node", id });
      setEditingId(id);
    },
    [edit],
  );
  /** Grow sideways: another top-level root right of this one. */
  const addRootBeside = useCallback(
    (rootId: string) => {
      const id = newId("root");
      edit((b) => addRoot(b, rootId, id));
      setSelection({ kind: "node", id });
      setEditingId(id);
    },
    [edit],
  );
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  chatSelection.current = selectedCards({ single: selectedNodeId, picked });
  // N / the dock's 批注: the selected card's conversation, else back to the
  // board's latest one (the drawer's strip lists the rest), else a free note.
  const openNotes = useCallback(() => {
    const b = boardRef.current;
    if (!b) return;
    if (selectedNodeId) return addNote({ kind: "node", id: selectedNodeId });
    const latest = listSessions(b)[0];
    if (latest) openDrawer(latest.id);
    else addNote(undefined);
  }, [selectedNodeId, addNote, openDrawer]);
  const rootId = (board && rootOf(board)?.id) ?? null;
  const next = useMemo(
    () => (board && board.kind === "ai" ? nextStep(board, skipped) : ({ kind: "none" } as const)),
    [board, skipped],
  );
  const nextId = "card" in next ? next.card.id : null;
  // 欢迎回来: the bar greets once per board open when a stop is half done.
  const [welcome, setWelcome] = useState(true);
  useEffect(() => setWelcome(true), [board?.id]);
  // The 下一步 bar floats over the canvas: pan so the highlighted card and its children sit above it.
  useEffect(() => {
    if (!nextId || drawer) return;
    const t = setTimeout(() => {
      const bar = document.querySelector(".next-step");
      const b = boardRef.current;
      if (!bar || !b) return;
      const ids = [nextId, ...b.nodes.filter((c) => c.parentId === nextId).map((c) => c.id)];
      const rects = ids
        .map((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r);
      if (!rects.length) return;
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const top = Math.min(...rects.map((r) => r.top));
      const limit = bar.getBoundingClientRect().top - 16;
      // Never push the card itself off the top; a small overlap is better than losing the card.
      const dy = Math.min(bottom - limit, top - 72);
      if (dy <= 0) return;
      const vp = flow.getViewport();
      void flow.setViewport({ ...vp, y: vp.y - dy }, { duration: 350 });
    }, 500);
    return () => clearTimeout(t);
  }, [nextId, drawer, board?.id, flow]);
  const startNextRef = useRef(() => {});
  startNextRef.current = () => {
    setWelcome(false);
    const b = boardRef.current;
    if (!b) return;
    if (next.kind === "probe") {
      const note = kickoffNote(b);
      if (note) openDrawer(note.id);
      return;
    }
    if (next.kind === "wrap") {
      const root = questionNode(b);
      if (root) addNote({ kind: "node", id: root.id }, { cards: false });
      return;
    }
    if (!("card" in next)) return;
    const id = next.card.id;
    if (next.card.meta?.later) patchNode(id, { meta: { ...next.card.meta, later: false } });
    if (!next.card.beat && next.card.status !== "explained") patchNode(id, { beat: "guess" });
    setSelection({ kind: "node", id });
    addNote({ kind: "node", id }, { cards: false });
  };
  /** Set one chat message's proposal state (no undo entry: the route edit carries that). */
  const setProposal = (noteId: string, messageId: string, patch: Partial<ChatProposal>) =>
    edit((b) => withProposal(b, noteId, messageId, patch), false);
  proposalActRef.current = (noteId, messageId, act) => {
    const b = boardRef.current;
    if (!b || locked()) return;
    const message = b.notes.find((n) => n.id === noteId)?.messages.find((m) => m.id === messageId);
    const p = message?.meta?.proposal;
    if (!p) return;
    if (act === "cancel") return setProposal(noteId, messageId, { state: "cancelled" });
    if (act === "undo") {
      const snap = routeSnapshots.current.get(messageId);
      if (!snap) return showToast("这次改动已经不能单独撤销了，可以用 ⌘Z。");
      routeSnapshots.current.delete(messageId);
      const { links, ...restored } = snap;
      edit((cur) => ({ ...cur, ...restored, notes: restoreLinks(cur.notes, links) }));
      setProposal(noteId, messageId, { state: "undone" });
      return;
    }
    if (p.state !== "pending") return;
    if (p.type === "editRoute") {
      const rows = previewRoute(b, p.ops);
      const { board: next, changed } = applyRouteOps(b, p.ops, `chat-${messageId}`, now(), () => newId("concept"));
      if (next === b) return setProposal(noteId, messageId, { state: "expired" });
      routeSnapshots.current.set(messageId, {
        nodes: b.nodes,
        relations: b.relations,
        route: b.route,
        cardArchives: b.cardArchives,
        links: noteLinks(b),
      });
      edit(() => next);
      setProposal(noteId, messageId, { state: "applied", rows } as Partial<ChatProposal>);
      setFlash(new Set(changed));
      setTimeout(() => setFlash(new Set()), 1200);
      return;
    }
    if (p.type === "reExpand") {
      // Nothing changes yet: the cards are generated first, and only if some land are the old ones
      // archived. The proposal turns 已应用 (with its 撤销) in that same board change.
      if (!b.nodes.some((n) => n.id === p.targetId) || b.kind === "walkthrough")
        return setProposal(noteId, messageId, { state: "expired" });
      expand(p.targetId, undefined, undefined, { reExpand: { noteId, messageId, instruction: p.instruction } });
      return;
    }
    const stop = routeOf(b).find((n) => n.id === p.stopId);
    if (!stop || stop.status === "explained") return setProposal(noteId, messageId, { state: "expired" });
    setProposal(noteId, messageId, { state: "applied" });
    if (stop.meta?.later) patchNode(stop.id, { meta: { ...stop.meta, later: false } });
    if (!stop.beat) patchNode(stop.id, { beat: "guess" });
    setSelection({ kind: "node", id: stop.id });
    // A stop that only has a title gets its content through the usual expand flow.
    if (!stop.body.trim() && !b.nodes.some((n) => n.parentId === stop.id)) expand(stop.id);
    addNote({ kind: "node", id: stop.id }, { cards: false });
  };
  /** 存成批注卡: the question and this answer become a new note on the same card. */
  const saveChatAnswer = (noteId: string, messageId: string) => {
    const b = boardRef.current;
    const source = b?.notes.find((n) => n.id === noteId);
    const i = source?.messages.findIndex((m) => m.id === messageId) ?? -1;
    if (!b || !source || i < 0) return;
    const answer = source.messages[i];
    const question = source.messages.slice(0, i).reverse().find((m) => m.role === "user");
    const saved = newNote(b, { x: 0, y: 0 }, source.attachedTo);
    saved.title = (question?.text ?? answer.text).replace(/\s+/g, " ").slice(0, 60);
    saved.text = question ? `问：${question.text}\n\n${answer.text}` : answer.text;
    edit((cur) => ({
      ...cur,
      notes: [
        ...cur.notes.map((n) =>
          n.id === noteId
            ? { ...n, messages: n.messages.map((m) => (m.id === messageId ? { ...m, meta: { ...m.meta, savedNote: saved.id } } : m)) }
            : n,
        ),
        saved,
      ],
    }));
    showToast("已存成批注卡。⌘Z 可以撤销。");
  };
  function removeSelected() {
    if (!selection) return;
    if (
      selection.kind === "node" &&
      board &&
      rootsOf(board.nodes).length < 2 &&
      board.nodes.find((n) => n.id === selection.id)?.parentId === null
    ) {
      showToast("起点问题不能删除，地图都从这里长出来。");
      return;
    }
    edit((b) => removeSelection(b, selection));
    setSelection(null);
    showToast("已移除。⌘Z 可以撤销。");
  }
  /** 问 AI about several cards: a new conversation with all of them as context. */
  const askMany = useCallback(
    (ids: string[]) => {
      const b = boardRef.current;
      if (!b) return;
      chatSelection.current = ids;
      const first = chatContext(ids, undefined, (id) =>
        b.nodes.some((n) => n.id === id),
      ).anchor;
      if (!first) return;
      addNote({ kind: "node", id: first }, { fresh: true });
      setPicked([]);
      setSelection({ kind: "node", id: first });
    },
    [addNote],
  );
  const ask = useCallback(() => {
    if (chatSelection.current.length >= 2) askMany(chatSelection.current);
    else
      addNote(
        selectedNodeId ? { kind: "node", id: selectedNodeId } : undefined,
      );
    // A newly opened drawer focuses its composer itself. For one that was already
    // open, move focus there, but never steal it from a field inside the drawer
    // (the learner may already be typing a note).
    setTimeout(() => {
      if (document.activeElement?.closest(".drawer")) return;
      document
        .querySelector<HTMLTextAreaElement>(".drawer footer textarea")
        ?.focus();
    }, 60);
  }, [addNote, askMany, selectedNodeId]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => api.onFullscreenChange(setFullscreen), []);
  // Electron app menu: Settings… (⌘. and ⌘,).
  useEffect(
    () =>
      api.onOpenSettings?.(() => {
        setPalette(false);
        setShowSettings(true);
      }),
    [],
  );
  const chromeClasses = windowChromeClasses(api.platform, fullscreen);
  useEffect(() => {
    const root = document.documentElement.classList;
    for (const name of WINDOW_CHROME_CLASSES)
      root.toggle(name, chromeClasses.includes(name));
  }, [chromeClasses.join(" ")]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.matches(
        "input,textarea,select,[contenteditable=true]",
      );
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (mod && e.key === "\\" && !mobile) {
        e.preventDefault();
        setSidebarCollapsed((value) => !value);
        return;
      }
      // ⌘. as asked, plus the macOS-standard ⌘, (Ctrl+. / Ctrl+, elsewhere).
      if (mod && (e.key === "." || e.key === ",")) {
        e.preventDefault();
        setPalette(false);
        setShowSettings(true);
        return;
      }
      if (e.key === "Escape") {
        if (historyNoteId) {
          setHistoryNoteId(null);
          return;
        }
        if (showExport) {
          if (!transferBusy) setShowExport(false);
          return;
        }
        setShowNew(false);
        setShowSettings(false);
        setPromote(null);
        setPalette(false);
        if (!typing) {
          if (picked.length) setPicked([]);
          else if (drawer) closeDrawer();
          else setSelection(null);
          setTool("select");
        }
      }
      // While a title is being edited (focus may still be moving), keys are text.
      if (
        typing ||
        study ||
        palette ||
        editingId ||
        showExport ||
        transferBusy ||
        historyNoteId
      )
        return;
      const key = e.key.toLowerCase();
      if (mod && key === "n") {
        e.preventDefault();
        setShowNew(true);
      } else if (mod && key === "z") {
        e.preventDefault();
        undo();
      } else if (mod && key === "s") {
        e.preventDefault();
        void flush();
      } else if (mod) {
        return;
      } else if (e.key === "Tab") {
        e.preventDefault();
        const parent = selectedNodeId ?? rootId;
        if (parent) addChildOf(parent);
      } else if (e.key === "Enter" && selectedNodeId) {
        e.preventDefault();
        addSiblingOf(selectedNodeId);
      } else if (e.key === "F2" && selectedNodeId) {
        setEditingId(selectedNodeId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        removeSelected();
      } else if (key === "f") {
        setStudy({ startId: selectedNodeId ?? undefined });
      } else if (key === "v") setTool("select");
      else if (key === "h") setTool("hand");
      else if (key === "l") {
        setTool((t) => (t === "link" ? "select" : "link"));
      } else if (key === "n") {
        openNotes();
      } else if (e.key === "/") {
        e.preventDefault();
        if (picked.length >= 2) askMany(picked);
        else ask();
      } else if (key === "0") {
        flow.fitView({ padding: 0.16, duration: 400 });
      } else if (key === "d") {
        setDark((d) => !d);
      } else if (selectedNodeId && ["1", "2", "3"].includes(key)) {
        setStatus(
          selectedNodeId,
          (["unseen", "exploring", "explained"] as const)[Number(key) - 1],
        );
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  // Hold Space to pan with a left drag (left drag on empty canvas draws a marquee).
  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement)?.matches?.(
        "input,textarea,select,button,[contenteditable=true]",
      );
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e) && !e.repeat) {
        e.preventDefault();
        setSpacePan(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpacePan(false);
    const blur = () => setSpacePan(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  // Readiness signal for automation: set once a board is on screen, in the same
  // commit (and after) the shortcut listener above is attached.
  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-app-ready",
      loaded && !!board,
    );
  }, [loaded, board]);

  // ---- layout: positions come only from layoutTree (or a drag/insert preview)
  const shown =
    (canvasPreview?.id === board?.id ? canvasPreview : null) ??
    preview ??
    board;
  // Card widths come from the title; row tops from the measured card heights.
  const layoutOptions = useMemo(
    () => ({
      heights: new Map(
        Object.entries(measured).map(([id, size]) => [id, size.height]),
      ),
      widthOf: (n: { title: string }) => cardWidth(n.title),
    }),
    [measured],
  );
  const baseLayout = useMemo(
    () => layoutTree(board?.nodes ?? [], layoutOptions),
    [board?.nodes, layoutOptions],
  );
  const layout = useMemo(
    () =>
      shown === board
        ? baseLayout
        : layoutTree(shown?.nodes ?? [], layoutOptions),
    [shown, board, baseLayout, layoutOptions],
  );
  const slotRef = useRef<{ id: string; slot: Slot } | null>(null);
  configured.current = settings.configured;
  /**
   * One batched hint request per card (all its directions at once), only with a provider,
   * never while another hint is in flight, never twice for a card that has not changed, and
   * never again after a failure for the same card state.
   */
  const requestHints = useCallback((id: string) => {
    const b = boardRef.current;
    if (
      !b ||
      !configured.current ||
      editingLocked.current ||
      canvasWriteLocked.current
    )
      return;
    if (!b.nodes.some((n) => n.id === id) || cachedHints(b, id)) return;
    const signature = hintSignature(b, id);
    const key = `${id}|${signature}`;
    if (hintFailed.current.has(key) || hintBusy.current.size) return;
    const virtual = newNote(b, { x: 0, y: 0 }, { kind: "node", id });
    const request: AIRequest = {
      boardId: b.id,
      stickyId: "hint-" + id,
      requestId: uid(),
      mode: "hint",
      prompt: hintPrompt(b, id),
      context: contextForNote(
        { ...b, notes: [...b.notes, virtual] },
        virtual.id,
      ),
    };
    hintBusy.current.add(id);
    requestMeta.current.set(request.requestId, {
      request,
      anchor: id,
      hintSignature: signature,
    });
    api.ask(request).catch(() => {
      requestMeta.current.delete(request.requestId);
      hintBusy.current.delete(id);
      hintFailed.current.add(key);
    });
  }, []);
  /** Hover / selection: ask for a card's hints after it has had attention for a moment. */
  const wantHints = useCallback(
    (id: string, on: boolean) => {
      const timers = hintTimers.current;
      clearTimeout(timers.get(id));
      timers.delete(id);
      if (on && configured.current)
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            requestHints(id);
          }, HINT_DELAY),
        );
    },
    [requestHints],
  );
  useEffect(() => {
    const timers = hintTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);
  /** Clicking a ghost hint grows that card with the suggested title. */
  const growFromHint = useCallback(
    (from: string, side: HintSide, title: string, angle?: DigAngle) => {
      const b = boardRef.current;
      const node = b?.nodes.find((n) => n.id === from);
      if (!b || !node) return;
      // AI maps: a chosen hint below or beside a card becomes one gated card (real body + check
      // question), generated under the right parent. A broader parent above stays a plain title.
      const anchor = side === "below" ? from : side === "right" ? node.parentId : null;
      if (b.kind === "ai" && settings.configured && anchor) {
        setPreview(null);
        expand(anchor, angle, expandPrompt(b, anchor, angle) + hintCardNote(title), { selectNew: true });
        return;
      }
      const id = newId(
        node.parentId === null && side !== "below" ? "root" : "concept",
      );
      setPreview(null);
      edit((current) => {
        const grown =
          side === "below"
            ? addChild(current, from, id)
            : side === "above"
              ? addParent(current, from, id)
              : node.parentId === null
                ? addRoot(current, from, id)
                : addSibling(current, from, id);
        return {
          ...grown,
          nodes: grown.nodes.map((n) =>
            n.id === id
              ? { ...n, title, ...(angle ? { depthType: ANGLE_DEPTH[angle] } : {}) }
              : n,
          ),
        };
      });
      setSelection({ kind: "node", id });
    },
    [edit, expand, settings.configured],
  );
  const hoverAdd = useCallback((id: string | null) => {
    const b = boardRef.current;
    setPreview(id && b ? addChild(b, id, GHOST) : null);
  }, []);
  // After new cards land: one quiet follow-up for their diagrams and topic overviews.
  enrichRef.current = (b, anchor, ids) => {
    if (!configured.current) return;
    const anchorId =
      anchor && b.nodes.some((n) => n.id === anchor) ? anchor : rootOf(b)?.id;
    if (!anchorId) return;
    const virtual = newNote(b, { x: 0, y: 0 }, { kind: "node", id: anchorId });
    const request: AIRequest = {
      boardId: b.id,
      stickyId: "enrich-" + anchorId,
      requestId: uid(),
      mode: "enrich",
      prompt: enrichPrompt(b, ids),
      context: contextForNote(
        { ...b, notes: [...b.notes, virtual] },
        virtual.id,
      ),
    };
    requestMeta.current.set(request.requestId, {
      request,
      anchor: anchorId,
      newIds: ids,
    });
    api.ask(request).catch(() => requestMeta.current.delete(request.requestId));
  };
  const kickoffReady = needsKickoff(board) && !board?.probe && !mapBusy && !study;
  const drawerNote = board?.notes.find((n) => n.id === drawer?.id);
  // Before 应用: the open thread's pending route edit marks the stops it would replace or remove.
  const routePreview = useMemo(() => {
    const out = new Map<string, "replace" | "remove">();
    const waiting = pendingProposal(drawerNote)?.meta?.proposal;
    if (!board) return out;
    // 重做下层 marks the cards that would be replaced.
    if (waiting?.type === "reExpand") for (const id of descendantIds(board, waiting.targetId)) out.set(id, "replace");
    if (waiting?.type !== "editRoute") return out;
    for (const row of previewRoute(board, waiting.ops))
      if (row.nodeId && (row.kind === "replace" || row.kind === "remove")) out.set(row.nodeId, row.kind);
    return out;
  }, [board, drawerNote]);
  const drawerNoteAttachment = drawerNote?.attachedTo;
  const drawerAnchor =
    drawerNoteAttachment?.kind === "node" ? drawerNoteAttachment.id : null;
  /** Where 「铺成第一层」 lays cards: the anchor card, or the root for a free note. */
  const drawerAnchorOrRoot = drawerAnchor ?? (board && rootOf(board)?.id) ?? "";
  /** Bring a card and its children into the visible canvas; with onlyIfHidden, leave a visible card alone. */
  const frameFamily = useCallback(
    (anchorId: string, onlyIfHidden = false) => {
      const pane = document
        .querySelector(".react-flow")
        ?.getBoundingClientRect();
      const anchor = flow.getInternalNode(anchorId);
      if (!pane || !anchor?.measured.width) return;
      if (onlyIfHidden) {
        const a = anchor.internals.positionAbsolute;
        const tl = flow.flowToScreenPosition(a);
        const br = flow.flowToScreenPosition({
          x: a.x + anchor.measured.width,
          y: a.y + (anchor.measured.height ?? 0),
        });
        if (
          tl.x >= pane.left &&
          br.x <= pane.right - 36 &&
          tl.y >= pane.top &&
          br.y <= pane.bottom
        )
          return;
      }
      const ids = [
        anchorId,
        ...(boardRef.current?.nodes ?? [])
          .filter((n) => n.parentId === anchorId)
          .map((n) => n.id),
      ];
      const boxes = ids.flatMap((id) => {
        const n = flow.getInternalNode(id);
        if (!n?.measured.width) return [];
        const p = n.internals.positionAbsolute;
        return [
          {
            x: p.x,
            y: p.y,
            r: p.x + n.measured.width,
            b: p.y + (n.measured.height ?? 0),
          },
        ];
      });
      const x = Math.min(...boxes.map((b) => b.x)),
        y = Math.min(...boxes.map((b) => b.y));
      void flow.fitBounds(
        {
          x,
          y,
          width: Math.max(...boxes.map((b) => b.r)) - x,
          height: Math.max(...boxes.map((b) => b.b)) - y,
        },
        { padding: 0.18, duration: 320 },
      );
    },
    [flow],
  );
  // The drawer squeezes the canvas (CSS). Once the container has resized, bring
  // the anchor and its children into view, but only if the anchor is not
  // already visible: never move the viewport needlessly.
  useEffect(() => {
    if (!drawerAnchor) return;
    const t = setTimeout(() => frameFamily(drawerAnchor, true), 300);
    return () => clearTimeout(t);
  }, [drawerAnchor, frameFamily]);
  const numbers = useMemo(
    () => sectionNumbers(board?.nodes ?? []),
    [board?.nodes],
  );
  const nodes = useMemo<CanvasNode[]>(() => {
    if (!shown || !board) return [];
    const generatingCards = new Set<string>();
    for (const { request, anchor } of requestMeta.current.values()) {
      if (
        request.boardId !== board.id ||
        request.mode === "hint" ||
        !pending[`${request.boardId}/${request.stickyId}`]?.busy
      )
        continue;
      const attachment = board.notes.find(
        (note) => note.id === request.stickyId,
      )?.attachedTo;
      const cardId =
        anchor ?? (attachment?.kind === "node" ? attachment.id : undefined);
      if (cardId) generatingCards.add(cardId);
    }
    const out: CanvasNode[] = [];
    for (const n of shown.nodes) {
      const p = layout.positions.get(n.id);
      if (!p) continue;
      if (n.id === GHOST) {
        out.push({
          id: GHOST,
          type: "ghost",
          position: { x: p.x, y: p.y },
          width: p.w,
          height: 74,
          measured: { width: p.w, height: 74 },
          data: { w: p.w },
          draggable: false,
          selectable: false,
        });
        continue;
      }
      const dragging = dragPos?.id === n.id;
      if (dragging && slotRef.current)
        out.push({
          id: GHOST,
          type: "ghost",
          position: { x: p.x, y: p.y },
          width: p.w,
          height: 74,
          measured: { width: p.w, height: 74 },
          data: { w: p.w },
          draggable: false,
          selectable: false,
        });
      out.push({
        id: n.id,
        type: n.parentId === null ? "root" : "concept",
        position: dragging
          ? { x: dragPos.x, y: dragPos.y }
          : { x: p.x, y: p.y },
        width: p.w,
        measured: measured[n.id],
        draggable:
          n.parentId !== null && tool === "select" && editingId !== n.id,
        selected: selectedNodeId === n.id || picked.includes(n.id),
        className: dragging
          ? "is-dragging"
          : picked.length >= 2 && picked.includes(n.id)
            ? "is-picked"
            : undefined,
        data: {
          concept: n,
          multi: picked.length >= 2,
          noteOpen: drawerAnchor === n.id,
          no: numbers.get(n.id),
          topic: isQuestionRoot(board.nodes, n) ? board.topic : undefined,
          createdAt: board.createdAt,
          scene: board.scene,
          editing: editingId === n.id,
          linkMode: tool === "link",
          onRename: rename,
          onEditDone: () => setEditingId(null),
          onAddChild: addChildOf,
          onAddSibling: addSiblingOf,
          ...(n.parentId === null
            ? { onAddParent: addParentOf, onAddRoot: addRootBeside }
            : {}),
          onPreviewAdd: hoverAdd,
          station: stationOf(board, n.id),
          isNext: nextId === n.id,
          lit: !!board.wrap?.lit.includes(n.id),
          ...(routePreview.get(n.id) ? { preview: routePreview.get(n.id) } : {}),
          ...(flash.has(n.id) ? { flash: true } : {}),
          ...(nextId === n.id ? { onStartNext: () => startNextRef.current() } : {}),
          // Ghost hints only on the current stop or a card the learner picked (no 大海感).
          ...(settings.configured && tool === "select" && (!board.route?.length || nextId === n.id || selectedNodeId === n.id)
            ? {
                hints: cachedHints(board, n.id),
                onWantHints: wantHints,
                onHint: growFromHint,
              }
            : {}),
          onStatus: setStatus,
          onStartEdit: setEditingId,
          onAsk: (id: string) => addNote({ kind: "node", id }),
          onExpand: expand,
          canExpand:
            board.kind === "ai" ||
            (!n.expanded &&
              ["concept-dom", "concept-style", "concept-render"].includes(
                n.id,
              )),
          expandBusy: mapBusy,
          generating: generatingCards.has(n.id),
          onScene: (patch: Partial<Board["scene"]>) =>
            edit((b) => ({ ...b, scene: { ...b.scene, ...patch } }), false),
          onNote: (id: string) =>
            addNote({ kind: "node", id }, { cards: false }),
          ...(n.id === rootId && kickoffReady
            ? {
                onKickoff: startKickoff,
                kickoffStarted: Boolean(kickoffNote(board)?.messages.length),
              }
            : {}),

        },
      });
    }
    return out;
  }, [
    routePreview,
    flash,
    shown,
    board,
    layout,
    measured,
    dragPos,
    tool,
    editingId,
    selectedNodeId,
    rename,
    addChildOf,
    addSiblingOf,
    hoverAdd,
    setStatus,
    addNote,
    expand,
    reprobe,
    mapBusy,
    nextId,
    pending,
    edit,
    kickoffReady,
    startKickoff,
    drawerAnchor,
    numbers,
    picked,
    addParentOf,
    addRootBeside,
    settings.configured,
    wantHints,
    growFromHint,
  ]);
  const edges = useMemo<Edge[]>(() => {
    if (!shown) return [];
    const out: Edge[] = [];
    const by = new Map(shown.nodes.map((n) => [n.id, n]));
    for (const [parent, kids] of layout.children) {
      const real = kids.filter((k) => k !== GHOST);
      const pw = layout.positions.get(parent)?.w ?? 240;
      real.forEach((child, i) => {
        const k = real.length;
        // Fan out ±26px per edge on the parent's bottom edge, kept inside the card.
        const step = k > 1 ? Math.min(26, (pw - 48) / (k - 1)) : 0;
        out.push({
          id: `tree-${child}`,
          type: "tree",
          source: parent,
          target: child,
          sourceHandle: "b",
          targetHandle: "t",
          selectable: false,
          focusable: false,
          data: {
            offset: (i - (k - 1) / 2) * step,
            unseen: by.get(child)?.status === "unseen",
          },
        });
        if (i > 0)
          out.push({
            id: `seq-${real[i - 1]}-${child}`,
            type: "seq",
            source: real[i - 1],
            target: child,
            sourceHandle: "b",
            targetHandle: "t",
            selectable: false,
            focusable: false,
          });
      });
    }
    for (const r of shown.relations)
      out.push({
        id: r.id,
        type: "cross",
        source: r.source,
        target: r.target,
        sourceHandle: "b",
        targetHandle: "t",
        selected: selection?.kind === "relation" && selection.id === r.id,
        data: { label: r.label },
      });
    return out;
  }, [shown, layout, selection]);
  // Positions are controlled by layoutTree; only drag offsets and measured
  // sizes (needed by the minimap) flow back from React Flow.
  const panEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const boxing = useRef<{ base: string[]; inside: Set<string> } | null>(null);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const sizes: Record<string, { width: number; height: number }> = {};
    const box = boxing.current;
    if (box && changes.some((c) => c.type === "select")) {
      for (const c of changes)
        if (c.type === "select" && c.id !== GHOST)
          c.selected ? box.inside.add(c.id) : box.inside.delete(c.id);
      const next = boxPick(
        { single: null, picked: box.base },
        [...box.inside],
        box.base.length > 0,
      );
      setPicked(next.picked);
      setSelection(next.single ? { kind: "node", id: next.single } : null);
    }
    for (const c of changes) {
      if (c.type === "position" && c.dragging && c.position)
        setDragPos({ id: c.id, x: c.position.x, y: c.position.y });
      if (c.type === "dimensions" && c.dimensions) sizes[c.id] = c.dimensions;
    }
    if (Object.keys(sizes).length) setMeasured((m) => ({ ...m, ...sizes }));
  }, []);
  const onNodeDrag = useCallback(
    (_: unknown, node: CanvasNode) => {
      const b = boardRef.current;
      if (!b) return;
      const w = baseLayout.positions.get(node.id)?.w ?? 240;
      const heights = new Map(
        b.nodes.map((n) => [
          n.id,
          flow.getInternalNode(n.id)?.measured.height ?? 130,
        ]),
      );
      const slot = insertSlot(
        node.id,
        { x: node.position.x + w / 2, y: node.position.y },
        b.nodes,
        baseLayout,
        heights,
      );
      const key = slot ? JSON.stringify(slot) : "";
      if (key === (slotRef.current ? JSON.stringify(slotRef.current.slot) : ""))
        return;
      slotRef.current = slot ? { id: node.id, slot } : null;
      setPreview(slot ? applySlot(b, node.id, slot) : null);
    },
    [baseLayout, flow],
  );
  const onNodeDragStop = useCallback(() => {
    const s = slotRef.current;
    slotRef.current = null;
    setDragPos(null);
    setPreview(null);
    if (s) edit((b) => applySlot(b, s.id, s.slot));
  }, [edit]);
  const connect = useCallback(
    (c: Connection) => {
      setTool("select");
      if (!c.source || !c.target || c.source === c.target) return;
      edit((b) =>
        b.relations.some((r) => r.source === c.source && r.target === c.target)
          ? b
          : {
              ...b,
              relations: [
                ...b.relations,
                {
                  id: newId("relation"),
                  source: c.source,
                  target: c.target,
                  label: "关联",
                  kind: "cross",
                },
              ],
            },
      );
      showToast("已连上一条交叉链接。选中它可以改标签。");
    },
    [edit, showToast],
  );
  const bounds = useMemo(() => {
    const ps = [...baseLayout.positions.values()];
    return {
      rows: baseLayout.rows,
      left: Math.min(0, ...ps.map((p) => p.x)),
      right: Math.max(0, ...ps.map((p) => p.x + p.w)),
    };
  }, [baseLayout]);
  const selectedRelation = board?.relations.find(
    (r) => selection?.kind === "relation" && r.id === selection.id,
  );
  if (!loaded)
    return (
      <div className="loading-screen">
        <p>铺开你的学习地图…</p>
      </div>
    );
  return (
    <main
      style={{ "--sidebar-expanded-w": `${sidebarWidth}px` } as CSSProperties}
      className={`app tool-${tool} ${sidebarResizing ? "sidebar-resizing" : ""} ${!mobile ? "with-sidebar" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${drawerNote ? "with-drawer" : ""} ${spacePan ? "space-pan" : ""} ${panning ? "is-panning" : ""}`}
    >
      <div className="grain" />
      <input
        ref={importInput}
        type="file"
        accept=".json,application/json"
        aria-label="选择学习数据文件"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void importBoardFile(file);
        }}
      />
      <TooltipLayer />
      {board && showCanvasActivity && (
        <CanvasActivity
          board={board}
          runs={canvasRuns.filter((run) => run.boardId === board.id)}
          onClose={() => setShowCanvasActivity(false)}
          onResume={(run) =>
            void api
              .resumeCanvasRun(run.boardId, run.id)
              .catch((error) => showToast(errorText(error)))
          }
          onCancel={(run) =>
            void api
              .cancelCanvasRun(run.boardId, run.id)
              .catch((error) => showToast(errorText(error)))
          }
          onRestore={(archiveId) => {
            const noteId = addNote(undefined, { fresh: true });
            if (noteId) {
              setShowCanvasActivity(false);
              askNote(
                noteId,
                `请恢复源记录 ${archiveId} 对应的原卡片，保留原内容和笔记关联。`,
              );
            }
          }}
        />
      )}
      {transferBusy && !showExport && (
        <div className="map-progress lab" role="status">
          <LoaderCircle size={14} className="spin" />
          正在导入画板与对话…
        </div>
      )}
      {chromeClasses.includes("mac-titlebar") && (
        <div className="titlebar-drag" aria-hidden="true" />
      )}
      {closing && (
        <div className="closing-overlay" role="status">
          <LoaderCircle size={18} />
          正在保存全部地图…
        </div>
      )}
      {board && mobile && (
        <Outline
          board={board}
          onStatus={(id, s) => setStatus(id, s)}
          onOpen={() => setPalette(true)}
          onStudy={() => setStudy({})}
        />
      )}
      {board && !mobile && (
        <>
          <div
            className={`canvas-interaction ${canvasLocked ? "canvas-edit-locked" : ""}`}
          >
            <ReactFlow<CanvasNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onConnect={connect}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={70}
              nodesConnectable={tool === "link" && !canvasLocked}
              nodesDraggable={!canvasLocked}
              onNodeClick={(e, n) => {
                if (n.type === "ghost") return;
                if (canvasWriteLocked.current) {
                  setSelection({ kind: "node", id: n.id });
                  return;
                }
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
                  const next = toggleCard(
                    { single: selectedNodeId, picked },
                    n.id,
                  );
                  setPicked(next.picked);
                  setSelection(
                    next.single ? { kind: "node", id: next.single } : null,
                  );
                  return;
                }
                setPicked([]);
                setSelection({ kind: "node", id: n.id });
                addNote(
                  { kind: "node", id: n.id },
                  { cards: false, autoFocus: false },
                );
              }}
              onNodeDoubleClick={(_, n) => {
                if (!canvasWriteLocked.current && n.type !== "ghost")
                  setEditingId(n.id);
              }}
              onEdgeClick={(_, e) =>
                e.type === "cross" &&
                setSelection({ kind: "relation", id: e.id })
              }
              onPaneClick={() => {
                if (boxing.current) return;
                setPicked([]);
                setSelection(null);
                setEditingId(null);
                setDrawer(null);
              }}
              onPaneContextMenu={(e) => {
                e.preventDefault();
                addNote(undefined, { cards: false });
              }}
              fitView
              fitViewOptions={{ padding: 0.16 }}
              minZoom={0.1}
              maxZoom={1.8}
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              // Left drag on empty canvas draws a marquee (select tool). Panning:
              // two-finger scroll, Space-drag, middle/right drag, or the hand tool.
              selectionOnDrag={tool === "select" && !spacePan}
              selectionMode={SelectionMode.Partial}
              onSelectionStart={(e) => {
                boxing.current = {
                  base:
                    e.shiftKey || e.metaKey || e.ctrlKey
                      ? picked.length
                        ? picked
                        : selectedNodeId
                          ? [selectedNodeId]
                          : []
                      : [],
                  inside: new Set(),
                };
              }}
              onSelectionEnd={() => {
                // Let the pane click that ends the drag see we were boxing.
                setTimeout(() => (boxing.current = null), 0);
              }}
              panOnScroll
              panOnDrag={tool === "hand" || spacePan ? true : [1, 2]}
              onMoveStart={(e) => {
                // Panning, not zooming: a drag, or a scroll without the pinch/ctrl modifier.
                if (!e) return;
                if (e.type === "wheel" && (e as WheelEvent).ctrlKey) return;
                clearTimeout(panEnd.current);
                setPanning(true);
              }}
              onMoveEnd={() => {
                clearTimeout(panEnd.current);
                panEnd.current = setTimeout(() => setPanning(false), 450);
              }}
              zoomOnDoubleClick={false}
              nodeDragThreshold={4}
              proOptions={{ hideAttribution: true }}
            >
              <LevelGuides {...bounds} />
              <TopicOverviews
                board={board}
                layout={baseLayout}
                heights={layoutOptions.heights}
                suspended={!!editingId || !!dragPos || !!preview || organizing}
              />
              <MapUnit showMap={panning || tool === "hand"} />
            </ReactFlow>
            <WorkspaceSidebar
              boards={boards
                .filter((b) => !b.archivedAt)
                .map((b) => (b.id === board.id ? { ...b, title: board.title, ...boardProgress(board) } : b))}
              currentId={board.id}
              collapsed={sidebarCollapsed}
              switchingId={switchingBoardId}
              width={sidebarWidth}
              onWidthChange={setSidebarWidth}
              onResizingChange={setSidebarResizing}
              onToggle={() => setSidebarCollapsed((value) => !value)}
              onPick={(id) => void switchBoard(id)}
              onArchive={(id) => void setBoardArchived(id, true)}
              onNew={() => setShowNew(true)}
              onSearch={() => setPalette(true)}
              onSettings={() => setShowSettings(true)}
              sessions={listSessions(board)}
              currentSessionId={drawer?.id}
              onOpenSession={(boardId, sessionId) =>
                openSession(boardId, sessionId)
              }
              onNewSession={() => addNote(undefined, { fresh: true })}
            />
            {(() => {
              const paused = canvasRuns.filter((r) => r.boardId === board.id && r.status === "paused").length;
              // Always listed; disabled with the reason when it can't run.
              const reprobeBlocked =
                board.kind !== "ai"
                  ? "示例画布没有摸底"
                  : !settings.configured
                    ? "先在设置里连接 AI"
                    : board.probe?.status === "asking" || probeBusy
                      ? "摸底正在进行"
                      : undefined;
              return (
                <div className="canvas-corner">
                  {paused > 0 && <PausedPill onOpen={() => setShowCanvasActivity(true)} />}
                  <Progress nodes={board.nodes} />
                  <CanvasMenu
                    paused={paused}
                    onReprobe={reprobe}
                    {...(reprobeBlocked ? { reprobeBlocked } : {})}
                    onActivity={() => setShowCanvasActivity(true)}
                    onExport={() => setShowExport(true)}
                    onArchive={() => void setBoardArchived(board.id, true)}
                  />
                </div>
              );
            })()}
            {!drawer && (
              <NextStepBar
                step={next}
                welcome={welcome}
                onStart={() => startNextRef.current()}
                onSkip={
                  "card" in next
                    ? () => setSkipped((prev) => new Set([...prev, next.card.id]))
                    : undefined
                }
                onRoute={() => edit((b) => ({ ...b, route: defaultRoute(b) }))}
              />
            )}
            <CoveragePanel board={board} busy={mapBusy} onCover={coverBlock} />
            <Dock
              tool={tool}
              setTool={setTool}
              onAddConcept={() => {
                const parent = selectedNodeId ?? rootId;
                if (parent) addChildOf(parent);
              }}
              onNote={openNotes}
              onAsk={ask}
              onStudy={() => setStudy({ startId: selectedNodeId ?? undefined })}
              canStudy={board.nodes.some((n) => n.parentId !== null)}
              onOrganize={organizeBoard}
              organizeDisabled={
                organizing ||
                mapBusy ||
                Object.values(pending).some((request) => request.busy)
              }
            />
            {tool === "link" && (
              <div className="hint lab">
                连线：从一张卡拖到另一张卡 · Esc 取消
              </div>
            )}
            {picked.length >= 2 && (
              <div
                className="chrome relation-bar multi-bar"
                role="toolbar"
                aria-label="多选"
              >
                <span className="lab">已选 {picked.length} 张卡</span>
                <button
                  className="btn sm primary"
                  onClick={() => askMany(picked)}
                >
                  问 AI <kbd>/</kbd>
                </button>
                <button className="btn sm" onClick={() => setPicked([])}>
                  清除
                </button>
              </div>
            )}
            {selectedRelation && (
              <div className="chrome relation-bar">
                <span className="lab">交叉链接</span>
                <input
                  aria-label="关系标签"
                  value={selectedRelation.label}
                  onChange={(e) =>
                    edit(
                      (b) => ({
                        ...b,
                        relations: b.relations.map((r) =>
                          r.id === selectedRelation.id
                            ? { ...r, label: e.target.value }
                            : r,
                        ),
                      }),
                      false,
                    )
                  }
                />
                <button
                  className="btn"
                  onClick={() =>
                    addNote({ kind: "relation", id: selectedRelation.id })
                  }
                >
                  问为什么
                </button>
                <button className="btn" onClick={removeSelected}>
                  删除
                </button>
              </div>
            )}
          </div>
          {currentCanvasRun && (
            <div
              className="canvas-run-progress chrome"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <CanvasRunProgress run={currentCanvasRun} />
              <button
                className="btn sm"
                onClick={() =>
                  void api
                    .cancelCanvasRun(
                      currentCanvasRun.boardId,
                      currentCanvasRun.id,
                    )
                    .catch((error) => showToast(errorText(error)))
                }
              >
                取消
              </button>
              <button
                className="btn sm"
                onClick={() => setShowCanvasActivity(true)}
              >
                查看改动
              </button>
            </div>
          )}
          {mapBusy && (
            <div className="map-progress lab">
              <LoaderCircle size={14} /> 正在搭建下一小步…
            </div>
          )}
        </>
      )}
      {board && drawer && drawerNote && (
        <Drawer
          key={drawerNote.id}
          note={drawerNote}
          opening={drawer}
          anchor={shown?.nodes.find((n) => n.id === drawerNote.attachedTo?.id)}
          anchorTitle={
            shown?.nodes.find((n) => n.id === drawerNote.attachedTo?.id)?.title
          }
          refs={
            contextForNote(
              board,
              drawerNote.id,
              selection?.kind === "note" ? null : selection,
              true,
              "references",
            ).references
          }
          nodes={board.nodes}
          onRetry={() => {
            const q = drawerNote.messages
              .filter((m) => m.role === "user")
              .at(-1);
            if (q) askNote(drawerNote.id, q.text, true);
          }}
          pending={pending[`${board.id}/${drawerNote.id}`]?.text}
          busy={pending[`${board.id}/${drawerNote.id}`]?.busy}
          canvasRun={canvasRuns.find(
            (run) =>
              run.boardId === board.id &&
              run.stickyId === drawerNote.id &&
              ["running", "ready"].includes(run.status),
          )}
          error={pending[`${board.id}/${drawerNote.id}`]?.error}
          onChange={(patch) =>
            edit(
              (b) => ({
                ...b,
                notes: b.notes.map((n) =>
                  n.id === drawerNote.id ? { ...n, ...patch } : n,
                ),
              }),
              false,
            )
          }
          onAsk={(prompt) => askNote(drawerNote.id, prompt)}
          onHistory={() => setHistoryNoteId(drawerNote.id)}
          kickoff={
            needsKickoff(board) && kickoffNote(board)?.id === drawerNote.id
              ? {
                  onAccept: proposeFirstLevel,
                  busy: mapBusy,
                  planning: planBusy,
                  plan: board.plan,
                  onPlanChange: editPlan,
                  onPlanConfirm: confirmBoardPlan,
                  onReplan: () => {
                    editPlan(undefined);
                    const b = boardRef.current;
                    if (b) requestPlan({ ...b, plan: undefined });
                  },
                }
              : undefined
          }
          onStop={() =>
            void api
              .stop(board.id, chatActive.current.get(drawerNote.id) ?? drawerNote.id)
              .catch((e) => showToast(errorText(e)))
          }
          chat={{
            board,
            generating: mapBusy,
            onApply: (id) => proposalActRef.current(drawerNote.id, id, "apply"),
            onUndo: (id) => proposalActRef.current(drawerNote.id, id, "undo"),
            onCancel: (id) => proposalActRef.current(drawerNote.id, id, "cancel"),
            onStart: (id) => proposalActRef.current(drawerNote.id, id, "start"),
            onSave: (id) => saveChatAnswer(drawerNote.id, id),
          }}
          onPromote={(text) =>
            setPromote({ noteId: drawerNote.id, title: "新的发现", text })
          }
          lead={(() => {
            const id = drawerNote.attachedTo?.kind === "node" ? drawerNote.attachedTo.id : undefined;
            const root = questionNode(board);
            if (!id || id !== root?.id || board.kind !== "ai") return undefined;
            const stations = board.route?.length ?? 0;
            if (next.kind === "wrap" || next.kind === "wrapped")
              return <WrapPanel board={board} stations={stations} onSubmit={submitWrap} />;
            if (!board.probe) return undefined;
            return (
              <>
                <ProbePanel
                  state={board.probe}
                  busy={probeBusy}
                  phase={probePhase ?? (board.probe.status !== "asking" && !stations && planBusy ? "result" : null)}
                  topic={board.topic}
                  stations={stations}
                  {...(board.probe.status !== "asking" && (stations || board.plan) ? { onStart: closeDrawer } : {})}
                  {...(board.probe.status !== "asking" && board.probe.ladder.length ? { onRestart: reprobe } : {})}
                  onAnswer={(c, t) => void answerProbeQ(c, t)}
                  onSkip={skipProbeQ}
                  {...(stations ? { onFromStart: fromStart } : {})}
                />
              </>
            );
          })()}
          study={(() => {
            const id = drawerNote.attachedTo?.kind === "node" ? drawerNote.attachedTo.id : undefined;
            const card = id ? board.nodes.find((n) => n.id === id) : undefined;
            // The four beats belong to cards on the route and anything below them; the question root has none.
            if (!card || card.parentId === null || board.kind !== "ai" || !board.route?.length) return undefined;
            return {
              station: stationOf(board, card.id),
              onPatch: (patch: Partial<ConceptNode>) => {
                if (patch.seal === "test") {
                  edit((b) => afterChildSealed({ ...b, nodes: b.nodes.map((x) => (x.id === card.id ? { ...x, ...patch } : x)) }, card.id));
                  return;
                }
                patchNode(card.id, patch);
              },
              onRecheckFail: () => {
                edit((b) => failRecheck(b, card.id, nextId ?? undefined));
                showToast("去掉了浅印：这一站排在下一步之后，再走一遍 4 拍。");
              },
              stuck: isStuck(card) ? (
                <StuckExits
                  busy={stuckBusy?.id === card.id ? stuckBusy.kind : mapBusy ? "split" : undefined}
                  onSplit={() => splitStuck(card.id)}
                  onAnalogy={() => void analogyStuck(card.id)}
                  onLater={() => {
                    edit((b) => putOff(b, card.id));
                    closeDrawer();
                  }}
                />
              ) : undefined,
              onMark: (kind: "explain" | "test", answer: string, choice: number | null) =>
                markCard(card.id, kind, answer, choice),
            };
          })()}
          anchorHasChildren={board.nodes.some(
            (n) => n.parentId === drawerAnchorOrRoot,
          )}
          onLay={(items, messageId) => {
            const ids = items.map(() => newId("concept"));
            edit((b) => {
              const laid = layOutline(
                b,
                drawerAnchorOrRoot,
                items.map((i) => ({ head: i.head, body: plain(i.rest) })),
                ids,
                messageId ? { noteId: drawerNote.id, messageId } : undefined,
              );
              // Laying the first level under the question draws the numbered route.
              return !laid.route?.length && drawerAnchorOrRoot === questionNode(laid)?.id
                ? { ...laid, route: defaultRoute(laid) }
                : laid;
            });
            showToast(
              ids.length > 1
                ? `已铺成 ${ids.length} 张卡，⌘Z 可以撤销。`
                : `已加成一张卡：${items[0].head}。⌘Z 可以撤销。`,
            );
            setTimeout(() => frameFamily(drawerAnchorOrRoot), 120);
          }}
          onLocate={() => {
            setSelection({ kind: "node", id: drawerAnchorOrRoot });
            frameFamily(drawerAnchorOrRoot);
          }}
          onRemove={() => {
            edit((b) =>
              removeSelection(b, { kind: "note", id: drawerNote.id }),
            );
            setDrawer(null);
            showToast("已删除这张批注。⌘Z 可以撤销。");
          }}
          onClose={closeDrawer}
          onNewSession={() => addNote(drawerNote.attachedTo, { fresh: true })}
        />
      )}
      {board && study && (
        <StudyMode
          board={board}
          startId={study.startId}
          onRate={setStatus}
          onAskAI={(id, text) => {
            setStudy(null);
            // The explanation goes out as the question; the drawer has no note field.
            const noteId = addNote({ kind: "node", id }, { fresh: true, cards: false });
            if (noteId) askNote(noteId, `请检查我的理解：\n${text}`);
          }}
          onClose={() => setStudy(null)}
        />
      )}
      {palette && (
        <Palette
          boards={boards.filter((b) => !b.archivedAt)}
          footer={`${isDesktop ? "白板保存在这台 Mac" : "浏览器预览 · 仅当前浏览器保存"} · ${saveStatus === "saving" ? "保存中" : saveStatus === "saved" ? "已保存" : "保存失败"}`}
          currentId={board?.id}
          onClose={() => setPalette(false)}
          onPick={(id) => {
            setPalette(false);
            void switchBoard(id);
          }}
          onNew={() => {
            setPalette(false);
            setShowNew(true);
          }}
          onWalkthrough={() => {
            setPalette(false);
            void createBoard(true);
          }}
          onSettings={() => {
            setPalette(false);
            setShowSettings(true);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button {...tip("关闭提示")} onClick={() => setToast("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {showSettings && (
        <Settings
          settings={settings}
          archivedBoards={boards.filter((b) => !!b.archivedAt)}
          archiveBusy={switchingBoardId !== null || organizing}
          onRestore={(id) => void setBoardArchived(id, false)}
          boardTitle={board?.title}
          transferBusy={transferBusy || switchingBoardId !== null}
          onImport={() => importInput.current?.click()}
          onExport={() => setShowExport(true)}
          dark={dark}
          onTheme={setDark}
          onClose={() => setShowSettings(false)}
          onSave={async (input) => {
            setSettings(await api.setAISettings(input));
          }}
          onTest={(input) => api.testAIConnection(input)}
        />
      )}
      {showExport && board && (
        <BoardExport
          title={board.title}
          busy={transferBusy}
          onExport={exportCurrentBoard}
          onClose={() => setShowExport(false)}
        />
      )}
      {historyNoteId && board?.notes.some((n) => n.id === historyNoteId) && (
        <ConversationHistory
          boardId={board.id}
          note={board.notes.find((n) => n.id === historyNoteId)!}
          onClose={() => setHistoryNoteId(null)}
        />
      )}
      {showNew && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setShowNew(false)}
        >
          <section
            className="modal new-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
          >
            <button
              className="modal-close icon-button"
              onClick={() => setShowNew(false)}
              {...tip("关闭", "Esc")}
            >
              <X size={19} />
            </button>
            <span className="eyebrow">一张新地图</span>
            <h2 id="new-title">什么，让你好奇？</h2>
            <p>写下一个问题。接下来我们把它排成一条路线，每站走 4 拍：猜 · 学 · 讲 · 测——你始终知道下一步做什么。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createBoard();
              }}
            >
              <textarea
                autoFocus
                aria-label="新白板问题"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="比如：神经网络到底是怎么学习的？"
                maxLength={500}
              />
              <button
                className="btn primary"
                disabled={!topic.trim()}
                type="submit"
              >
                开始探索 <ArrowRight size={16} />
              </button>
            </form>
            <button
              className="text-button"
              onClick={() => void createBoard(true)}
            >
              或先试试内置演练：浏览器如何把代码变成画面？
            </button>
          </section>
        </div>
      )}
      {promote && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="promote-title"
          >
            <button
              className="modal-close icon-button"
              onClick={() => setPromote(null)}
              {...tip("关闭", "Esc")}
            >
              <X size={19} />
            </button>
            <span className="eyebrow">由你决定</span>
            <h2 id="promote-title">把有用的部分，放进地图</h2>
            <p>先压缩成自己的话。这不会替你标记为“已理解”。</p>
            <label>
              概念名称
              <input
                value={promote.title}
                onChange={(e) =>
                  setPromote({ ...promote, title: e.target.value })
                }
                maxLength={100}
              />
            </label>
            <label>
              保留这段解释
              <textarea
                rows={7}
                value={promote.text}
                onChange={(e) =>
                  setPromote({ ...promote, text: e.target.value })
                }
                maxLength={3000}
              />
            </label>
            <button
              className="btn primary"
              disabled={!promote.title.trim() || !promote.text.trim()}
              onClick={() => {
                const p = promote;
                const id = newId("concept");
                edit((b) => {
                  const note = b.notes.find((n) => n.id === p.noteId);
                  const parent =
                    note?.attachedTo?.kind === "node"
                      ? note.attachedTo.id
                      : (rootOf(b)?.id ?? "");
                  const next = addChild(b, parent, id);
                  return {
                    ...next,
                    nodes: next.nodes.map((n) =>
                      n.id === id
                        ? {
                            ...n,
                            title: p.title.trim(),
                            body: p.text.trim().slice(0, 4000),
                            status: "exploring" as const,
                          }
                        : n,
                    ),
                  };
                });
                setPromote(null);
                showToast("已加入地图，原回答仍保留在批注中。");
              }}
            >
              加入地图 <Plus size={16} />
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
