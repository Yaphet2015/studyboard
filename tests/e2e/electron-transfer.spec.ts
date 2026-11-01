import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { insuranceBoard } from "./fixtures";
import { waitForApp } from "./ready";

test("desktop import restores SQLite histories; native exports and reopening preserve the shared board", async () => {
  test.skip(
    process.platform !== "darwin",
    "Actual desktop acceptance runs on macOS.",
  );
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "studyboard-transfer-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.STUDYBOARD_DEV_SERVER;
  delete env.OPENAI_API_KEY;
  env.STUDYBOARD_E2E = "1";
  env.STUDYBOARD_TEST_USERDATA = join(directory, "userdata");
  let app: ElectronApplication | undefined;
  try {
    const board = insuranceBoard(true);
    const messages = Array.from({ length: 242 }, (_, i) => ({
      id: `durable-${i}-0`,
      role: i % 2 ? "assistant" : "user",
      text: `桌面共享记录 ${i}`,
      createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    }));
    const input = join(directory, "shared.studyboard.json");
    await writeFile(
      input,
      JSON.stringify({
        format: "studyboard",
        version: 1,
        exportedAt: new Date().toISOString(),
        board,
        conversations: [{ noteId: board.notes[0].id, messages }],
      }),
    );
    app = await electron.launch({ args: ["."], env, timeout: 25_000 });
    const page = await app.firstWindow();
    await waitForApp(page);
    await page.getByLabel("选择学习数据文件").setInputFiles(input);
    await expect(page.locator(".toast")).toContainText("画板已导入");
    const imported = await page.evaluate(async (title) => {
      const boards = await window.atlas!.listBoards();
      return window.atlas!.loadBoard(boards.find((b) => b.title === title)!.id);
    }, board.title);
    expect(imported!.id).not.toBe(board.id);
    const fullHistory = await page.evaluate(
      async ([boardId, noteId]) => window.atlas!.getHistory(boardId, noteId),
      [imported!.id, board.notes[0].id],
    );
    expect(fullHistory.messages).toHaveLength(242);
    expect(fullHistory.running).toBe(false);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "画板数据", exact: true }).click();

    // Only the OS file chooser is replaced; the real bridge, serializers and file writes run.
    const output = join(directory, "export.studyboard.json");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, output);
    await page.getByRole("button", { name: "导出画板", exact: true }).click();
    await page
      .getByRole("dialog", { name: "导出当前画板" })
      .getByRole("button", { name: "学习数据" })
      .click();
    await expect(page.locator(".toast")).toContainText("画板已导出");
    expect(
      JSON.parse(await readFile(output, "utf8")).conversations[0].messages,
    ).toHaveLength(242);

    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await page.getByRole("button", { name: "导出画板", exact: true }).click();
    await page
      .getByRole("dialog", { name: "导出当前画板" })
      .getByRole("button", { name: "Markdown 文档" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "导出当前画板" }),
    ).toHaveAttribute("aria-busy", "false");
    const markdown = join(directory, "export.md");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, markdown);
    await page
      .getByRole("dialog", { name: "导出当前画板" })
      .getByRole("button", { name: "Markdown 文档" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "导出当前画板" }),
    ).toHaveCount(0);
    expect(await readFile(markdown, "utf8")).toContain("桌面共享记录 0");

    const png = join(directory, "export.png");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, png);
    await page.getByRole("button", { name: "导出画板", exact: true }).click();
    await page
      .getByRole("dialog", { name: "导出当前画板" })
      .getByRole("button", { name: "PNG 全图截图" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "导出当前画板" }),
    ).toHaveCount(0);
    expect((await readFile(png)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await app.close();
    app = await electron.launch({ args: ["."], env, timeout: 25_000 });
    const reopened = await app.firstWindow();
    await waitForApp(reopened);
    const restored = await reopened.evaluate(
      async ([boardId, noteId]) => ({
        board: await window.atlas!.loadBoard(boardId),
        history: await window.atlas!.getHistory(boardId, noteId),
      }),
      [imported!.id, board.notes[0].id],
    );
    // Restored boards pass the schema, which fills the goal-weights default weight.
    expect(restored.board!.nodes).toEqual(
      board.nodes.map((n: any) => ({ ...n, weight: n.weight ?? "background" })),
    );
    expect(restored.history.messages).toHaveLength(242);
    expect(restored.history.messages[0].text).toBe("桌面共享记录 0");
    expect(restored.history.running).toBe(false);
  } finally {
    if (app) {
      const child = app.process();
      await app.close().catch(() => {});
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
