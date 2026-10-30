import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { insuranceBoard, routedBoard } from "./fixtures";
import { gotoApp } from "./ready";

const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const gates = (page: Page) => page.evaluate(() => (window as any).__atlasGates as any[]);
const disk = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0]);

test("a legacy stop still studies in order; a wrong answer adds a choice footer and mastery uses a dot", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [routedBoard()]);
  await gotoApp(page);
  // Stations are numbered; exactly one is the next step.
  await expect(card(page, "c-what").locator(".station")).toHaveText("第 1 站");
  await expect(page.locator(".station.next")).toHaveCount(1);
  await expect(card(page, "c-when-not").locator(".station.next")).toHaveText("第 2 站");
  await expect(card(page, "c-when-not").locator(".next-tag")).toHaveText("下一步");
  const bar = page.getByRole("region", { name: "下一步" });
  await expect(bar).toContainText("下一步 · 第 2 站");
  await expect(bar).toContainText("等待期内确诊，保险公司通常不赔 —— 先猜一猜");
  await expect(bar).toContainText("为什么是它：第 1 站你已讲清楚");
  await bar.getByRole("button", { name: /开始/ }).click();
  const stop = page.getByRole("region", { name: "这一站" });
  // 先猜: the body stays hidden until the guess is written down.
  await expect(stop.locator(".beat.on")).toHaveText("先猜");
  await expect(stop.locator(".card-body")).toHaveCount(0);
  await stop.getByLabel("我的猜测").fill("怕有人生病了才买");
  await stop.getByRole("button", { name: /记下猜测/ }).click();
  // 学.
  await expect(stop.locator(".beat.on")).toHaveText("学");
  await expect(stop.locator(".card-body")).toContainText("带病投保");
  await expect(stop).toContainText("你猜的是：怕有人生病了才买");
  await stop.getByRole("button", { name: /读完了/ }).click();
  // 讲: one short marking call with the card's key points only.
  await stop.getByLabel("用我的话讲").fill("等待期里确诊一般不赔，防止带病投保");
  await stop.getByRole("button", { name: /提交/ }).click();
  await expect(stop.locator(".beat.on")).toHaveText("测");
  let marks = (await gates(page)).filter((r) => r.mode === "mark");
  expect(marks).toHaveLength(1);
  expect(marks[0].prompt).toContain("SECRET-NEWIDEA");
  expect(marks[0].context.review).toBeUndefined();
  // 测: a wrong option fails locally (no call); the right one plus a reason is marked once.
  await expect(stop).toContainText("小李投保第 2 个月");
  await stop.getByRole("radio", { name: /疾病定义/ }).click();
  await stop.getByLabel("再用一句话说说为什么").fill("定义不符");
  await stop.getByRole("button", { name: /提交/ }).click();
  await expect(stop.locator('.weight-footer[data-weight="core"]')).toHaveCount(1);
  expect((await gates(page)).filter((r) => r.mode === "mark")).toHaveLength(1);
  // The upgraded core footer answers the prepared choice without a separate reason field.
  await stop.locator(".weight-options").getByRole("button", { name: "等待期", exact: true }).click();
  await expect(stop).toContainText("已掌握");
  await expect.poll(async () => (await disk(page)).nodes.find((n: any) => n.id === "c-when-not"))
    .toMatchObject({ weight: "core", status: "explained", seal: "test", beat: "done", fails: 0 });
  await expect(card(page, "c-when-not").locator(".station-dot.mastered")).toHaveCount(1);
  // The bar moves on to stop 3.
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(bar).toContainText("下一步 · 第 3 站");
  await expect(card(page, "c-how").locator(".station.next")).toHaveText("第 3 站");
});

test("换一个 skips to the next stop; a half-done stop is resumed with a welcome", async ({ page }) => {
  const board = routedBoard();
  board.nodes.find((n: any) => n.id === "c-how").beat = "explain";
  await installFakeAtlas(page, true, "web", [board]);
  await gotoApp(page);
  const bar = page.getByRole("region", { name: "下一步" });
  await expect(bar).toContainText("第 3 站");
  await expect(bar).toContainText("继续：讲");
  await expect(bar).toContainText("欢迎回来。上次做到第 3 站的「讲」");
  await bar.getByRole("button", { name: "换一个" }).click();
  await expect(bar).toContainText("第 2 站");
});

test("ghost hints only on the current stop or a picked card once there is a route", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [routedBoard()]);
  await gotoApp(page);
  await card(page, "c-how").locator("article").hover();
  await page.waitForTimeout(900);
  await expect(card(page, "c-how").locator(".ghost-hint")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__atlasHints.length)).toBe(0);
  await card(page, "c-when-not").locator("article").hover();
  await expect(card(page, "c-when-not").locator(".ghost-hint.below")).toHaveCount(1);
});

test("an old map without a route gets 帮我排一条路线", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [insuranceBoard(true)]);
  await gotoApp(page);
  const bar = page.getByRole("region", { name: "下一步" });
  await expect(bar).toContainText("这张地图还没有路线");
  await bar.getByRole("button", { name: "帮我排一条路线" }).click();
  await expect(bar).toContainText("下一步 · 第");
  await expect.poll(async () => (await disk(page)).route).toEqual(["c-what", "c-when-not", "c-how", "c-money"]);
});

test("card UI shows only title, prose and the check question: gate data is never rendered", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [routedBoard()]);
  await gotoApp(page);
  await card(page, "c-when-not").click();
  const stop = page.getByRole("region", { name: "这一站" });
  await expect(stop).toBeVisible();
  // Walk to 测 so the check question is on screen too.
  await page.evaluate(() => {
    const disk = JSON.parse(localStorage.getItem("fake-atlas-disk")!);
    disk[0].nodes.find((n: any) => n.id === "c-when-not").beat = "test";
    localStorage.setItem("fake-atlas-disk", JSON.stringify(disk));
  });
  await page.reload();
  await card(page, "c-when-not").click();
  await expect(page.getByRole("region", { name: "这一站" })).toContainText("小李投保第 2 个月");
  const html = await page.evaluate(() => document.body.innerHTML);
  for (const secret of ["SECRET-NEWIDEA", "SECRET-ADDSBEYOND", "SECRET-CLAIM", "SECRET-JUDGE", "SECRET-KEYPOINT", "0.456", "0.123", "addsBeyond", "为什么重要", "常见误解"])
    expect(html, secret).not.toContain(secret);
});

test("the gate rejects a card restating its parent, regenerates once, then drops it", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [routedBoard()]);
  const restate = JSON.stringify({
    nodes: [{ id: "r1", title: "保什么病", body: "病种数量、重疾、中症、轻症怎么分层、每种病的定义写在哪。", parent: "anchor" }],
    relations: [],
  });
  await page.addInitScript((answer) => {
    (window as any).__atlasRawCards = true;
    (window as any).__atlasExpansionAnswers = [answer, answer];
  }, restate);
  await gotoApp(page);
  const before = await page.locator(".react-flow__node").count();
  await card(page, "c-what").click();
  await page.getByRole("button", { name: "再看一层", exact: true }).click();
  await expect(page.getByText(/这一块暂时挖不出新东西了/)).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(before);
  const regen = (await gates(page)).filter((r) => r.mode === "regen");
  expect(regen).toHaveLength(1);
  expect(regen[0].prompt).toContain("没有通过新知识检查");
});
