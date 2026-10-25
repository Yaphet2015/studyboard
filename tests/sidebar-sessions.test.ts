import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import { listSessions } from "../src/model/sessions";
import { createWalkthroughBoard, newNote } from "../src/model/boards";

vi.mock("../src/api", () => ({ api: { loadBoard: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

function render(options: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  const props: ComponentProps<typeof WorkspaceSidebar> = {
    boards: [{ id: "board", title: "画布", kind: "walkthrough", updatedAt: new Date().toISOString(), sessionCount: 12 }],
    currentId: "board", collapsed: false, switchingId: null, width: 256,
    onWidthChange() {}, onResizingChange() {}, onToggle() {}, onPick() {}, onArchive() {}, onNew() {}, onSearch() {}, onSettings() {},
    sessions: [], onOpenSession: async () => {}, onNewSession() {}, ...options,
  };
  return renderToStaticMarkup(createElement(WorkspaceSidebar, props));
}

function saved(view: unknown) {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(view) });
}

describe("sidebar session rendering", () => {
  it("starts collapsed even when a conversation is open, with an accented count and accessible disclosure", () => {
    const board = createWalkthroughBoard();
    board.notes.push(newNote(board, { x: 0, y: 0 }));
    const html = render({ sessions: listSessions(board), currentSessionId: board.notes[0].id });
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="展开对话（1）"');
    expect(html).toContain('aria-controls="sessions-board"');
    expect(html).toContain('workspace-session-count is-open');
    expect(html).toContain('hidden=""');
    expect(html).not.toContain('workspace-session-spinner');
  });

  it("respects saved expansion and pins the older active row with its two lines of metadata", () => {
    saved({ board: { open: true, all: false } });
    const board = createWalkthroughBoard();
    board.notes = Array.from({ length: 12 }, (_, i) => {
      const note = newNote(board, { x: 0, y: 0 });
      note.title = `对话 ${i}`;
      note.createdAt = new Date(2026, 0, 12 - i).toISOString();
      return note;
    });
    const html = render({ sessions: listSessions(board), currentSessionId: board.notes[10].id });
    expect(html).toContain('aria-label="收起对话（12）"');
    expect(html).not.toContain('hidden=""');
    expect(html.match(/class="workspace-session"/g)).toHaveLength(7);
    expect(html).toContain('aria-current="page" aria-busy="false"');
    expect(html).toContain('workspace-session-meta');
    expect(html).toContain('自由批注');
    expect(html).toContain('展开更多 · 还有 5 个');
  });

  it("hides unknown counts and omits disclosure and sessions in the collapsed rail", () => {
    const board = { id: "other", title: "旧画布", kind: "walkthrough" as const, updatedAt: new Date().toISOString() };
    expect(render({ boards: [board] })).not.toContain('class="workspace-session-count');
    const rail = render({ boards: [board], collapsed: true });
    expect(rail).not.toContain('workspace-disclosure');
    expect(rail).not.toContain('workspace-sessions');
  });
});
