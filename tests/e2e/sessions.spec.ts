import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { insuranceBoard } from "./fixtures";
import { gotoApp, reloadApp } from "./ready";

const card = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const entries = (page: Page) =>
  page.locator(
    ".workspace-sessions:visible .workspace-session:not(.workspace-new-session)",
  );

async function ask(page: Page, text: string) {
  const drawer = page.locator(".drawer");
  await drawer.getByLabel("向 AI 提问").fill(text);
  await drawer.getByLabel("发送提问").click();
  await expect(drawer.locator(".msg.assistant")).toHaveCount(1);
}

function seeded() {
  const board = insuranceBoard(true);
  for (const m of board.notes[0].messages)
    m.createdAt = "2026-01-05T09:00:00.000Z";
  return board;
}

test("sidebar conversations stay ordered, persist and reopen on their cards", async ({
  page,
}) => {
  const seed = seeded();
  await installFakeAtlas(page, true, "web", [seed]);
  await gotoApp(page);
  await expect(entries(page)).toHaveCount(0);
  await page
    .locator('.workspace-board[aria-current="page"]')
    .locator("..")
    .locator(".workspace-disclosure")
    .click();
  const drawer = page.locator(".drawer");
  await card(page, "c-how").click();
  await ask(page, "赔付次数怎么算？");
  await drawer.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "在这张卡上新开对话" }).click();
  await ask(page, "间隔期是多久？");
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).nth(0)).toContainText("间隔期是多久？");
  await expect(entries(page).nth(0)).toHaveAttribute("aria-current", "page");
  await expect(entries(page).nth(1)).toContainText("赔付次数怎么算？");
  await expect(entries(page).nth(2)).toContainText("带我起步");
  await expect(drawer.getByRole("group", { name: "对话标签" })).toHaveCount(0);
  await page
    .locator(".workspace-board-row.is-current .workspace-disclosure")
    .click();
  await expect(entries(page)).toHaveCount(0);
  await page
    .locator(".workspace-board-row.is-current .workspace-disclosure")
    .click();
  await expect(entries(page)).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0].notes.length,
      ),
    )
    .toBe(3);
  await reloadApp(page);
  await expect(entries(page)).not.toHaveCount(0);
  await entries(page).filter({ hasText: "赔付次数怎么算？" }).click();
  await expect(drawer.locator(".msg.user")).toHaveText("赔付次数怎么算？");
  await expect(card(page, "c-how")).toHaveClass(/selected/);
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await card(page, "c-how").click();
  await expect(drawer.locator(".msg.user")).toHaveText("间隔期是多久？");
});

test("expanding another canvas lists its sessions and opens the selected conversation", async ({
  page,
}) => {
  const first = seeded();
  const second = seeded();
  second.id = "second-canvas";
  second.title = "另一个画布";
  second.updatedAt = "2026-01-01T00:00:00.000Z";
  second.notes[0].title = "另一个画布的会话";
  await installFakeAtlas(page, true, "web", [first, second]);
  await gotoApp(page);
  await expect(entries(page)).toHaveCount(0);
  await page
    .locator('.workspace-board[aria-current="page"]')
    .locator("..")
    .locator(".workspace-disclosure")
    .click();
  await page
    .getByRole("treeitem", { name: "另一个画布", exact: true })
    .locator(".workspace-disclosure")
    .click();
  const target = entries(page).filter({ hasText: "另一个画布的会话" });
  await expect(target).toBeVisible();
  await expect(
    page.locator(
      '.workspace-board[aria-current="page"] .workspace-board-title',
    ),
  ).toHaveText(first.title);
  await target.click();
  await expect(
    page.locator(
      '.workspace-board[aria-current="page"] .workspace-board-title',
    ),
  ).toHaveText(second.title);
  await expect(page.getByLabel("批注标题")).toHaveValue("另一个画布的会话");
  await expect(target).toHaveAttribute("aria-current", "page");
});

test("web preview conversations persist and the sidebar can create a new conversation", async ({
  page,
}) => {
  await page.addInitScript(
    (value) => {
      if (!localStorage.getItem("studyboard-preview-boards-v1"))
        localStorage.setItem("studyboard-preview-boards-v1", value);
    },
    JSON.stringify([seeded()]),
  );
  await gotoApp(page);
  await expect(entries(page)).toHaveCount(0);
  await page
    .locator('.workspace-board[aria-current="page"]')
    .locator("..")
    .locator(".workspace-disclosure")
    .click();
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByLabel("批注标题").fill("犹豫期的问题");
  await expect(entries(page)).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("studyboard-preview-boards-v1")!)[0]
            .notes.length,
      ),
    )
    .toBe(2);
  await reloadApp(page);
  await expect(entries(page)).not.toHaveCount(0);
  await entries(page).filter({ hasText: "犹豫期的问题" }).click();
  await expect(page.getByLabel("批注标题")).toHaveValue("犹豫期的问题");
  await expect(
    entries(page).filter({ hasText: "犹豫期的问题" }),
  ).toHaveAttribute("aria-current", "page");
});
