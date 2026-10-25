import type { AtlasAPI, Board, ChatMessage } from "./shared/types";
import { safeParseBoard } from "./shared/validation";
import { migrateLegacyPreview, PREVIEW_KEY } from "./preview-storage";
import {
  collectBoardTransfer,
  EXPORT_FORMATS,
  exportFilename,
  importedBoard,
  parseBoardTransfer,
  transferMarkdown,
} from "./shared/transfer";
import { downloadFile } from "./export-file";
import { boardProgress, withProgress } from "./model/progress";
const key = PREVIEW_KEY;
const historiesKey = "studyboard-preview-histories-v1";
function readHistories(): Record<string, Record<string, ChatMessage[]>> {
  return JSON.parse(localStorage.getItem(historiesKey) ?? "{}");
}
function read(): Board[] {
  migrateLegacyPreview();
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const all: unknown[] = JSON.parse(raw);
  // Upgrade v1 previews in place; drop anything that no longer validates.
  return all.flatMap((item) => {
    const result = safeParseBoard(item);
    return result.success ? [result.data as Board] : [];
  });
}
const preview: AtlasAPI = {
  platform: "web",
  onFullscreenChange() {
    return () => {};
  },
  onBeforeClose() {
    return () => {};
  },
  async listBoards() {
    return read().map((b) => ({
      id: b.id,
      title: b.title,
      sessionCount: b.sessionCount,
      kind: b.kind,
      updatedAt: b.updatedAt,
      ...(b.archivedAt ? { archivedAt: b.archivedAt } : {}),
      ...(b.progress ?? boardProgress(b)),
    }));
  },
  async loadBoard(id) {
    return read().find((b) => b.id === id) ?? null;
  },
  async saveBoard(input) {
    const board = withProgress(input);
    const all = read();
    const index = all.findIndex((b) => b.id === board.id);
    if (index < 0) all.push(board);
    else all[index] = board;
    localStorage.setItem(key, JSON.stringify(all));
  },
  async deleteBoard(id) {
    localStorage.setItem(
      key,
      JSON.stringify(read().filter((b) => b.id !== id)),
    );
    const histories = readHistories();
    delete histories[id];
    localStorage.setItem(historiesKey, JSON.stringify(histories));
  },
  async exportBoard(board, format, image) {
    const name = exportFilename(board.title, format);
    const { mimeType } = EXPORT_FORMATS[format];
    if (format === "png") {
      if (!image?.startsWith("data:image/png;base64,"))
        throw new Error("截图生成失败。");
      const bytes = Uint8Array.from(atob(image.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      downloadFile(name, new Blob([bytes], { type: mimeType }));
    } else {
      const transfer = await collectBoardTransfer(board, (b, n) =>
        preview.getHistory(b, n),
      );
      const content =
        format === "data"
          ? JSON.stringify(transfer)
          : transferMarkdown(transfer);
      downloadFile(name, new Blob([content], { type: mimeType }));
    }
    return true;
  },
  async importBoard(text) {
    const transfer = parseBoardTransfer(text);
    const board = importedBoard(transfer);
    const before = localStorage.getItem(historiesKey);
    const histories = readHistories();
    histories[board.id] = Object.fromEntries(
      transfer.conversations.map((c) => [c.noteId, c.messages]),
    );
    localStorage.setItem(historiesKey, JSON.stringify(histories));
    try {
      await preview.saveBoard(board);
    } catch (error) {
      if (before === null) localStorage.removeItem(historiesKey);
      else localStorage.setItem(historiesKey, before);
      throw error;
    }
    return board;
  },
  async getAISettings() {
    return {
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      configured: false,
      source: "none",
      keyStorage: "web",
    };
  },
  async setAISettings() {
    throw new Error(
      "AI 连接需要桌面客户端。浏览器预览只在本机保存白板，不接收 API 密钥。",
    );
  },
  async testAIConnection() {
    return {
      ok: false,
      kind: "config",
      message: "浏览器预览不能测试连接：请在桌面客户端中配置 AI。",
    };
  },
  async startCanvasRun() {
    throw new Error("画布 Agent 需要桌面客户端。");
  },
  async listCanvasRuns() {
    return [];
  },
  async getCanvasRun() {
    return null;
  },
  async prepareCanvasRun() {},
  async resumeCanvasRun() {
    throw new Error("画布 Agent 需要桌面客户端。");
  },
  async cancelCanvasRun() {},
  async commitCanvasRun() {
    throw new Error("画布 Agent 需要桌面客户端。");
  },
  onCanvasRun() {
    return () => {};
  },
  async ask() {
    throw new Error("AI_NOT_CONFIGURED: 请在桌面客户端的 AI 设置中连接模型。");
  },
  async stop() {},
  async getHistory(boardId, noteId) {
    return {
      messages: readHistories()[boardId]?.[noteId] ?? [],
      running: false,
    };
  },
  onAIUpdate() {
    return () => {};
  },
};
export const api = window.atlas ?? preview;
export const isDesktop = Boolean(window.atlas);
