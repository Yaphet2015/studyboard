import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { insuranceBoard } from "./fixtures";
import { gotoApp } from "./ready";

const first = '.react-flow__node[data-id="c-what"]';
const second = '.react-flow__node[data-id="c-when-not"]';
async function setup(
  page: Page,
  reduced = false,
  theme = "light",
  replacement?: { before: string; after: string },
) {
  const board = insuranceBoard(true);
  board.nodes[1].body =
    replacement?.before ?? "这句始终不变。等待期通常是三十天。";
  board.nodes[2].body = "请先读合同。免责条款列出不赔情况。";
  const draft = structuredClone(board);
  draft.nodes[1].body =
    replacement?.after ?? "这句始终不变。等待期需要核对合同。";
  draft.nodes[2].body = "请先读合同。免责条款写明不赔情况。";
  await page.emulateMedia({
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await installFakeAtlas(page, true, "web", [board]);
  await page.addInitScript(
    ({ draft, theme }) => {
      (window as any).__atlasCanvasDraft = draft;
      localStorage.setItem("studyboard-theme", theme);
    },
    { draft, theme },
  );
  await gotoApp(page);
  await page.evaluate(
    (theme) =>
      document.documentElement.classList.toggle("dark", theme === "dark"),
    theme,
  );
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  // Keep a reference to the unchanged sentence before any Agent result arrives.
  await page.locator(`${first} .face-body`).evaluate((el) => {
    (window as any).__sameSentence = [...el.querySelectorAll("span")].find(
      (s) => s.textContent === "这句始终不变。",
    );
    (window as any).__otherPosition = document
      .querySelector('.react-flow__node[data-id="c-how"]')!
      .getAttribute("style");
  });
  await page.getByRole("button", { name: "整理画布", exact: true }).click();
  await page.clock.runFor(1100);
  await expect(page.locator(`${first} [data-agent-edit]`)).toHaveCount(1);
}

test("Agent body wash preserves unchanged DOM, saves new data immediately, and removes every overlay", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".agent-edit-wash")).toHaveCount(2);
  const saved = await page.evaluate(async () =>
    (window as any).atlas.loadBoard("board-ci"),
  );
  expect(saved.nodes[1].body).toBe("这句始终不变。等待期需要核对合同。");
  await page.clock.runFor(1050);
  await expect(page.locator(`${first} .agent-edit-wash`)).toBeVisible();
  expect(
    await page
      .locator(`${first} .face-body`)
      .evaluate((el) => el.contains((window as any).__sameSentence)),
  ).toBe(true);
  await page.clock.runFor(3500);
  await expect(
    page.locator(
      "[data-agent-edit], .agent-edit-wash, .agent-edit-new, .agent-edit-old, .agent-edit-placeholder",
    ),
  ).toHaveCount(0);
  await expect(page.locator(`${first} .face-body`)).toHaveText(
    "这句始终不变。等待期需要核对合同。",
  );
  await expect(page.locator(`${first} .face-body [aria-hidden]`)).toHaveCount(
    0,
  );
  expect(
    await page
      .locator(`${first} .face-body`)
      .evaluate((el) => el.contains((window as any).__sameSentence)),
  ).toBe(true);
  expect(
    await page
      .locator('.react-flow__node[data-id="c-how"]')
      .getAttribute("style"),
  ).toBe(await page.evaluate(() => (window as any).__otherPosition));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("[data-agent-edit]")).toHaveCount(0);
  await expect(page.locator(`${first} .face-body`)).toContainText(
    "等待期通常是三十天。",
  );
});

test("reduced motion swaps at 120ms without a sweep, then completely cleans up", async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.locator('[data-agent-edit="reduced"]')).toHaveCount(2);
  await page.clock.runFor(500);
  const heights = await page
    .locator(".agent-edit-wash")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.height));
  await page.clock.runFor(150);
  expect(
    await page
      .locator(".agent-edit-wash")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.height)),
  ).toEqual(heights);
  await expect(
    page.locator(`${first} .agent-edit-new [data-change]`),
  ).toHaveCSS("opacity", "1");
  await page.clock.runFor(1500);
  await expect(
    page.locator("[data-agent-edit], .agent-edit-new, .agent-edit-wash"),
  ).toHaveCount(0);
  await expect(page.locator(`${first} .face-body`)).toContainText(
    "等待期需要核对合同。",
  );
});

test("line count changes grow the card smoothly without moving other cards", async ({
  page,
}) => {
  await setup(page, false, "light", {
    before: "短句。",
    after:
      "这是改写后更长的一句话，需要逐条阅读合同里的具体约定，再判断哪一种保障适合自己的情况。",
  });
  const body = page.locator(`${first} .face-body`);
  const start = await body.evaluate((el) => el.getBoundingClientRect().height);
  await page.clock.runFor(1700);
  const end = await body.evaluate((el) => el.getBoundingClientRect().height);
  expect(end).toBeGreaterThan(start);
  expect(
    await page
      .locator('.react-flow__node[data-id="c-how"]')
      .getAttribute("style"),
  ).toBe(await page.evaluate(() => (window as any).__otherPosition));
  await page.clock.runFor(2000);
  await expect(page.locator("[data-agent-edit]")).toHaveCount(0);
  expect(
    await body.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeCloseTo(end, 0);
});

test("clearing an existing body fades out the old sentences and leaves no empty animation wrapper", async ({
  page,
}) => {
  await setup(page, false, "light", {
    before: "这段正文即将移除。",
    after: "",
  });
  await expect(page.locator(`${first} .agent-edit-old`)).toHaveText(
    "这段正文即将移除。",
  );
  await page.clock.runFor(4000);
  await expect(page.locator(`${first} .face-body`)).toHaveCount(0);
  await expect(page.locator("[data-agent-edit]")).toHaveCount(0);
});

for (const theme of ["light", "dark"])
  test(`screenshots: ${theme}, two cards staggered`, async ({
    page,
  }, testInfo) => {
    await setup(page, false, theme);
    // setup ends 100ms after commit; advance the real production rAF timeline with Playwright's clock.
    for (const [name, advance] of [
      ["start", 400],
      ["middle", 600],
      ["fade", 1300],
    ] as const) {
      await page.clock.runFor(advance);
      await page.screenshot({
        path: path.join(
          existsSync("/workspace/studyboard-agent-edit")
            ? "/workspace/studyboard-agent-edit/shots"
            : testInfo.outputPath("shots"),
          `${theme}-${name}.png`,
        ),
      });
    }
    const values = await page
      .locator(`${first} .agent-edit-wash, ${second} .agent-edit-wash`)
      .evaluateAll((els) =>
        els.map((e) => Number((e as HTMLElement).style.opacity)),
      );
    expect(values).toHaveLength(2);
    expect(values[0]).toBeLessThan(values[1]);
    await page.clock.runFor(2500);
  });
