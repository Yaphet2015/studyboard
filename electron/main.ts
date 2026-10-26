import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  safeStorage,
} from "electron";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProfileStore } from "./profile-store.js";
import { boardEvidence } from "../src/shared/profile.js";
import { BoardStore } from "./board-store.js";
import { importTransferredBoard } from "./board-transfer.js";
import {
  collectBoardTransfer,
  EXPORT_FORMATS,
  exportFilename,
  transferMarkdown,
  TRANSFER_BYTES,
} from "../src/shared/transfer.js";
import { migrateLegacyUserData } from "./legacy-data.js";
import { installSystemFetch } from "./system-fetch.js";
import { AIRuntime, smokeDurableStorage } from "./ai-runtime.js";
import { z } from "zod";
import {
  boardSchema,
  aiRequestSchema,
  settingsSchema,
} from "../src/shared/validation.js";
const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged builds use build/icon.icns; dev runs show the PNG in the dock.
const devIcon = path.join(here, "../../build/icon.png");
const developmentURL = process.env.STUDYBOARD_DEV_SERVER;
let window: BrowserWindow | null = null;
let runtime: AIRuntime;
let quitting = false;
let closePending = false;
let rendererReady = false;
function traceClose(stage: string): void {
  if (process.env.STUDYBOARD_E2E === "1") console.info(`[close] ${stage}`);
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
// Do this before any code path can issue a request: main-process fetch must
// follow the OS proxy in dev and packaged builds.
installSystemFetch();
app.setName("Studyboard");
if (process.env.STUDYBOARD_E2E === "1" && process.env.STUDYBOARD_TEST_USERDATA)
  app.setPath("userData", path.resolve(process.env.STUDYBOARD_TEST_USERDATA));
else if (process.env.STUDYBOARD_SMOKE_TEST !== "1")
  try {
    // The app used to be "Learning Atlas"; bring old boards across once.
    migrateLegacyUserData(
      app.getPath("appData"),
      app.getPath("userData"),
      console.info,
    );
  } catch (error) {
    console.error("[migrate] could not copy Learning Atlas data", error);
  }
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
// Electron does not emit ready until the ESM entry module finishes evaluating.
// Await readiness in a callback, never as a top-level await in this entry point.
if (process.env.STUDYBOARD_SMOKE_TEST === "1")
  console.info("[smoke] entry module loaded; waiting for Electron ready");
async function bootstrap(): Promise<void> {
  if (process.env.STUDYBOARD_SMOKE_TEST === "1") {
    console.info(
      `[smoke] Electron ready: Electron ${process.versions.electron}, Node ${process.versions.node}`,
    );
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const result = db.prepare("SELECT 42 AS answer").get();
    db.close();
    console.info("[smoke] node:sqlite verified");
    const smokeDir = await mkdtemp(path.join(tmpdir(), "studyboard-smoke-"));
    try {
      console.info(
        "[smoke] opening durable SQLite, committing, closing and reopening",
      );
      const durable = await smokeDurableStorage(smokeDir);
      console.info("[smoke] durable reopen verified");
      console.log(
        JSON.stringify({
          electron: process.versions.electron,
          node: process.versions.node,
          sqlite: result,
          durable,
        }),
      );
    } finally {
      await rm(smokeDir, { recursive: true, force: true });
    }
    console.info("[smoke] complete; quitting Electron");
    app.quit();
  } else {
    if (!app.isPackaged) app.dock?.setIcon(devIcon);
    const store = new BoardStore(path.join(app.getPath("userData"), "boards"));
    const canvasLocks = new Map<
      string,
      {
        boardId: string;
        expected: string;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    >();
    runtime = new AIRuntime(
      path.join(app.getPath("userData"), "ai"),
      (update) => {
        if (window && !window.isDestroyed())
          window.webContents.send("studyboard:ai-update", update);
      },
      // The API key is encrypted at rest with safeStorage (macOS: Keychain-backed).
      safeStorage,
      {
        load: (boardId) => store.load(boardId),
        acquire: (run, expected, signal) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => finish(new Error("画布预览准备超时，任务已停止。")),
              30_000,
            );
            const abort = () => finish(new Error("画布任务已停止。"));
            function finish(error?: Error) {
              clearTimeout(timeout);
              signal?.removeEventListener("abort", abort);
              canvasLocks.delete(run.id);
              if (error) reject(error);
              else resolve();
            }
            canvasLocks.set(run.id, {
              boardId: run.boardId,
              expected,
              resolve: () => finish(),
              reject: (error) => finish(error),
            });
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
        release: (boardId, runId) => {
          canvasLocks.get(runId)?.reject(new Error("画布任务已停止。"));
          store.releaseCanvas(boardId, runId);
        },
        commit: (boardId, runId, expected, operations) =>
          store.commitCanvas(boardId, runId, expected, operations),
      },
      (run) => {
        if (window && !window.isDestroyed())
          window.webContents.send("studyboard:canvas-run", { run });
      },
    );
    const profile = new ProfileStore(path.join(app.getPath("userData"), "profile.json"),
      prompt => runtime.rewriteProfile(prompt), value => {
        if (window && !window.isDestroyed()) window.webContents.send("studyboard:profile-changed", value);
      });
    const profileReady = profile.initialize(async () => {
      const boards = [];
      // Oldest first: the bounded queue keeps the most recent learning results.
      for (const item of (await store.list()).reverse()) {
        const board = await store.load(item.id);
        if (board) boards.push(board);
      }
      return boards;
    });
    // Learning observations follow successful saves in order, including the final close flush.
    let saves: Promise<unknown> = Promise.resolve();
    function assertSender(event: Electron.IpcMainInvokeEvent) {
      const url = event.senderFrame?.url;
      if (event.sender !== window?.webContents || !url)
        throw new Error("Untrusted sender");
      if (
        developmentURL
          ? new URL(url).origin !== new URL(developmentURL).origin
          : !url.startsWith("file://")
      )
        throw new Error("Untrusted origin");
    }
    function handle(channel: string, fn: (...args: any[]) => unknown) {
      ipcMain.handle(channel, async (event, ...args) => {
        assertSender(event);
        return fn(...args);
      });
    }
    handle("studyboard:list", () => store.list());
    handle("studyboard:load", (value) => store.load(id.parse(value)));
    handle("studyboard:profile", async () => { await profileReady; return profile.get(); });
    handle("studyboard:save", (value) => {
      const board = boardSchema.parse(value);
      const task = saves.then(async () => {
        const previous = await store.load(board.id);
        await store.save(board);
        await profileReady;
        await profile.enqueue(boardEvidence(board, previous));
      });
      saves = task.catch(() => undefined);
      return task;
    });
    handle("studyboard:delete", (value) => store.delete(id.parse(value)));
    handle("studyboard:import", (value) => {
      if (closePending) throw new Error("正在关闭应用，请稍后重试。");
      return importTransferredBoard(
        z.string().max(TRANSFER_BYTES).parse(value),
        store,
        runtime,
      );
    });
    handle("studyboard:export", async (value, kind, image) => {
      const board = boardSchema.parse(value);
      const format = z.enum(["data", "markdown", "png"]).parse(kind);
      const { name, extension } = EXPORT_FORMATS[format];
      let data: string | Buffer;
      if (format === "png") {
        const png = z
          .string()
          .max(TRANSFER_BYTES * 1.4)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
          .parse(image);
        data = Buffer.from(
          png.slice("data:image/png;base64,".length),
          "base64",
        );
        if (
          data.length > TRANSFER_BYTES ||
          !data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("截图格式无效或超过 64 MB。");
      } else {
        const transfer = await collectBoardTransfer(board, (b, n) =>
          runtime.getHistory(b, n),
        );
        data =
          format === "data"
            ? JSON.stringify(transfer)
            : transferMarkdown(transfer);
      }
      const result = await dialog.showSaveDialog(window!, {
        title: "导出当前画板",
        defaultPath: exportFilename(board.title, format),
        filters: [{ name, extensions: [extension] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, data, { mode: 0o600 });
      return true;
    });
    handle("studyboard:ai-settings", () => runtime.getSettings());
    handle("studyboard:configure-ai", (value) =>
      runtime.setSettings(settingsSchema.parse(value)),
    );
    handle("studyboard:test-ai", (value) =>
      runtime.testConnection(settingsSchema.parse(value)),
    );
    handle("studyboard:ask", (value) => {
      if (closePending) throw new Error("App is preparing to close");
      return runtime.ask(aiRequestSchema.parse(value));
    });
    handle("studyboard:canvas-start", (boardId) => {
      if (closePending) throw new Error("App is preparing to close");
      return runtime.startCanvasRun(id.parse(boardId));
    });
    handle("studyboard:canvas-list", (boardId) =>
      runtime.listCanvasRuns(id.parse(boardId)),
    );
    handle("studyboard:canvas-get", (boardId, runId) =>
      runtime.getCanvasRun(id.parse(boardId), id.parse(runId)),
    );
    handle("studyboard:canvas-prepare", async (boardId, runId) => {
      boardId = id.parse(boardId);
      runId = id.parse(runId);
      const pending = canvasLocks.get(runId);
      if (!pending || pending.boardId !== boardId) return;
      try {
        await store.acquireCanvas(boardId, runId, pending.expected);
        if (canvasLocks.get(runId) !== pending) {
          store.releaseCanvas(boardId, runId);
          return;
        }
        pending.resolve();
      } catch {
        pending.reject(new Error("画布已更新或被占用，请按最新画布重试。"));
        throw new Error("画布已更新或被占用，请按最新画布重试。");
      }
    });
    handle("studyboard:canvas-resume", (boardId, runId) => {
      if (closePending) throw new Error("App is preparing to close");
      return runtime.resumeCanvasRun(id.parse(boardId), id.parse(runId));
    });
    handle("studyboard:canvas-cancel", (boardId, runId) =>
      runtime.cancelCanvasRun(id.parse(boardId), id.parse(runId)),
    );
    handle("studyboard:canvas-commit", (boardId, runId) =>
      runtime.commitCanvasRun(id.parse(boardId), id.parse(runId)),
    );
    handle("studyboard:stop", (board, sticky) =>
      runtime.stop(id.parse(board), id.parse(sticky)),
    );
    handle("studyboard:history", (board, sticky) =>
      runtime.getHistory(id.parse(board), id.parse(sticky)),
    );
    async function requestClose() {
      traceClose(
        `request received; pending=${closePending}; rendererReady=${rendererReady}`,
      );
      if (closePending) return;
      closePending = true;
      if (!rendererReady) {
        await runtime.close();
        quitting = true;
        app.quit();
        return;
      }
      try {
        await runtime.quiesce();
        traceClose("AI quiesced; requesting renderer save");
        window?.webContents.send("studyboard:before-close");
      } catch {
        closePending = false;
        await dialog.showMessageBox(window!, {
          type: "error",
          message: "暂时无法关闭 AI 会话",
          detail: "请停止回答后再重试关闭。",
          buttons: ["回到白板"],
        });
      }
    }
    handle("studyboard:renderer-ready", () => {
      rendererReady = true;
      traceClose("renderer save handler ready");
    });
    handle("studyboard:close-ready", async (saved) => {
      traceClose(`renderer save acknowledged: ${saved === true}`);
      if (saved !== true) {
        closePending = false;
        await dialog.showMessageBox(window!, {
          type: "error",
          message: "白板尚未保存",
          detail: "请先重试保存，再关闭应用。",
          buttons: ["回到白板"],
        });
        return;
      }
      await runtime.close();
      traceClose("runtime closed; quitting app");
      quitting = true;
      app.quit();
    });
    /** App menu with 「Settings…」 on ⌘. as asked, plus the macOS-standard ⌘, (hidden item). */
    function installMenu() {
      const openSettings = () =>
        window?.webContents.send("studyboard:open-settings");
      const settingsItems: Electron.MenuItemConstructorOptions[] = [
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+.",
          click: openSettings,
        },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: openSettings,
        },
      ];
      const mac = process.platform === "darwin";
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(mac
            ? [
                {
                  label: app.name,
                  submenu: [
                    { role: "about" },
                    { type: "separator" },
                    ...settingsItems,
                    { type: "separator" },
                    { role: "services" },
                    { type: "separator" },
                    { role: "hide" },
                    { role: "hideOthers" },
                    { role: "unhide" },
                    { type: "separator" },
                    { role: "quit" },
                  ],
                } as Electron.MenuItemConstructorOptions,
              ]
            : [
                {
                  label: "File",
                  submenu: [
                    ...settingsItems,
                    { type: "separator" },
                    { role: "quit" },
                  ],
                } as Electron.MenuItemConstructorOptions,
              ]),
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
    }
    function createWindow() {
      window = new BrowserWindow({
        width: 1512,
        height: 982,
        minWidth: 1060,
        minHeight: 720,
        backgroundColor: "#f6f7f3",
        title: "Studyboard",
        icon: app.isPackaged ? undefined : devIcon,
        titleBarStyle: "hiddenInset",
        // Lower the native buttons slightly for optical centring in the title bar.
        trafficLightPosition: { x: 12, y: 17 },
        webPreferences: {
          preload: path.join(here, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      rendererReady = false;
      // Fullscreen hides the traffic lights; the renderer drops its left inset there.
      for (const [event, value] of [
        ["enter-full-screen", true],
        ["leave-full-screen", false],
      ] as const)
        window.on(event as "enter-full-screen", () =>
          window?.webContents.send("studyboard:fullscreen", value),
        );
      window.webContents.on("render-process-gone", () => {
        rendererReady = false;
        closePending = false;
      });
      window.on("close", (event) => {
        traceClose(`native window close; quitting=${quitting}`);
        if (!quitting) {
          event.preventDefault();
          requestClose();
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (
          developmentURL
            ? new URL(url).origin !== new URL(developmentURL).origin
            : url !== window?.webContents.getURL()
        )
          event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      if (developmentURL) void window.loadURL(developmentURL);
      else void window.loadFile(path.join(here, "../../dist/index.html"));
    }
    createWindow();
    installMenu();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    app.on("window-all-closed", () => {
      app.quit();
    });
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      requestClose();
    });
  }
}
void app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    console.error(
      "[startup] failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    app.exit(1);
  });
