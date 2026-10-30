import { boardSchema } from "../src/shared/validation";
import { describe, expect, it, vi } from "vitest";
import { createWalkthroughBoard, newNote } from "../src/model/boards";
import { cacheMessages } from "../src/model/editor";
import type { Board, ChatMessage } from "../src/shared/types";
import {
  collectBoardTransfer,
  completeMessages,
  importedBoard,
  parseBoardTransfer,
  transferMarkdown,
} from "../src/shared/transfer";
import { importTransferredBoard } from "../electron/board-transfer";

function example() {
  const board = createWalkthroughBoard();
  const messages: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
    id: `message-${i}`,
    role: i % 2 ? "assistant" : "user",
    text: `第 ${i} 条学习记录`,
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));
  messages[249].text = "完整回答".repeat(10_000);
  const note = newNote(
    board,
    { x: 100, y: 200 },
    { kind: "node", id: board.nodes[1].id },
  );
  note.messages = cacheMessages(messages);
  note.messages[198].meta = { checked: [0, 2], laid: true };
  note.contextCards = [board.nodes[2].id];
  note.excludedRefs = [board.nodes[3].id];
  board.notes = [note];
  board.nodes[1].status = "explained";
  board.scene.prediction = "宽度改变会重新布局";
  board.scene.explanation = "文字换行了";
  return { board, messages };
}

describe("portable learning history", () => {
  it("round trips full transcripts, long answers, references, progress and metadata", async () => {
    const { board, messages } = example();
    const transfer = parseBoardTransfer(
      JSON.stringify(
        await collectBoardTransfer(board, async () => ({
          messages,
          running: false,
        })),
      ),
    );
    expect(transfer.conversations[0].messages).toHaveLength(250);
    expect(transfer.conversations[0].messages[249].text).toBe(
      messages[249].text,
    );
    expect(transfer.conversations[0].messages[248].meta).toEqual({
      checked: [0, 2],
      laid: true,
    });
    const imported = importedBoard(transfer);
    expect(imported.id).not.toBe(board.id);
    expect(imported.notes[0].messages).toHaveLength(200);
    expect(imported.notes[0].messages.at(-1)?.text).toHaveLength(32_000);
    expect(imported.notes[0].attachedTo).toEqual(board.notes[0].attachedTo);
    expect(imported.notes[0].contextCards).toEqual(board.notes[0].contextCards);
    expect(imported.notes[0].excludedRefs).toEqual(board.notes[0].excludedRefs);
    expect(imported.nodes).toEqual(boardSchema.parse(board).nodes);
    expect(imported.relations).toEqual(board.relations);
    expect(imported.scene).toEqual(board.scene);
    const markdown = transferMarkdown(transfer);
    expect(markdown).toContain("第 0 条学习记录");
    expect(markdown).toContain(messages[249].text);
    expect(markdown).toContain("我能解释");
    expect(markdown).toContain("宽度改变会重新布局");
  });
  it("preserves transcript order even if timestamps go backwards, without repeating truncated cache messages", () => {
    const { messages } = example();
    messages[0].createdAt = "2030-01-01T00:00:00Z";
    const merged = completeMessages(cacheMessages(messages), messages);
    expect(merged).toHaveLength(250);
    expect(merged[0].id).toBe("message-0");
    expect(merged[249].text).toHaveLength(40_000);
  });
  it("rejects malformed, unknown-version, dangling-reference and incomplete files", async () => {
    const { board, messages } = example();
    const transfer = await collectBoardTransfer(board, async () => ({
      messages,
      running: false,
    }));
    for (const input of [
      "{broken",
      JSON.stringify({ ...transfer, version: 2 }),
      JSON.stringify({ ...transfer, apiKey: "secret" }),
      JSON.stringify({ ...transfer, conversations: [] }),
      JSON.stringify({
        ...transfer,
        board: {
          ...board,
          nodes: [{ ...board.nodes[0], parentId: "missing" }],
        },
      }),
      JSON.stringify({
        ...transfer,
        conversations: [{ noteId: "missing", messages: [] }],
      }),
      JSON.stringify({
        ...transfer,
        conversations: [transfer.conversations[0], transfer.conversations[0]],
      }),
    ])
      expect(() => parseBoardTransfer(input)).toThrow();
  });
  it("fails rather than exporting a partial history when reading fails or a conversation is running", async () => {
    const { board } = example();
    await expect(
      collectBoardTransfer(board, async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
    await expect(
      collectBoardTransfer(board, async () => ({
        messages: [],
        running: true,
      })),
    ).rejects.toThrow("尚未结束");
  });
  it("keeps text and links inert in Markdown", async () => {
    const { board } = example();
    board.nodes[0].body =
      "<script>alert(1)</script> ![外部图片](https://example.test/pixel)";
    const md = transferMarkdown(
      await collectBoardTransfer(board, async () => ({
        messages: [],
        running: false,
      })),
    );
    expect(md).toContain("\\<script\\>");
    expect(md).toContain("\\!\\[外部图片\\]");
  });
  it("publishes only after all histories succeed, and rolls back on a failed board write", async () => {
    const { board, messages } = example();
    const transfer = await collectBoardTransfer(board, async () => ({
      messages,
      running: false,
    }));
    const order: string[] = [];
    const runtime = {
      importHistory: vi.fn(async () => {
        order.push("history");
      }),
      discardImportedBoard: vi.fn(async () => {}),
    };
    const store = {
      save: vi.fn(async (_b: Board) => {
        order.push("board");
      }),
      delete: vi.fn(async () => {}),
    };
    const imported = await importTransferredBoard(
      JSON.stringify(transfer),
      store,
      runtime,
    );
    expect(order).toEqual(["history", "board"]);
    expect(runtime.importHistory).toHaveBeenCalledWith(
      imported.id,
      transfer.conversations[0],
    );
    store.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      importTransferredBoard(JSON.stringify(transfer), store, runtime),
    ).rejects.toThrow("disk full");
    expect(runtime.discardImportedBoard).toHaveBeenCalledOnce();
    expect(store.delete).toHaveBeenCalledOnce();
  });
});
