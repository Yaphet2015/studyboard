import { test, expect } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { gotoApp } from "./ready";

test("⌘. opens the settings page; Esc closes it; ⌘K reaches it too", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(
    page.locator(".dock").getByRole("button", { name: "设置", exact: true }),
  ).toHaveCount(0);
  const ask = page.locator(".dock").getByRole("button", { name: "问一问 /" });
  const background = await ask.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await ask.hover();
  await expect
    .poll(() => ask.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(background);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "AI 服务" }),
  ).toBeVisible();
  // The web preview says it keeps no key.
  await expect(settings).toContainText("这里不会接收或保存密钥");
  await settings.getByRole("button", { name: "快捷键" }).click();
  await expect(settings.getByText("查看全图")).toBeVisible();
  await settings.getByRole("button", { name: "外观" }).click();
  await settings.getByRole("radio", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await settings.getByRole("radio", { name: "浅色" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await settings.getByRole("button", { name: "关于与许可" }).click();
  await expect(settings).toContainText("SIL Open Font License");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("dialog", { name: "切换地图" })
    .getByRole("button", { name: /^设置/ })
    .click();
  await expect(settings).toBeVisible();
});

test("a saved key shows masked, can be replaced or cleared", async ({
  page,
}) => {
  await installFakeAtlas(page, false);
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+.");
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("API 密钥").fill("sk-test-abcdefgh9876");
  await settings.getByRole("button", { name: "保存" }).click();
  const saved = settings.locator(".key-saved");
  await expect(saved).toContainText("sk-••••9876");
  await expect(saved).toContainText("已加密保存在本机钥匙串");
  await expect(settings.getByLabel("API 密钥")).toHaveCount(0);
  await expect(settings).not.toContainText("abcdefgh");
  // Survives closing and reopening (the runtime keeps it; the page only shows the mask).
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(settings.locator(".key-saved")).toContainText("sk-••••9876");
  await settings.getByRole("button", { name: "更换" }).click();
  await expect(settings.getByLabel("API 密钥")).toBeVisible();
  await settings.getByRole("button", { name: "清除" }).click();
  await expect(settings.locator(".key-saved")).toHaveCount(0);
  await expect(settings.getByLabel("API 密钥")).toBeVisible();
});

test("custom Agent instructions survive reopening settings and can be cleared", async ({
  page,
}) => {
  await installFakeAtlas(page);
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+.");
  const settings = page.getByRole("dialog", { name: "设置" });
  const instructions = settings.getByRole("textbox", {
    name: "Agent 自定义指令",
  });
  await instructions.fill("先给结论。\n每次只解释一个概念。");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("已保存");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(instructions).toHaveValue("先给结论。\n每次只解释一个概念。");
  await instructions.fill("");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("已保存");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(instructions).toHaveValue("");
});

test("学习画像 is read-only and shows empty copy and a quiet footer", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+.");
  const settings = page.getByRole("dialog", { name: "设置" });
  const nav = settings.getByRole("navigation", { name: "设置分区" });
  await expect(nav.getByRole("button").first()).toHaveText("学习画像");
  await nav.getByRole("button", { name: "学习画像" }).click();
  const profile = settings.locator(".profile-section");
  await expect(profile).toContainText("随着学习，我会逐渐了解你。");
  await expect(profile.locator(".profile-updated")).toHaveText("最近更新于 暂无");
  await expect(profile.locator("input, textarea, button, [contenteditable=true]")).toHaveCount(0);
  await expect(profile.getByRole("status")).toHaveCount(0);
});

test("学习画像 displays saved prose and relative session time without editing controls", async ({ page }) => {
  await installFakeAtlas(page);
  await page.addInitScript(() => localStorage.setItem("studyboard-preview-profile-v1", JSON.stringify({
    version: 1, enabled: true, text: "你理解折射，对全反射还不熟悉。", updatedAt: new Date().toISOString(), lastRewriteAt: new Date().toISOString(), pending: [],
  })));
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+.");
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: "学习画像" }).click();
  const profile = settings.locator(".profile-section");
  await expect(profile.locator(".profile-text")).toHaveText("你理解折射，对全反射还不熟悉。");
  await expect(profile.locator(".profile-updated")).toHaveText(/最近更新于 \d{2}:\d{2}/);
  await expect(profile.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(profile.locator("input, textarea, button, [contenteditable=true]")).toHaveCount(0);
  expect(await profile.locator(".profile-updated").evaluate(el => getComputedStyle(el).fontSize)).toBe("12px");
});
