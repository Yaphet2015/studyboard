import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Board, ChatMessage } from "../../src/shared/types";
import { insuranceBoard } from "./fixtures";
import { gotoApp, reloadApp } from "./ready";

async function seed(page: Page) {
  const board = insuranceBoard(true) as Board;
  const messages: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
    id: `history-${i}`,
    role: i % 2 ? "assistant" : "user",
    text: `学习的第 ${i} 条记录`,
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));
  board.notes[0].messages = messages.slice(-200);
  await page.addInitScript(
    ({ board, messages }) => {
      if (localStorage.getItem("studyboard-preview-boards-v1") !== null) return;
      localStorage.setItem(
        "studyboard-preview-boards-v1",
        JSON.stringify([board]),
      );
      localStorage.setItem(
        "studyboard-preview-histories-v1",
        JSON.stringify({ [board.id]: { [board.notes[0].id]: messages } }),
      );
    },
    { board, messages },
  );
  await gotoApp(page);
  return board;
}

async function exportFile(page: Page, label: string) {
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  if (!(await settings.isVisible()))
    await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "画板数据", exact: true }).click();
  await settings.getByRole("button", { name: "导出画板", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "导出当前画板" })
    .getByRole("button", { name: label })
    .click();
  const download = await downloaded;
  return {
    name: download.suggestedFilename(),
    data: await readFile((await download.path())!),
  };
}

test("a shared file restores complete conversations as a new board, survives reload, and exports readable Markdown", async ({
  page,
}) => {
  const original = await seed(page);
  const file = await exportFile(page, "学习数据");
  expect(file.name).toMatch(/\.studyboard\.json$/);
  const archive = JSON.parse(file.data.toString("utf8"));
  expect(archive.conversations[0].messages).toHaveLength(250);
  expect(archive.conversations[0].messages[0].text).toBe("学习的第 0 条记录");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入画板", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: file.name,
    mimeType: "application/json",
    buffer: file.data,
  });
  await expect(page.locator(".toast")).toContainText("画板已导入");
  const imported = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("studyboard-preview-boards-v1")!).at(-1),
  );
  expect(imported.id).not.toBe(original.id);
  // Import validates through the board schema, which fills the goal-weights default weight.
  expect(imported.nodes).toEqual(
    original.nodes.map((n: any) => ({ ...n, weight: n.weight ?? "background" })),
  );
  expect(imported.notes[0].messages).toHaveLength(200);
  await reloadApp(page);
  await page
    .locator(`.react-flow__node[data-id="${original.nodes[0].id}"]`)
    .click();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "查看完整对话" }).click();
  const history = page.getByRole("dialog", { name: "完整对话" });
  await expect(
    history.getByText("学习的第 0 条记录", { exact: true }),
  ).toBeAttached();
  await expect(
    history.getByText("学习的第 249 条记录", { exact: true }),
  ).toBeAttached();
  await expect(history.locator("article")).toHaveCount(250);
  await page.getByRole("button", { name: "关闭完整对话" }).click();
  const markdown = await exportFile(page, "Markdown 文档");
  expect(markdown.name).toMatch(/\.md$/);
  expect(markdown.data.toString("utf8")).toContain("学习的第 0 条记录");
  expect(markdown.data.toString("utf8")).toContain("学习的第 249 条记录");
});

test("invalid data leaves the current board and stored boards intact", async ({
  page,
}) => {
  const original = await seed(page);
  await page.getByLabel("选择学习数据文件").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole("status")).toContainText("无法导入");
  const boards = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("studyboard-preview-boards-v1")!),
  );
  expect(boards).toHaveLength(1);
  expect(boards[0].id).toBe(original.id);
});

test("PNG exports the full map with visible content after panning cards off screen", async ({
  page,
}, testInfo) => {
  await seed(page);
  const pane = page.locator(".react-flow__pane");
  await pane.hover();
  await page.mouse.wheel(2500, 1800);
  await page.waitForTimeout(250);
  const image = await exportFile(page, "PNG 全图截图");
  expect(image.name).toMatch(/\.png$/);
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4)
      if (
        data[i] < 120 &&
        data[i + 1] < 120 &&
        data[i + 2] < 120 &&
        data[i + 3] > 0
      )
        ink++;
    return { width: image.width, height: image.height, ink };
  }, image.data.toString("base64"));
  expect(pixels.width).toBeGreaterThan(1000);
  expect(pixels.height).toBeGreaterThan(400);
  expect(pixels.ink).toBeGreaterThan(1000);
  await testInfo.attach("full-map.png", {
    body: image.data,
    contentType: "image/png",
  });
});
