import { boardSchema } from "../src/shared/validation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { boardProgress, withProgress } from "../src/model/progress";
import { tmpdir } from "node:os";
import { BoardStore } from "../electron/board-store";
import { createEmptyBoard, createWalkthroughBoard, newNote } from "../src/model/boards";
import { LIMITS } from "../src/shared/validation";

let directory: string;
let store: BoardStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atlas-store-test-"));
  store = new BoardStore(join(directory, "boards"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("atomic private board storage", () => {
  it("starts empty and returns null only for genuinely missing boards", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.load("missing-board")).toBeNull();
  });
  it("round-trips all learning state across new store instances", async () => {
    const board = createWalkthroughBoard();
    board.nodes[1].status = "explained";
    board.scene.prediction = "我认为只会改变颜色";
    board.viewport = { x: 20, y: 30, zoom: 0.8 };
    await store.save(board);
    const reopened = new BoardStore(join(directory, "boards"));
    expect(await reopened.load(board.id)).toEqual(withProgress(boardSchema.parse(board)));
    expect(await reopened.list()).toEqual([
      {
        id: board.id,
        title: board.title,
        sessionCount: board.notes.length,
        kind: board.kind,
        updatedAt: board.updatedAt,
        ...boardProgress(board),
      },
    ]);
    expect(
      (await stat(join(directory, "boards", `${board.id}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(join(directory, "boards"))).mode & 0o777).toBe(0o700);
  });
  it("persists archive metadata across restarts and keeps the complete board recoverable", async () => {
    const board = createWalkthroughBoard();
    board.archivedAt = new Date().toISOString();
    await store.save(board);
    const reopened = new BoardStore(join(directory, "boards"));
    expect(await reopened.load(board.id)).toEqual(withProgress(boardSchema.parse(board)));
    expect((await reopened.list())[0].archivedAt).toBe(board.archivedAt);
    delete board.archivedAt;
    await reopened.save(board);
    expect((await store.list())[0].archivedAt).toBeUndefined();
    expect(await store.load(board.id)).toEqual(withProgress(boardSchema.parse(board)));
  });
  it("serializes rapid writes to the same board and snapshots inputs immediately", async () => {
    const board = createEmptyBoard("initial");
    const writes = [];
    for (let index = 0; index < 30; index += 1) {
      board.title = `version-${index}`;
      writes.push(store.save(board));
    }
    board.title = "mutated-after-save";
    await Promise.all(writes);
    expect((await store.load(board.id))?.title).toBe("version-29");
    expect(
      (await readdir(join(directory, "boards"))).filter((file) =>
        file.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
  it("serializes deletion with pending saves and permits explicit recreation", async () => {
    const board = createEmptyBoard("delete-me");
    await Promise.all([store.save(board), store.delete(board.id)]);
    expect(await store.load(board.id)).toBeNull();
    await store.delete(board.id);
    await store.save(board);
    expect(await store.load(board.id)).toEqual(withProgress(boardSchema.parse(board)));
  });
  it("lists newest boards first", async () => {
    const a = createEmptyBoard("older");
    const b = createEmptyBoard("newer");
    a.updatedAt = "2026-10-01T00:00:00.000Z";
    b.updatedAt = "2026-10-16T00:00:00.000Z";
    await Promise.all([store.save(a), store.save(b)]);
    expect((await store.list()).map((board) => board.id)).toEqual([b.id, a.id]);
  });
  it.each([
    "../outside",
    "/tmp/outside",
    "..",
    "board.json",
    "bad/id",
    "bad\\id",
    "",
  ])("rejects path traversal and unsafe id %s", async (id) => {
    await expect(store.load(id)).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(store.delete(id)).rejects.toMatchObject({
      code: "INVALID_ID",
    });
    const board = { ...createEmptyBoard("safe"), id };
    await expect(store.save(board)).rejects.toMatchObject({
      code: "INVALID_BOARD",
    });
  });
  it("preserves and reports corrupted JSON rather than silently treating it as missing", async () => {
    const board = createEmptyBoard("corrupted");
    await store.save(board);
    const path = join(directory, "boards", `${board.id}.json`);
    await writeFile(path, "{broken");
    await expect(store.load(board.id)).rejects.toMatchObject({
      code: "CORRUPT_BOARD",
    });
    await expect(store.list()).rejects.toMatchObject({ code: "CORRUPT_BOARD" });
    expect(await readFile(path, "utf8")).toBe("{broken");
    // A failed read must not poison the per-board queue.
    await store.save(board);
    expect(await store.load(board.id)).toEqual(withProgress(boardSchema.parse(board)));
  });
  it("rejects schema-invalid persisted data and mismatched ids", async () => {
    const board = createEmptyBoard("invalid schema");
    await store.save(board);
    const path = join(directory, "boards", `${board.id}.json`);
    await writeFile(path, JSON.stringify({ ...board, id: "different-id" }));
    await expect(store.load(board.id)).rejects.toMatchObject({
      code: "CORRUPT_BOARD",
    });
    await writeFile(path, JSON.stringify({ ...board, version: 999 }));
    await expect(store.load(board.id)).rejects.toMatchObject({
      code: "CORRUPT_BOARD",
    });
  });
  it("rejects symlink board files without reading or overwriting their targets", async () => {
    await store.list();
    const target = join(directory, "outside.json");
    await writeFile(target, "untouched");
    const board = createEmptyBoard("unsafe symlink");
    await symlink(target, join(directory, "boards", `${board.id}.json`));
    await expect(store.load(board.id)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(store.save(board)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(store.delete(board.id)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("rejects oversized files before parsing", async () => {
    const board = createEmptyBoard("too large");
    await store.save(board);
    await writeFile(
      join(directory, "boards", `${board.id}.json`),
      Buffer.alloc(LIMITS.boardBytes + 1, 32),
    );
    await expect(store.load(board.id)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });
  it("recomputes session counts on save and preserves unknown legacy counts", async () => {
    const board = createEmptyBoard("会话数量");
    board.notes.push(newNote(board, { x: 0, y: 0 }));
    board.sessionCount = 99;
    await store.save(board);
    expect((await store.load(board.id))?.sessionCount).toBe(1);
    expect((await store.list())[0].sessionCount).toBe(1);
    board.notes = [];
    await store.save(board);
    expect((await store.list())[0].sessionCount).toBe(0);
    const path = join(directory, "boards", `${board.id}.json`);
    const { sessionCount, ...legacy } = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify(legacy));
    expect((await store.list())[0].sessionCount).toBeUndefined();
  });
  it("backfills sealed/total for boards saved before progress existed", async () => {
    const board = createEmptyBoard("旧画布");
    board.nodes.push({ ...board.nodes[0], id: "c1", parentId: board.nodes[0].id, status: "explained" });
    await store.save(board);
    const path = join(directory, "boards", `${board.id}.json`);
    const { progress, ...legacy } = JSON.parse(await readFile(path, "utf8"));
    expect(progress).toEqual({ sealed: 1, total: 1, done: true });
    await writeFile(path, JSON.stringify(legacy));
    const [summary] = await new BoardStore(join(directory, "boards")).list();
    expect(summary).toMatchObject({ sealed: 1, total: 1, done: true, sessionCount: board.notes.length });
  });
});
