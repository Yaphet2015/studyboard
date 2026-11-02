import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { installFakeAtlas } from "./fake-atlas";
import { routedBoard } from "./fixtures";
import { gotoApp } from "./ready";

/**
 * Flow redesign screenshots, phase 2 (摸底, 合起来讲). Not a regression test.
 * Run with SHOTS_DIR=/path npx playwright test shots-flow-p2
 */
const dir = process.env.SHOTS_DIR;
test.skip(!dir, "set SHOTS_DIR to shoot the design screenshots");
test.setTimeout(120_000);

async function theme(page: Page, mode: "light" | "dark") {
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if (dark !== (mode === "dark")) await page.keyboard.press("d");
}
async function setup(page: Page, mode: "light" | "dark") {
  mkdirSync(dir!, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: mode });
}

const REAL = JSON.parse(readFileSync(new URL("./probe-real.json", import.meta.url), "utf8"));
const pts = (r: string) => JSON.parse(r.slice(r.indexOf("{"))).points as any[];
const CHAIN = pts(REAL.chain);
const REFINE = pts(REAL.refine);
const ALL = [...CHAIN, ...REFINE, ...REAL.expands.flatMap(pts)];
const TOPIC = "重疾险有哪些重要条款？";
/** Release one held generation call (fake-atlas __atlasHold). */
const holdStep = (page: Page) => async () => {
  await page.waitForFunction(() => typeof (window as any).__atlasRelease === "function", undefined, { timeout: 5000 });
  await page.evaluate(() => {
    const r = (window as any).__atlasRelease;
    (window as any).__atlasRelease = undefined;
    r();
  });
};

test("摸底 · slow (reduced motion, light)", async ({ page }) => {
  await setup(page, "light");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await installFakeAtlas(page);
  await page.addInitScript(() => ((window as any).__atlasHold = true));
  await gotoApp(page);
  await theme(page, "light");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill(TOPIC);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const probe = page.locator(".drawer").getByRole("region", { name: "摸底" });
  await expect(probe).toContainText("比平时慢一点…", { timeout: 15000 });
  await page.screenshot({ path: `${dir}/probe-skeleton-slow-reduced-light.png` });
});

for (const mode of ["light", "dark"] as const) {
  test(`摸底 · ${mode}`, async ({ page }) => {
    await setup(page, mode);
    await installFakeAtlas(page);
    // Real generated content (deepseek sample in probe-real.json): the chain, then the refine.
    await page.addInitScript((q) => {
      (window as any).__atlasHold = true;
      (window as any).__atlasProbeAnswers = q;
    }, [REAL.chain, REAL.refine]);
    await gotoApp(page);
    await theme(page, mode);
    const step = holdStep(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: /新的问题/ }).click();
    await page.getByLabel("新白板问题").fill(TOPIC);
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    const probe = page.locator(".drawer").getByRole("region", { name: "摸底" });
    // (a) first question skeleton.
    await expect(probe).toContainText(`正在为「${TOPIC}」出第一道题…`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/probe-skeleton-a-${mode}.png` });
    await step();
    // Question, with a reason typed into the optional field.
    await expect(probe).toContainText("第 1 题");
    const known = new Set([...CHAIN.slice(0, 3), REFINE[0]].map((p: any) => p.concept));
    let shotQ = false;
    for (let i = 0; i < 20; i++) {
      if (await probe.getByText("在缩小范围…").count()) {
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${dir}/probe-skeleton-b-refine-${mode}.png` });
        await step().catch(() => undefined);
        await page.waitForTimeout(300);
        continue;
      }
      if (await probe.getByText("正在确定你的起点…").count()) break;
      const q = (await probe.locator(".beat-q").count()) ? await probe.locator(".beat-q").textContent() : null;
      const p = ALL.find((x: any) => x.probe.q === q);
      if (!p) {
        await page.waitForTimeout(150);
        continue;
      }
      const right = p.probe.answer;
      const pick = known.has(p.concept) ? right : (right + 1) % p.probe.options.length;
      await probe.getByRole("radio", { name: p.probe.options[pick] }).click();
      if (!shotQ) {
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${dir}/probe-question-${mode}.png` });
        shotQ = true;
      }
      await probe.getByRole("button", { name: "确定" }).click();
      await page.waitForTimeout(150);
    }
    // (c) computing the result (plan held).
    await expect(probe).toContainText("正在确定你的起点…");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/probe-skeleton-c-${mode}.png` });
    await step();
    await expect(probe).toContainText("你已经懂到");
    await expect(probe).not.toContainText(/·\s*\d|L\d/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/probe-result-${mode}.png` });
  });

  test(`摸底 expert · ${mode}`, async ({ page }) => {
    await setup(page, mode);
    await installFakeAtlas(page);
    await page.addInitScript((q) => {
      (window as any).__atlasHold = true;
      (window as any).__atlasProbeAnswers = q;
    }, [REAL.chain, ...REAL.expands]);
    await gotoApp(page);
    await theme(page, mode);
    const step = holdStep(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: /新的问题/ }).click();
    await page.getByLabel("新白板问题").fill(TOPIC);
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    const probe = page.locator(".drawer").getByRole("region", { name: "摸底" });
    await step();
    let shotB = false;
    for (let i = 0; i < 60; i++) {
      if (await probe.getByText("答对了，在往更深处找…").count()) {
        if (!shotB) {
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${dir}/probe-skeleton-b-${mode}.png` });
          shotB = true;
        }
        await step().catch(() => undefined);
        await page.waitForTimeout(300);
        continue;
      }
      if (await probe.getByText("正在确定你的起点…").count()) break;
      if (await page.evaluate(() => typeof (window as any).__atlasRelease === "function") && !(await probe.locator(".beat-q").count())) {
        // Let the deeper skeleton (b) show before releasing the held expansion.
        await page.waitForTimeout(600);
        continue;
      }
      const q = (await probe.locator(".beat-q").count()) ? await probe.locator(".beat-q").textContent() : null;
      const p = ALL.find((x: any) => x.probe.q === q);
      if (!p) {
        await page.waitForTimeout(150);
        continue;
      }
      await probe.getByRole("radio", { name: p.probe.options[p.probe.answer] }).click();
      await probe.getByRole("button", { name: "确定" }).click();
      await page.waitForTimeout(150);
    }
    // Release the prefetch / plan holds that remain.
    for (let i = 0; i < 3; i++) await step().catch(() => undefined);
    await expect(probe).toContainText(/你懂得挺深|你已经懂到/);
    await expect(probe.locator(".probe-start")).not.toContainText(CHAIN[0].concept);
    await expect(probe).not.toContainText(/·\s*\d|L\d/);
    await expect(page.locator(".drawer")).not.toContainText("彩虹");
    await expect(page.locator(".drawer .plan-kind")).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/probe-expert-result-${mode}.png` });
  });

  test(`合起来讲 · ${mode}`, async ({ page }) => {
    await setup(page, mode);
    const b = routedBoard();
    for (const n of b.nodes) if (n.parentId) Object.assign(n, { status: "explained", seal: "test", beat: "done" });
    await installFakeAtlas(page, true, "web", [b]);
    await gotoApp(page);
    await theme(page, mode);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/06-wrap-bar-${mode}.png` });
    await page.getByRole("region", { name: "下一步" }).getByRole("button", { name: /开始讲/ }).click();
    const wrap = page.getByRole("region", { name: "合起来讲" });
    await wrap.getByLabel("合起来讲").fill("看重疾险条款，先看它保哪些病、定义严不严。再看等待期，别刚买就出险。然后看怎么赔、能赔几次。最后看保额够不够、保到几岁。");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/06-wrap-${mode}.png` });
    await wrap.getByRole("button", { name: /讲完了/ }).click();
    await expect(page.locator(".card.lit")).toHaveCount(4);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/06-wrap-lit-${mode}.png` });
  });
}
