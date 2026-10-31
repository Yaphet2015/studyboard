import { describe, expect, it } from "vitest";
import { createWalkthroughBoard, newNote } from "../src/model/boards";
import {
  cacheMessages,
  layOutline,
  mergeHistory,
  removeSelection,
} from "../src/model/editor";
import { boardSchema } from "../src/shared/validation";
import type { ChatMessage } from "../src/shared/types";

function fixture() {
  const board = createWalkthroughBoard();
  // Two extra cross-links so incident-relation handling is exercised.
  board.relations.unshift(
    {
      id: "relation-scene-dom",
      source: "scene-browser",
      target: "concept-dom",
      label: "内容与结构",
      kind: "cross",
    },
    {
      id: "relation-dom-style",
      source: "concept-dom",
      target: "concept-style",
      label: "为元素计算样式",
      kind: "cross",
    },
  );
  const nodeNote = newNote(
    board,
    { x: 0, y: 0 },
    { kind: "node", id: "concept-dom" },
  );
  const incomingNote = newNote(
    board,
    { x: 10, y: 10 },
    { kind: "relation", id: "relation-scene-dom" },
  );
  const outgoingNote = newNote(
    board,
    { x: 20, y: 20 },
    { kind: "relation", id: "relation-dom-style" },
  );
  const unrelatedNote = newNote(
    board,
    { x: 30, y: 30 },
    { kind: "node", id: "concept-style" },
  );
  board.notes.push(nodeNote, incomingNote, outgoingNote, unrelatedNote);
  return { board, nodeNote, incomingNote, outgoingNote, unrelatedNote };
}

describe("selection removal", () => {
  it("removes a concept and its incident relations while preserving and detaching their notes", () => {
    const { board, nodeNote, incomingNote, outgoingNote, unrelatedNote } =
      fixture();
    const snapshot = JSON.stringify(board);
    const result = removeSelection(board, { kind: "node", id: "concept-dom" });
    expect(result.nodes.some((node) => node.id === "concept-dom")).toBe(false);
    expect(result.relations.map((edge) => edge.id)).toEqual([
      "relation-style-render",
    ]);
    expect(result.notes).toHaveLength(4);
    for (const note of [nodeNote, incomingNote, outgoingNote]) {
      expect(
        result.notes.find((item) => item.id === note.id)?.attachedTo,
      ).toBeUndefined();
    }
    expect(result.notes.find((note) => note.id === unrelatedNote.id)).toBe(
      unrelatedNote,
    );
    expect(boardSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(board)).toBe(snapshot);
  });
  it("removes only the selected relation and detaches its notes", () => {
    const { board, nodeNote, incomingNote, outgoingNote } = fixture();
    const result = removeSelection(board, {
      kind: "relation",
      id: "relation-dom-style",
    });
    expect(result.nodes).toBe(board.nodes);
    expect(result.relations).toHaveLength(2);
    expect(
      result.notes.find((note) => note.id === outgoingNote.id)?.attachedTo,
    ).toBeUndefined();
    expect(
      result.notes.find((note) => note.id === incomingNote.id)?.attachedTo,
    ).toEqual(incomingNote.attachedTo);
    expect(
      result.notes.find((note) => note.id === nodeNote.id)?.attachedTo,
    ).toEqual(nodeNote.attachedTo);
    expect(boardSchema.safeParse(result).success).toBe(true);
  });
  it("deleting a note does not delete its associated concept or relation", () => {
    const { board, outgoingNote } = fixture();
    const result = removeSelection(board, {
      kind: "note",
      id: outgoingNote.id,
    });
    expect(result.notes).toHaveLength(3);
    expect(result.nodes).toBe(board.nodes);
    expect(result.relations).toBe(board.relations);
    expect(boardSchema.safeParse(result).success).toBe(true);
  });
  it("leaves empty and stale selections unchanged", () => {
    const { board } = fixture();
    expect(removeSelection(board, null)).toBe(board);
    expect(removeSelection(board, { kind: "node", id: "missing" })).toBe(board);
  });
});

describe("renderer message cache", () => {
  const message = (index: number): ChatMessage => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Text ${index}`,
    createdAt: "2026-10-16T00:00:00.000Z",
  });
  it("retains the last 200 messages in chronological order without mutating inputs", () => {
    const messages = Array.from({ length: 250 }, (_, index) => message(index));
    const cached = cacheMessages(messages);
    expect(cached).toHaveLength(200);
    expect(cached[0].id).toBe("message-50");
    expect(cached.at(-1)?.id).toBe("message-249");
    expect(messages).toHaveLength(250);
    expect(cached[0]).not.toBe(messages[50]);
  });
  it("caps cached text at 32,000 characters while preserving the original", () => {
    const original = { ...message(0), text: "x".repeat(40_000) };
    expect(cacheMessages([original])[0].text).toHaveLength(32_000);
    expect(original.text).toHaveLength(40_000);
  });
  it("keeps the latest version of duplicate message IDs from replayed events", () => {
    const first = message(0);
    const second = message(1);
    const replayed = { ...first, text: "latest content" };
    expect(cacheMessages([first, second, replayed])).toEqual([
      second,
      replayed,
    ]);
  });
  it("accepts an empty history", () => {
    expect(cacheMessages([])).toEqual([]);
  });
});

describe("message meta", () => {
  const at = "2026-10-18T10:00:00.000Z";
  it("boards saved before message meta existed still validate", () => {
    const board = fixture().board;
    expect(boardSchema.parse(board)).toEqual({ ...board, nodes: board.nodes.map(n => ({ ...n, weight: n.weight ?? "background" })) });
    board.notes[0].messages = [
      {
        id: "m1",
        role: "assistant",
        text: "好",
        createdAt: at,
        meta: { checked: [0, 2] },
      },
    ];
    board.notes[0].excludedRefs = ["concept-dom"];
    expect(boardSchema.parse(board)).toEqual({ ...board, nodes: board.nodes.map(n => ({ ...n, weight: n.weight ?? "background" })) });
  });

  it("carries ticked steps over when durable history replaces the cache", () => {
    const cached: ChatMessage[] = [
      { id: "r1", role: "user", text: "带我起步", createdAt: at },
      {
        id: "r1-answer",
        role: "assistant",
        text: "小练习：a、b",
        createdAt: at,
        meta: { checked: [1] },
      },
    ];
    const history: ChatMessage[] = [
      { id: "durable-7-0", role: "user", text: "带我起步", createdAt: at },
      {
        id: "durable-7-1",
        role: "assistant",
        text: "小练习：a、b",
        createdAt: at,
      },
      { id: "durable-8-0", role: "user", text: "然后呢", createdAt: at },
    ];
    const merged = mergeHistory(cached, history);
    expect(merged.map((m) => m.id)).toEqual([
      "durable-7-0",
      "durable-7-1",
      "durable-8-0",
    ]);
    expect(merged[1].meta).toEqual({ checked: [1] });
    expect(merged[2].meta).toBeUndefined();
  });
});

describe("layOutline", () => {
  it("appends unseen cards under the anchor and marks the answer laid", () => {
    const { board } = fixture();
    const root = board.nodes.find((n) => n.parentId === null)!;
    const before = board.nodes.filter((n) => n.parentId === root.id);
    const note = board.notes[0];
    note.messages = [
      {
        id: "a1",
        role: "assistant",
        text: "1. **甲**：一\n2. **乙**：二",
        createdAt: "2026-10-18T10:00:00.000Z",
      },
    ];
    const next = layOutline(
      board,
      root.id,
      [
        { head: "甲", body: "一" },
        { head: "乙", body: "二" },
      ],
      ["concept-x1", "concept-x2"],
      { noteId: note.id, messageId: "a1" },
    );
    const kids = next.nodes
      .filter((n) => n.parentId === root.id)
      .sort((a, b) => a.order - b.order);
    expect(kids.map((n) => n.id)).toEqual([
      ...before.sort((a, b) => a.order - b.order).map((n) => n.id),
      "concept-x1",
      "concept-x2",
    ]);
    expect(kids.at(-1)).toMatchObject({
      title: "乙",
      body: "二",
      status: "unseen",
    });
    expect(next.notes[0].messages[0].meta).toEqual({ laid: true });
    expect(boardSchema.parse(next)).toEqual({ ...next, nodes: next.nodes.map(n => ({ ...n, weight: n.weight ?? "background" })) });
    // The original board is untouched, so undo is just the previous board.
    expect(board.nodes).toHaveLength(next.nodes.length - 2);
  });

  it("ignores a missing anchor", () => {
    const { board } = fixture();
    expect(layOutline(board, "nope", [{ head: "甲", body: "" }], ["x"])).toBe(
      board,
    );
  });
});
