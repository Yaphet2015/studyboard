export type Point = { x: number; y: number };
export type Understanding = "unseen" | "exploring" | "explained";
export interface VisualDiagram {
  kind: "process" | "parts" | "comparison";
  title?: string;
  labels: string[];
  caption?: string;
  basis: "literal" | "analogy";
}
/** AI ghost hints cached on a card, one short suggestion per direction it can grow. */
export interface CardHints {
  /** hintSignature() when they were made; stale hints are asked for again. */
  sig: string;
  below?: string;
  right?: string;
  above?: string;
  /** Which way each side's suggestion digs (why/how/example/edge/compare/apply). */
  angles?: Partial<Record<"below" | "right" | "above", HintAngle>>;
  /** Extra child suggestions, each from a different angle than `below`. */
  more?: { angle: HintAngle; text: string }[];
}
export type HintAngle = "why" | "how" | "example" | "edge" | "compare" | "apply";
export interface ConceptNode {
  id: string;
  kind: "concept" | "scene";
  title: string;
  body: string;
  /** null for a top-level card (a root). Tree edges are implied by parentId. */
  parentId: string | null;
  /**
   * The board's original question, once roots have grown above or beside it. Absent on
   * older boards: the leftmost root is the question then.
   */
  question?: boolean;
  /** Cached ghost hints for the '+' handles (optional; older boards have none). */
  hints?: CardHints;
  /** Cached zoom overview; sig covers the subtree's content and structure. */
  overview?: { summary: string; sig: string };
  /** Position among siblings (0-based, contiguous); also reads as 先→后. */
  order: number;
  /** Derived from the parentId chain; never persisted. */
  level?: number;
  status: Understanding;
  /** Handwritten margin remark shown under the body. */
  hand?: string;
  expanded?: boolean;
  visual?: VisualDiagram;
  /** The board plan block this card realises (board.plan); optional. */
  planBlock?: string;
  /** Rich card content (PR-C); every field optional, older boards have none. */
  summary?: string;
  keyPoints?: string[];
  whyItMatters?: string;
  example?: string;
  misconception?: string;
  depthType?: DepthType;
  sources?: CardSource[];
  /** The 测 question: learner-visible text only (q and choice options). */
  check?: CardCheck;
  /** Where the learner is in this stop's four beats (先猜 → 学 → 讲 → 测). */
  beat?: Beat;
  /** Wrong 测 answers so far (two open the stuck exits). */
  fails?: number;
  /** The learner's own 先猜 and 讲 text. */
  guess?: string;
  explain?: string;
  /** How the A seal was earned: by passing 测, or inferred from 摸底. */
  seal?: "test" | "probe";
  /** 换个类比: a second explanation the learner asked for when stuck (shown in 学). */
  analogy?: string;
  /** Internal data, never rendered or exported. */
  meta?: CardMeta;
}
export type Beat = "guess" | "learn" | "explain" | "test" | "done";
export interface CardCheck {
  q: string;
  options?: string[];
}
export interface GateSubstance {
  kind: string;
  text: string;
  isExample?: boolean;
  source?: string;
}
/** The new-knowledge gate's working data: structure, claims and scores. Never shown to the learner. */
export interface GateMeta {
  newIdea?: string;
  substance?: GateSubstance[];
  addsBeyond?: string;
  claims?: string[];
  /** Highest claim similarity to the parent card and to any card on the board. */
  simParent?: number;
  simMax?: number;
  /** "cheap" when only local checks ran; "judge" when the LLM rubric judge decided. */
  decidedBy?: "cheap" | "judge";
  judgeAdds?: string;
  regenerated?: boolean;
}
export interface CardMeta {
  gate?: GateMeta;
  /** 测 marking data: the key points and (for choice questions) the right option. */
  check?: { keyPoints: string[]; answer?: number };
  /** The 讲/测 marker said a key point was missed (next-step rule 5). */
  missed?: string;
  /** The depth-ladder level this station teaches (摸底 maps the frontier onto it). */
  level?: number;
  /** Split from a stuck stop (往下拆): learning it sends the learner back to the parent's 测. */
  split?: boolean;
  /** 稍后: the learner put this stuck stop off; it goes to the end of the queue. */
  later?: boolean;
}
/** The depth ladder: what → why → how → edge → apply; compare sits beside it. */
export type DepthType = "what" | "why" | "how" | "edge" | "apply" | "compare";
export interface CardSource {
  title: string;
  url?: string;
}
export interface Relation {
  id: string;
  source: string;
  target: string;
  label: string;
  /** Only cross-links are stored; they never affect layout. */
  kind: "cross";
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Renderer-only state for an answer, e.g. ticked 小练习 steps. Optional: older boards have none. */
  meta?: {
    checked?: number[];
    laid?: boolean;
    /** A turn of the post-probe chat (v2): kept even when the runtime transcript lacks it. */
    chat?: boolean;
    /** At most one proposal per chat answer, with its state in the thread. */
    proposal?: ChatProposal;
    /** The 批注卡 this answer was saved into. */
    savedNote?: string;
  };
}
/** Route edits a chat answer can propose; stops are 1-based station numbers. */
export type RouteOp =
  | { op: "add"; title: string; after: number }
  | { op: "remove"; stop: number }
  | { op: "move"; stop: number; to: number }
  | { op: "replace"; stop: number; title: string }
  | { op: "focus"; stop: number; text: string };
export interface RouteDiffRow {
  kind: "keep" | "replace" | "remove" | "add" | "move" | "focus";
  /** Station number before the change (undefined for a new stop). */
  from?: number;
  /** Station number after the change (undefined for a removed stop). */
  to?: number;
  title: string;
  /** The old title, for a replaced stop. */
  was?: string;
  focus?: string;
  /** Sealed (已讲通) stops that remove/replace archives. */
  archives?: boolean;
  nodeId?: string;
}
export type ProposalState = "pending" | "applied" | "undone" | "cancelled" | "expired";
export type ChatProposal =
  /** rows: the diff as it was when applied, so the thread still reads right afterwards. */
  | { type: "editRoute"; ops: RouteOp[]; state: ProposalState; rows?: RouteDiffRow[] }
  | { type: "startStop"; stop: number; stopId: string; state: ProposalState }
  /**
   * 重做下层: regenerate the cards directly below one card by the learner's instruction. replaces and
   * below (the grandchildren and deeper) are counted when proposed; added once it has been applied.
   */
  | {
      type: "reExpand";
      targetId: string;
      title: string;
      instruction: string;
      replaces: number;
      below: number;
      added?: number;
      state: ProposalState;
    };
export interface StickyNote {
  id: string;
  title: string;
  text: string;
  position: Point;
  attachedTo?: { kind: "node" | "relation"; id: string };
  messages: ChatMessage[];
  /** References the learner unticked: they are not sent to the AI. */
  excludedRefs?: string[];
  /** Extra cards the learner chose as context (multi-select or the picker). */
  contextCards?: string[];
  /** When the conversation started; older notes have none. */
  createdAt?: string;
  /** Set on a 批注卡 made from a legacy 我的笔记 text; the source note's id. */
  meta?: { migratedFrom?: string };
}
export interface SceneState {
  width: number;
  color: string;
  prediction: string;
  explanation: string;
  changed: "width" | "color" | null;
}
export interface CanvasArchive {
  id: string;
  runId: string;
  reason: string;
  node: ConceptNode;
  relations: Relation[];
  children?: Pick<ConceptNode, "id" | "parentId" | "order">[];
  noteBindings: {
    id: string;
    attachedTo?: StickyNote["attachedTo"];
    contextCards?: string[];
  }[];
  mergedInto?: string;
  createdAt: string;
}
export interface Board {
  version: 3;
  id: string;
  title: string;
  topic: string;
  kind: "walkthrough" | "ai";
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  canvasVersion?: string;
  appliedCanvasRuns?: string[];
  cardArchives?: CanvasArchive[];
  nodes: ConceptNode[];
  relations: Relation[];
  notes: StickyNote[];
  scene: SceneState;
  viewport?: { x: number; y: number; zoom: number };
  /** The learning plan behind the map (optional; older boards have none). */
  plan?: BoardPlan;
  /** The numbered learning path: card ids in recommended order (第 1 站, 第 2 站…). */
  route?: string[];
  /** The bisection 摸底: the depth ladder, the answers and the converged frontier. */
  probe?: ProbeState;
  /** 合起来讲 on the root: the learner's wrap-up and the stations it lit up. */
  wrap?: { text: string; lit: string[]; missing?: string; done: boolean };
  /** Stamped on save for the sidebar list (model/progress.ts); older boards are backfilled on list. */
  progress?: BoardProgress;
  sessionCount?: number;
}
export type ProbeVerdict = "correct" | "partial" | "wrong" | "unsure";
/** One concept point of the probe's internal chain (shallow → deep). Never shown as a level. */
export interface LadderLevel {
  /** Index in the chain (renumbered when points are inserted). */
  level: number;
  /** Stable id; answers point at it (v1 boards have none: p<level>). */
  id?: string;
  /** The point this one builds on. */
  buildsOn?: string;
  desc: string;
  keyPoints: string[];
  probe: { type: "choice" | "explain"; q: string; options?: string[]; answer?: number };
}
export interface ProbeAnswer {
  /** Chain index when answered (v1); pointId is authoritative. */
  level: number;
  pointId?: string;
  verdict: ProbeVerdict;
  text?: string;
  missing?: string;
  /** A contradiction recheck. */
  recheck?: boolean;
}
/** Internal bookkeeping (README §4); never rendered or exported. */
export interface ProbeMeta {
  expansions: number;
  refines: number;
  /** Pairs "lo|hi" a refine was tried on. */
  refined: string[];
  /** Pairs judged adjacent (nothing independent in between). */
  adjacent: string[];
  stopReason?: "precise+wrong3" | "precise+idk" | "precise" | "idk" | "skip" | "cap";
  tokens?: { gen: number; grade: number };
}
export interface ProbeState {
  status: "asking" | "done" | "skipped";
  /** The concept chain, shallow → deep. */
  ladder: LadderLevel[];
  answers: ProbeAnswer[];
  /** Chain index of the start point. */
  frontier?: number;
  meta?: ProbeMeta;
}
export type PlanIntent =
  | "concept"
  | "mechanism"
  | "decision"
  | "howto"
  | "learning-path"
  | "compare";
/** One block of the topic skeleton: a sub-question the map must answer. */
export interface PlanBlock {
  id: string;
  title: string;
  /** Why reaching the goal needs it. */
  why: string;
  /** A top-level block (null) becomes a first-level card; others sit under a top-level block. */
  parent: string | null;
  /** Blocks (ids) to understand first. */
  prerequisites: string[];
  /** Required by the question itself, whoever asks; the learner profile cannot drop it. */
  core: boolean;
}
export interface BoardPlan {
  /** draft: waiting for the learner to review it; confirmed: drives generation. */
  status: "draft" | "confirmed";
  intent: PlanIntent;
  /** Testable: "学完后，能……". */
  goal: string;
  /** A short learner profile from the kickoff (or "按初学者处理"). */
  learner: string;
  blocks: PlanBlock[];
  outOfScope: string[];
}
export interface BoardSummary {
  /** Unknown on legacy saves until loaded or saved. */
  sessionCount?: number;
  id: string;
  title: string;
  kind: Board["kind"];
  updatedAt: string;
  archivedAt?: string;
  /** Sealed / total cards and whether the canvas is done (model/progress.ts), computed on save. */
  sealed?: number;
  total?: number;
  done?: boolean;
}
export interface BoardProgress {
  sealed: number;
  total: number;
  done: boolean;
}
export type Selection = {
  kind: "node" | "relation" | "note";
  id: string;
} | null;
export interface ContextReference {
  id: string;
  kind: "topic" | "node" | "relation" | "note";
  title: string;
  text: string;
}
export interface ContextBundle {
  topic: string;
  references: ContextReference[];
  summary: string;
  /** Outline of the whole board (model/structure.ts); optional for older saved contexts. */
  structure?: string;
  /** Full card contents in the four-level review window; absent in older contexts. */
  review?: CardReview;
  /** The confirmed board plan, rendered for this request (model/plan.ts). */
  plan?: string;
}
export interface CardReview {
  scope?: "all";
  relations?: Relation[];
  radius: 4;
  anchors: string[];
  nodes: (Pick<
    ConceptNode,
    "id" | "parentId" | "order" | "title" | "body" | "visual"
  > & { level: number; bodyExcluded?: boolean })[];
}
export interface AISettings {
  model: string;
  baseUrl: string;
  customInstructions?: string;
  searchKey?: {
    source: "saved" | "session" | "none";
    keyHint?: string;
  };
  configured: boolean;
  /** saved: encrypted at rest (safeStorage); session: in memory until the app quits. */
  source: "saved" | "session" | "environment" | "none";
  /** A masked form of the key in use ("sk-••••a1b2"); never the key itself. */
  keyHint?: string;
  /** Whether a key can be saved encrypted on this machine; "web" in the browser preview. */
  keyStorage?: "encrypted" | "unavailable" | "web";
}
export interface AISettingsInput {
  model: string;
  baseUrl: string;
  apiKey?: string;
  customInstructions?: string;
  deepseekApiKey?: string;
}
/** Outcome of the settings 「测试连接」 probe. Never carries the key or raw provider text. */
export type AIConnectionResult =
  | { ok: true; model: string; latencyMs: number }
  | {
      ok: false;
      kind:
        | "config"
        | "auth"
        | "model"
        | "network"
        | "timeout"
        | "rate"
        | "unknown";
      message: string;
      status?: number;
    };
export interface AIRequest {
  boardId: string;
  stickyId: string;
  requestId: string;
  prompt: string;
  context: ContextBundle;
  canvas?: boolean;
  canvasRunId?: string;
  excludedCardIds?: string[];
  mode:
    | "answer"
    | "map"
    | "expand"
    | "hint"
    | "organize"
    | "enrich"
    | "plan"
    | "gate"
    | "mark"
    | "probe"
    | "regen"
    | "chat";
}
export interface AIUpdate {
  boardId: string;
  stickyId: string;
  requestId: string;
  text: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
}
export type CanvasRunStatus =
  | "running"
  | "paused"
  | "ready"
  | "applied"
  | "cancelled"
  | "failed"
  | "conflict";
export interface CanvasRun {
  id: string;
  boardId: string;
  stickyId: string;
  origin: "organize" | "chat";
  status: CanvasRunStatus;
  phase:
    | "structure"
    | "reading"
    | "locking"
    | "editing"
    | "relations"
    | "validating"
    | "complete";
  revision: number;
  reviewed: number;
  total: number;
  changed: boolean;
  summary: string;
  error?: string;
  draft?: Board;
  createdAt: string;
  updatedAt: string;
}
export interface CanvasRunEvent {
  run: CanvasRun;
}
export interface AIHistory {
  messages: ChatMessage[];
  running: boolean;
}
export interface AtlasAPI {
  /** Host OS from the preload ("darwin", "win32", …); "web" in the browser preview. */
  platform: string;
  /** Native fullscreen changes (macOS hides the traffic lights there). */
  onFullscreenChange(callback: (fullscreen: boolean) => void): () => void;
  /** The app menu's 「Settings…」 item (desktop only). */
  onOpenSettings?(callback: () => void): () => void;
  onBeforeClose(callback: () => Promise<void>): () => void;
  listBoards(): Promise<BoardSummary[]>;
  loadBoard(id: string): Promise<Board | null>;
  saveBoard(board: Board): Promise<void>;
  deleteBoard(id: string): Promise<void>;
  exportBoard(
    board: Board,
    format: "data" | "markdown" | "png",
    image?: string,
  ): Promise<boolean>;
  importBoard(text: string): Promise<Board>;
  getAISettings(): Promise<AISettings>;
  setAISettings(settings: AISettingsInput): Promise<AISettings>;
  testAIConnection(settings: AISettingsInput): Promise<AIConnectionResult>;
  ask(request: AIRequest): Promise<void>;
  stop(boardId: string, stickyId: string): Promise<void>;
  getHistory(boardId: string, stickyId: string): Promise<AIHistory>;
  startCanvasRun(boardId: string): Promise<CanvasRun>;
  listCanvasRuns(boardId: string): Promise<CanvasRun[]>;
  getCanvasRun(boardId: string, runId: string): Promise<CanvasRun | null>;
  prepareCanvasRun(boardId: string, runId: string): Promise<void>;
  resumeCanvasRun(boardId: string, runId: string): Promise<void>;
  cancelCanvasRun(boardId: string, runId: string): Promise<void>;
  commitCanvasRun(boardId: string, runId: string): Promise<Board>;
  onCanvasRun(callback: (event: CanvasRunEvent) => void): () => void;
  onAIUpdate(callback: (update: AIUpdate) => void): () => void;
}
declare global {
  interface Window {
    atlas?: AtlasAPI;
  }
}
