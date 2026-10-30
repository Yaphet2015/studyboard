import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { gotoApp } from "./ready";

async function newQuestion(page: Page, topic: string) {
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill(topic);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
}

test("a new question starts ordinary goal questions; a chip sends its answer", async ({ page }) => {
  await installFakeAtlas(page);
  await gotoApp(page);
  await page.evaluate(() => { (window as any).__atlasChatAnswers = [
    '你想拿到什么？\n```json\n{"chips":["一份说明图","一套判断规则"]}\n```',
    "怎样算讲清楚了？",
  ]; });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill("彩虹是怎么形成的？");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const drawer = page.locator(".drawer");
  await expect(drawer).toContainText("你想拿到什么？");
  await drawer.getByRole("button", { name: "一份说明图", exact: true }).click();
  await expect(drawer).toContainText("怎样算讲清楚了？");
  await expect(drawer.locator(".user").last()).toHaveText("一份说明图");
  const asks = await page.evaluate(() => (window as any).__atlasAsks);
  expect(asks.map((a: any) => a.mode)).toEqual(["chat", "chat"]);
  expect(asks[0].prompt).toContain("3–5 题");
  expect(asks[1].prompt).toContain("产出物");
  await expect(drawer.getByRole("region", { name: "摸底" })).toHaveCount(0);
});

test("closing and reopening goal questions preserves the conversation without another call", async ({ page }) => {
  await installFakeAtlas(page);
  await newQuestion(page, "彩虹是怎么形成的？");
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".msg.assistant.chat")).toHaveCount(1);
  const text = await drawer.locator(".msg.assistant.chat").textContent();
  await drawer.getByLabel("关闭").click();
  await page.getByRole("button", { name: "继续：AI 带我开始", exact: true }).click();
  await expect(drawer.locator(".msg.assistant.chat")).toHaveText(text!);
  expect(await page.evaluate(() => (window as any).__atlasAsks.length)).toBe(1);
});

test("without an AI provider the kickoff leads to settings", async ({
  page,
}) => {
  await newQuestion(page, "How does a rainbow form?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("关闭设置").click();
  await page.getByRole("button", { name: "让 AI 带我开始" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#settings-title")).toHaveText("设置");
  await expect(page.getByRole("heading", { name: "AI 服务" })).toBeVisible();
});

test("「测试连接」 shows success with model and latency, then a readable failure", async ({
  page,
}) => {
  await installFakeAtlas(page, false);
  await gotoApp(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/API 密钥/).fill("good");
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "连接成功 · 已连到 gpt-4o-mini · 用时 0.8 秒",
  );
  await dialog.getByLabel(/API 密钥/).fill("bad");
  await expect(dialog.getByRole("status")).toHaveText("");
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await expect(dialog.getByRole("status")).toContainText("鉴权失败");
});
