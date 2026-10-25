import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installFakeAtlas } from "./fake-atlas";
import { insuranceBoard } from "./fixtures";
import { gotoApp, reloadApp } from "./ready";

const rows = (page: Page) =>
  page.locator(
    '.workspace-sessions:visible .workspace-session[role="treeitem"]',
  );
const group = (page: Page, id: string) =>
  page.locator(
    `li[role="treeitem"]:has(> .workspace-board-row > .workspace-disclosure[aria-controls="sessions-${id}"])`,
  );
const toggle = (page: Page, id: string) =>
  group(page, id).locator(".workspace-disclosure");

function canvas(id: string, count: number, offset = 0) {
  const board = insuranceBoard(true);
  board.id = id;
  board.title = `画布 ${id}`;
  board.updatedAt = new Date(Date.now() - offset * 86400000).toISOString();
  const template = board.notes[0];
  board.notes = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(template),
    id: `${id}-session-${i}`,
    title: `对话 ${i + 1}`,
    attachedTo: {
      kind: "node" as const,
      id: i === count - 1 ? "c-how" : board.nodes[0].id,
    },
    messages: template.messages.map((m) => ({
      ...m,
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    })),
  }));
  return board;
}

async function holdLoads(page: Page, id: string, fail = false) {
  await page.evaluate(
    ({ id, fail }) => {
      const w = window as any;
      const original = w.atlas.loadBoard;
      w.__sessionLoadCalls = 0;
      w.atlas.loadBoard = async (boardId: string) => {
        if (boardId === id) {
          w.__sessionLoadCalls++;
          if (fail) throw new Error("fixture read failure");
          await new Promise<void>((resolve) => {
            w.__releaseSessionLoad = resolve;
          });
        }
        return original(boardId);
      };
      w.__restoreSessionLoads = () => {
        w.atlas.loadBoard = original;
      };
    },
    { id, fail },
  );
}

async function releaseLoads(page: Page) {
  await page.evaluate(() => {
    (window as any).__restoreSessionLoads();
    (window as any).__releaseSessionLoad?.();
  });
}

test("disclosures and counts stay visible; canvas selection preserves persisted expansion", async ({
  page,
}) => {
  const a = canvas("a", 2),
    b = canvas("b", 3, 1);
  await installFakeAtlas(page, true, "web", [a, b]);
  await gotoApp(page);
  await expect(rows(page)).toHaveCount(0);
  const arrow = toggle(page, a.id);
  await expect(arrow).toHaveCSS("opacity", "1");
  const box = (await arrow.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await group(page, b.id).locator(".workspace-session-count").click();
  await expect(
    group(page, b.id).locator('.workspace-session[role="treeitem"]'),
  ).toHaveCount(3);
  await expect(group(page, a.id)).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: a.title, exact: true }).click();
  await expect(arrow).toHaveAttribute("aria-expanded", "false");
  await toggle(page, b.id).click();
  await page.getByRole("button", { name: b.title, exact: true }).click();
  await expect(toggle(page, b.id)).toHaveAttribute("aria-expanded", "false");
  await arrow.click();
  await reloadApp(page);
  await expect(arrow).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, b.id)).toHaveAttribute("aria-expanded", "false");
});

test("twelve sessions retain the older current conversation; show all persists and time survives narrow width", async ({
  page,
}) => {
  const board = canvas("twelve", 12);
  await installFakeAtlas(page, true, "web", [board]);
  await gotoApp(page);
  await toggle(page, board.id).click();
  await expect(rows(page)).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "展开更多 · 还有 6 个" }),
  ).toBeVisible();
  await page.locator('.react-flow__node[data-id="c-how"]').click();
  await expect(rows(page)).toHaveCount(7);
  await expect(rows(page).last()).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "展开更多 · 还有 5 个" }),
  ).toBeVisible();
  await toggle(page, board.id).click();
  await expect(
    group(page, board.id).locator(".workspace-session-count"),
  ).toHaveClass(/is-open/);
  await toggle(page, board.id).click();
  await page.getByRole("button", { name: "展开更多 · 还有 5 个" }).click();
  await expect(rows(page)).toHaveCount(12);
  await reloadApp(page);
  await expect(rows(page)).toHaveCount(12);
  const handle = page.getByRole("separator", { name: "调整左侧栏宽度" });
  await handle.focus();
  await handle.press("Home");
  await expect(rows(page).first().locator("time")).toBeVisible();
  await expect(rows(page).first()).toHaveCSS("height", "44px");
});

test("search filters title and anchor above twenty sessions without nested scrolling", async ({
  page,
}) => {
  const board = canvas("search", 21);
  board.notes[20].title = "犹豫期的问题";
  await installFakeAtlas(page, true, "web", [board]);
  await gotoApp(page);
  await toggle(page, board.id).click();
  const input = page.getByPlaceholder("搜索对话");
  await input.fill("犹豫期");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("犹豫期的问题");
  await input.fill("不存在的问题");
  await expect(page.getByText("没有匹配的对话", { exact: true })).toBeVisible();
  await input.fill("起点问题");
  await expect(rows(page)).toHaveCount(20);
  await expect(
    group(page, board.id).locator(".workspace-sessions"),
  ).not.toHaveCSS("overflow-y", "auto");
});

test("keyboard navigates visible rows and expands without selecting another canvas", async ({
  page,
}) => {
  const a = canvas("keyboard", 2),
    b = canvas("other", 1, 1);
  await installFakeAtlas(page, true, "web", [a, b]);
  await gotoApp(page);
  const boardButton = page.getByRole("button", { name: a.title, exact: true });
  await boardButton.focus();
  await boardButton.press("ArrowRight");
  await expect(toggle(page, a.id)).toHaveAttribute("aria-expanded", "true");
  await boardButton.press("ArrowDown");
  await expect(rows(page).first()).toBeFocused();
  await rows(page).first().press("Enter");
  await expect(rows(page).first()).toHaveAttribute("aria-current", "page");
  await toggle(page, b.id).focus();
  await toggle(page, b.id).press("Space");
  await expect(toggle(page, b.id)).toHaveAttribute("aria-expanded", "true");
  await expect(group(page, a.id)).toHaveAttribute("aria-current", "true");
  await boardButton.focus();
  await boardButton.press("ArrowLeft");
  await expect(toggle(page, a.id)).toHaveAttribute("aria-expanded", "false");
});

test("lazy loading, cached reopen, errors, retries and cross-canvas switching are explicit", async ({
  page,
}) => {
  const a = canvas("current", 0),
    b = canvas("remote", 2, 1);
  await installFakeAtlas(page, true, "web", [a, b]);
  await gotoApp(page);
  await toggle(page, a.id).click();
  await expect(group(page, a.id)).toContainText("还没有对话");
  await expect(
    group(page, a.id).getByRole("button", { name: "新对话" }),
  ).toBeVisible();
  await holdLoads(page, b.id);
  await toggle(page, b.id).click();
  await expect(group(page, b.id)).toContainText("正在读取对话…");
  await expect(
    group(page, b.id).locator(".workspace-session-skeleton"),
  ).toHaveCount(2);
  await releaseLoads(page);
  await expect(rows(page)).toHaveCount(2);
  await holdLoads(page, b.id, true);
  await toggle(page, b.id).click();
  await toggle(page, b.id).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__sessionLoadCalls)).toBe(0);
  await rows(page).first().click();
  await expect(group(page, b.id)).toContainText("无法打开 ·");
  await releaseLoads(page);
  await holdLoads(page, b.id);
  await group(page, b.id).getByRole("button", { name: "重试" }).click();
  await expect(rows(page).first()).toHaveAttribute("aria-busy", "true");
  await expect(
    rows(page).first().locator(".workspace-session-spinner"),
  ).toBeVisible();
  await expect(rows(page).first()).toBeDisabled();
  await releaseLoads(page);
  await expect(rows(page).first()).toHaveAttribute("aria-current", "page");
  await expect(group(page, b.id)).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".drawer")).toBeVisible();
});

test("failed first read can retry; unknown legacy counts appear after loading", async ({
  page,
}) => {
  const a = canvas("current", 0),
    b = canvas("legacy", 1, 1);
  await installFakeAtlas(page, true, "web", [a, b]);
  await page.addInitScript(() => {
    (window as any).__atlasLegacyCounts = true;
  });
  await gotoApp(page);
  await expect(
    group(page, b.id).locator(".workspace-session-count"),
  ).toHaveCount(0);
  await holdLoads(page, b.id, true);
  await toggle(page, b.id).click();
  await expect(group(page, b.id)).toContainText("无法读取对话");
  await releaseLoads(page);
  await group(page, b.id).getByRole("button", { name: "重试" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(
    group(page, b.id).locator(".workspace-session-count"),
  ).toHaveText("1");
});

for (const scheme of ["light", "dark"] as const) {
  test(`session design screenshots · ${scheme}`, async ({ page }) => {
    const dir = process.env.SHOTS_DIR;
    test.skip(!dir, "set SHOTS_DIR to capture the sidebar session states");
    mkdirSync(dir!, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme });
    const a = canvas("twelve", 12),
      empty = canvas("empty", 0, 1),
      loading = canvas("loading", 2, 2),
      error = canvas("error", 1, 3);
    await installFakeAtlas(page, true, "web", [a, empty, loading, error]);
    await gotoApp(page);
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      // Let the disclosure height/opacity transition settle.
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${dir}/sessions-${scheme}-${name}.png` });
    };
    await shot("collapsed");
    await toggle(page, a.id).click();
    await shot("expanded");
    await page.locator('.react-flow__node[data-id="c-how"]').click();
    await shot("twelve-current");
    await rows(page).nth(1).hover();
    await rows(page).nth(1).focus();
    await page.keyboard.press("ArrowDown");
    await shot("hover-focus");
    await toggle(page, a.id).click();
    await shot("collapsed-current");
    await toggle(page, empty.id).click();
    await holdLoads(page, loading.id);
    await toggle(page, loading.id).click();
    await expect(group(page, loading.id)).toContainText("正在读取对话…");
    await shot("empty-loading");
    await releaseLoads(page);
    await expect(
      group(page, loading.id).locator('.workspace-session[role="treeitem"]'),
    ).toHaveCount(2);
    await holdLoads(page, error.id, true);
    await toggle(page, error.id).click();
    await expect(group(page, error.id)).toContainText("无法读取对话");
    await shot("read-error");
    await releaseLoads(page);
    await holdLoads(page, loading.id);
    await group(page, loading.id)
      .locator('.workspace-session[role="treeitem"]')
      .first()
      .click();
    await expect(
      group(page, loading.id).locator('[aria-busy="true"]'),
    ).toBeVisible();
    await shot("switching");
    await releaseLoads(page);
    await expect(group(page, loading.id)).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByRole("button", { name: empty.title, exact: true }).click();
    await expect(group(page, empty.id).getByRole("button", { name: "新对话" })).toBeVisible();
    await shot("empty-current");
  });
}
