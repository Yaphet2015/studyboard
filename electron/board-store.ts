import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Board, BoardSummary } from "../src/shared/types.js";
import { boardProgress, withProgress } from "../src/model/progress.js";
import {
  canvasFingerprint,
  mergeCanvasDraft,
  type CanvasOperation,
} from "../src/shared/canvas.js";
import {
  boardSchema,
  idSchema,
  LIMITS,
  safeParseBoard,
} from "../src/shared/validation.js";

export class BoardStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_ID"
      | "INVALID_BOARD"
      | "CORRUPT_BOARD"
      | "UNSAFE_PATH"
      | "TOO_LARGE"
      | "CONFLICT",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoardStoreError";
  }
}
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Owns one private directory. Writes/deletes/loads for each board are serialized. */
export class BoardStore {
  private readonly dir: string;
  private readonly canvasLocks = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private path(id: string): string {
    if (!idSchema.safeParse(id).success)
      throw new BoardStoreError("Invalid board identifier.", "INVALID_ID");
    return join(this.dir, `${id}.json`);
  }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new BoardStoreError(
        "The board directory must be a real directory.",
        "UNSAFE_PATH",
      );
  }
  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const task = previous.then(operation);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(id, settled);
    void settled.then(() => {
      if (this.pending.get(id) === settled) this.pending.delete(id);
    });
    return task;
  }
  private async assertRegularFile(path: string): Promise<void> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new BoardStoreError(
          "Board files cannot be symlinks or directories.",
          "UNSAFE_PATH",
        );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  private async readBoard(id: string): Promise<Board | null> {
    const path = this.path(id);
    await this.assertRegularFile(path);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new BoardStoreError(
          "Board file is not a regular file.",
          "UNSAFE_PATH",
        );
      if (stat.size > LIMITS.boardBytes)
        throw new BoardStoreError(
          `Board ${id} exceeds the storage limit.`,
          "TOO_LARGE",
        );
      const buffer = Buffer.alloc(
        Math.min(stat.size + 1, LIMITS.boardBytes + 1),
      );
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size || offset > LIMITS.boardBytes)
        throw new BoardStoreError(
          `Board ${id} changed while reading.`,
          "CORRUPT_BOARD",
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
      } catch (cause) {
        throw new BoardStoreError(
          `Board ${id} contains invalid JSON. The original file has been preserved.`,
          "CORRUPT_BOARD",
          { cause },
        );
      }
      const result = safeParseBoard(parsed);
      if (!result.success || result.data.id !== id) {
        throw new BoardStoreError(
          `Board ${id} failed validation. The original file has been preserved.`,
          "CORRUPT_BOARD",
          { cause: result.success ? undefined : result.error },
        );
      }
      return result.data;
    } finally {
      await handle.close();
    }
  }
  async list(): Promise<BoardSummary[]> {
    await this.ensureDirectory();
    await Promise.all([...this.pending.values()]);
    const entries = await readdir(this.dir, { withFileTypes: true });
    const result: BoardSummary[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      this.path(id);
      const board = await this.load(id);
      if (board)
        result.push({
          id: board.id,
          title: board.title,
          sessionCount: board.sessionCount,
          kind: board.kind,
          updatedAt: board.updatedAt,
          ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
          // Boards saved before progress existed are backfilled here; the next save stores it.
          ...(board.progress ?? boardProgress(board)),
        });
    }
    return result.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title),
    );
  }
  async load(id: string): Promise<Board | null> {
    this.path(id);
    return this.enqueue(id, async () => {
      await this.ensureDirectory();
      return this.readBoard(id);
    });
  }
  async acquireCanvas(
    boardId: string,
    runId: string,
    expected: string,
  ): Promise<void> {
    await this.enqueue(boardId, async () => {
      const current = await this.readBoard(boardId);
      const owner = this.canvasLocks.get(boardId);
      if (
        !current ||
        canvasFingerprint(current) !== expected ||
        (owner && owner !== runId)
      )
        throw new BoardStoreError(
          "画布已更新或正在被另一个任务修改，请按最新画布重试。",
          "CONFLICT",
        );
      this.canvasLocks.set(boardId, runId);
    });
  }
  releaseCanvas(boardId: string, runId: string): void {
    if (this.canvasLocks.get(boardId) === runId)
      this.canvasLocks.delete(boardId);
  }
  async commitCanvas(
    boardId: string,
    runId: string,
    expected: string,
    operations: CanvasOperation[][],
  ): Promise<Board> {
    return this.enqueue(boardId, async () => {
      const current = await this.readBoard(boardId);
      if (!current) throw new BoardStoreError("找不到画布。", "CONFLICT");
      if (current.appliedCanvasRuns?.includes(runId)) return current;
      if (
        canvasFingerprint(current) !== expected ||
        this.canvasLocks.get(boardId) !== runId
      )
        throw new BoardStoreError("画布版本冲突，整理结果未应用。", "CONFLICT");
      const next = mergeCanvasDraft(
        current,
        operations,
        runId,
        new Date().toISOString(),
      );
      next.canvasVersion = runId;
      next.appliedCanvasRuns = [
        ...(current.appliedCanvasRuns ?? []).slice(-999),
        runId,
      ];
      next.updatedAt = new Date().toISOString();
      await this.writeBoard(next);
      this.releaseCanvas(boardId, runId);
      return next;
    });
  }
  async save(input: Board): Promise<void> {
    const result = boardSchema.safeParse(input);
    if (!result.success)
      throw new BoardStoreError(
        "The board is invalid and was not saved.",
        "INVALID_BOARD",
        { cause: result.error },
      );
    const board = withProgress(result.data);
    this.path(board.id);
    return this.enqueue(board.id, async () => {
      await this.ensureDirectory();
      let current: Board | null;
      try {
        current = await this.readBoard(board.id);
      } catch (error) {
        if (
          error instanceof BoardStoreError &&
          error.code === "CORRUPT_BOARD" &&
          !board.canvasVersion &&
          !this.canvasLocks.has(board.id)
        )
          current = null;
        else throw error;
      }
      if (
        current &&
        (current.canvasVersion !== board.canvasVersion ||
          (this.canvasLocks.has(board.id) &&
            canvasFingerprint(current) !== canvasFingerprint(board)))
      )
        throw new BoardStoreError(
          "画布已更新，旧的自动保存未覆盖新结果。",
          "CONFLICT",
        );
      await this.writeBoard(board);
    });
  }
  private async writeBoard(board: Board): Promise<void> {
    // Callers (save, commitCanvas) have already validated the board.
    const path = this.path(board.id);
    const data = JSON.stringify(board);
    if (Buffer.byteLength(data, "utf8") > LIMITS.boardBytes)
      throw new BoardStoreError(
        "The board exceeds the storage limit.",
        "TOO_LARGE",
      );
    await this.ensureDirectory();
    await this.assertRegularFile(path);
    const temporary = join(this.dir, `.${board.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, path);
      // A file fsync followed by directory fsync makes the rename durable on macOS/Linux.
      const directory = await open(this.dir, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async delete(id: string): Promise<void> {
    const path = this.path(id);
    return this.enqueue(id, async () => {
      await this.ensureDirectory();
      await this.assertRegularFile(path);
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    });
  }
}
