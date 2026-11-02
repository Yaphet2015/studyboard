import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { gotoApp, reloadApp } from "./ready";
import { fixtureGoal, goalBoard } from "../goal-fixtures";
import { createEmptyBoard } from "../../src/model/boards";

// Review screenshots; CI has no /workspace, so default into test-results unless GOAL_SHOTS is set.
const shots = process.env.GOAL_SHOTS ?? "test-results/goal-weights-shots";
const card = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const disk = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0]);
const tail = (data: unknown) => `\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
async function say(page: Page, text: string) {
  const input = page.locator(".drawer").getByLabel("向 AI 提问");
  await input.fill(text);
  await input.press("ControlOrMeta+Enter");
}
async function queue(page: Page, replies: string[]) {
  await page.evaluate((replies) => {
    (window as any).__atlasChatAnswers = replies;
  }, replies);
}
async function theme(page: Page, mode: "light" | "dark") {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: mode });
}
async function screenshot(page: Page, name: string) {
  await page
    .locator("textarea")
    .evaluateAll((els) => els.forEach((el) => el.blur()));
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: `${shots}/${name}.png`,
    animations: "disabled",
  });
}
async function openCore(page: Page) {
  await card(page, "goal-core").click();
  await page.keyboard.press("/");
  await expect(page.locator(".drawer .goal-pin")).toContainText(
    fixtureGoal.deliverable,
  );
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: sources, progress dots and all three card footers`, async ({
    page,
  }) => {
    const b = goalBoard();
    // An extra background card demonstrates 懂了 while station 1 retains a hollow read dot.
    b.nodes.push({
      ...b.nodes[1],
      id: "goal-bg-unread",
      title: "先核对素材用途",
      parentId: "goal-bg",
      order: 0,
      status: "unseen",
      beat: undefined,
      seal: undefined,
    });
    await theme(page, mode);
    await installFakeAtlas(page, true, "web", [b]);
    await gotoApp(page);
    await expect(
      card(page, "goal-bg").locator(".station-dot.read"),
    ).toHaveCount(1);
    await expect(
      card(page, "goal-core").locator(".station-dot.read"),
    ).toHaveCount(1);
    await expect(card(page, "goal-hard").locator(".station-dot")).toHaveCount(
      0,
    );
    await expect(card(page, "goal-core").locator(".srcl")).toHaveText(
      "W3C · 截至 2026-10",
    );
    await expect(card(page, "goal-core").locator(".srcl a")).toHaveAttribute(
      "href", "https://www.w3.org/WAI/tutorials/images/",
    );
    await expect(
      card(page, "goal-bg-unread").getByRole("button", {
        name: "懂了",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      card(page, "goal-core").locator(".weight-options button"),
    ).toHaveCount(2);
    await expect(
      card(page, "goal-hard").getByLabel("写下你的猜测"),
    ).toBeVisible();
    await expect(card(page, "goal-bg")).not.toContainText("已掌握");
    await expect(card(page, "goal-bg")).toContainText("读过");
    await expect(card(page, "goal-hard").getByLabel("写下你的猜测")).toHaveAttribute("placeholder", "你觉得呢？");
    await screenshot(page, `01-canvas-${mode}`);
    await card(page, "goal-bg-unread")
      .getByRole("button", { name: "懂了", exact: true })
      .click();
    await expect(card(page, "goal-bg-unread")).toContainText("读过");
    const weights = goalBoard();
    weights.id = b.id;
    weights.nodes[1].status = "unseen";
    delete weights.nodes[1].beat;
    delete weights.nodes[1].seal;
    await page.evaluate((b) => window.atlas!.saveBoard(b), weights);
    await reloadApp(page);
    await expect(
      card(page, "goal-bg").getByRole("button", { name: "懂了", exact: true }),
    ).toBeVisible();
    await screenshot(page, `04-weights-${mode}`);
  });

  test(`${mode}: goal pin, goal edit, wrong answer promotion and hard answer in Agent`, async ({
    page,
  }) => {
    await theme(page, mode);
    await installFakeAtlas(page, true, "web", [goalBoard()]);
    await gotoApp(page);
    await openCore(page);
    await screenshot(page, `01-agent-${mode}`);
    const changed = { ...fixtureGoal, deliverable: "可读的作品集交付单" };
    await queue(page, ["目标已记下。" + tail({ goal: changed })]);
    await say(page, "改目标：产出物改成可读的作品集交付单");
    await expect(page.locator(".goal-pin")).toContainText(changed.deliverable);
    await expect
      .poll(async () => (await disk(page)).plan?.goal.deliverable)
      .toBe(changed.deliverable);
    await expect(
      card(page, "goal-core").locator('.weight-footer[data-weight="core"]'),
    ).toHaveCount(1);
    await page
      .locator(".drawer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const hard = card(page, "goal-hard");
    await page.evaluate(() => {
      (window as any).__atlasMarkAnswers = [
        JSON.stringify({ pass: false, missing: "说明用途" }),
      ];
    });
    await hard.getByLabel("写下你的猜测").fill("读者只能看到文件名");
    await hard.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.locator(".drawer .thread")).toContainText("说明用途");
    await expect(page.locator(".drawer .thread")).toContainText(
      "读者只能看到文件名",
    );
    await expect(page.locator(".drawer")).not.toContainText(
      /第 \d 拍|一站 4 拍/,
    );
  });

  test(`${mode}: station completion calculates gap, focus applies, artifact expands only on the latest message`, async ({
    page,
  }) => {
    await theme(page, mode);
    await installFakeAtlas(page, true, "web", [goalBoard()]);
    await gotoApp(page);
    await page.evaluate(() => {
      (window as any).__atlasMarkAnswers = [
        JSON.stringify({
          part: {
            stopId: "goal-core",
            title: "图片说明",
            content: "已根据用途补齐说明，评分估算为 84 分，尚需实测。",
          },
          results: [{ id: "access", current: 84, basis: "estimated", evidence: "按已完成的图片说明检查项推算，尚未实测评分" }],
          suggestion: "建议下一站优先检查图片无法加载时的作品意图。",
          focus: "补齐剩余 6 分对应的说明",
        }),
      ];
    });
    await card(page, "goal-core")
      .getByRole("button", { name: "按图片用途补充说明", exact: true })
      .click();
    const drawer = page.locator(".drawer");
    await expect(drawer.locator(".chat b")).toContainText("还差 6分");
    await expect(drawer.locator(".chat b")).toContainText("估算，依据：");
    await expect(drawer.locator(".route-diff .focus")).toContainText(
      "补齐剩余 6 分",
    );
    await expect(drawer.locator(".route-diff .focus .rd-old")).toHaveCount(0);
    const attachment = drawer.locator("details.artifact-attachment");
    await expect(attachment).toHaveAttribute("open", "");
    await expect(attachment).toContainText("我的产出物 · 2/3 块");
    await expect(attachment).toContainText("刚填入");
    await drawer
      .locator(".thread")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await screenshot(page, `02-gap-${mode}`);
    await drawer
      .getByRole("group", { name: "路线改动" })
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(drawer).toContainText("已改路线");
    await expect
      .poll(async () => (await disk(page)).plan.artifact.length)
      .toBe(2);
    await attachment.locator("summary").click();
    await expect(attachment).not.toHaveAttribute("open");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "查看全图", exact: true }).click();
    await page.evaluate(() => {
      (window as any).__atlasMarkAnswers = [
        JSON.stringify({ pass: true, missing: "" }),
        JSON.stringify({
          part: {
            stopId: "goal-hard",
            title: "验收结果",
            content: "缺图时文字仍能说明作品意图。",
          },
          results: [{ id: "access", current: 95, basis: "measured", evidence: "用户提供的验收评分" }],
          suggestion: "按清单交付。",
        }),
      ];
    });
    await card(page, "goal-hard")
      .getByLabel("写下你的猜测")
      .fill("用文字说明作品的用途");
    await card(page, "goal-hard")
      .getByRole("button", { name: "提交", exact: true })
      .click();
    await expect(drawer.locator(".chat")).toContainText([
      "讲清楚了。",
      "已达到标准",
    ]);
    await expect(drawer.getByRole("group", { name: "路线改动" })).toHaveCount(
      0,
    );
    await expect(drawer.locator("details.artifact-attachment")).toHaveAttribute(
      "open",
      "",
    );
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "查看全图", exact: true }).click();
    await openCore(page);
    await expect(
      drawer.locator("details.artifact-attachment"),
    ).not.toHaveAttribute("open");
  });

  test(`${mode}: ordinary onboarding chips collect a goal and start station 1`, async ({
    page,
  }) => {
    const board = createEmptyBoard("怎样交付作品集？");
    await theme(page, mode);
    await installFakeAtlas(page, true, "web", [board]);
    await gotoApp(page);
    await queue(page, [
      "做完以后，你想拿到什么？" +
        tail({ chips: ["一份上线清单", "一套检查规则"] }),
      "怎样算成功？",
      "有哪些期限和素材约束？",
      "以前交付时遇到过什么？",
      "记下了，路线会逐块帮你完成清单。" +
        tail({ goal: fixtureGoal, ready: true }),
    ]);
    await page.evaluate(() => {
      (window as any).__atlasMapAnswers = [
        JSON.stringify({
          nodes: ["核对范围", "补充图片说明", "验收交付"].map((title, i) => ({
            id: `gmap${i}`,
            title,
            body: [
              "交付范围记录页面名称、负责人和素材清单，避免验收时漏掉页面。",
              "图片的文字说明表达作品用途；装饰图片应避免让读屏器重复朗读。",
              "逐一按 Tab 键移动焦点，确认导航和提交按钮均能通过键盘操作。",
            ][i],
            parent: "anchor",
            block: `g${i}`,
            weight: "background",
            source: "W3C https://www.w3.org/WAI/tutorials/images/",
            date: "2026-10",
          })),
          relations: [],
        }),
      ];
      (window as any).__atlasPlanAnswers = [
        JSON.stringify({
          intent: "howto",
          goal: { deliverable: "作品集上线清单" },
          learner: "第一次交付",
          blocks: ["范围", "图片说明", "验收"].map((title, i) => ({
            id: `g${i}`,
            title,
            why: "补齐交付清单",
            parent: null,
            prerequisites: [],
            core: true,
          })),
          outOfScope: [],
        }),
      ];
    });
    await page.getByRole("button", { name: /AI 带我开始/ }).click();
    await page
      .locator(".drawer")
      .getByRole("button", { name: "一份上线清单", exact: true })
      .click();
    await expect(page.locator(".drawer")).toContainText("怎样算成功");
    await say(page, "可访问性评分至少 90");
    await expect(page.locator(".drawer")).toContainText("期限和素材约束");
    await say(page, "本月底，沿用现有素材");
    await expect(page.locator(".drawer")).toContainText("以前交付");
    await say(page, "图片缺少说明返工过");
    const drawer = page.locator(".drawer");
    await expect(drawer.locator(".goal-summary")).toContainText(
      fixtureGoal.experience,
    );
    await expect(
      drawer.getByRole("button", { name: "开始第 1 站", exact: true }),
    ).toBeEnabled();
    await drawer
      .locator(".thread")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await screenshot(page, `03-onboard-${mode}`);
    await drawer
      .getByRole("button", { name: "开始第 1 站", exact: true })
      .click();
    await expect(page.locator(".react-flow__node-concept")).toHaveCount(3);
    await expect(drawer.locator(".this-card")).toContainText("第 1 站");
    await expect
      .poll(async () => (await disk(page)).plan?.goal)
      .toEqual(fixtureGoal);
  });
}

test("wrong core choice promotes exactly once; background questions add a choice footer", async ({
  page,
}) => {
  await installFakeAtlas(page, true, "web", [goalBoard()]);
  await gotoApp(page);
  await card(page, "goal-core")
    .getByRole("button", { name: "所有图片使用相同说明", exact: true })
    .click();
  await expect(
    card(page, "goal-core").locator('.weight-footer[data-weight="hard"]'),
  ).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (await disk(page)).nodes.find((n: any) => n.id === "goal-core").fails,
    )
    .toBe(1);
  await page
    .locator(".drawer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await card(page, "goal-bg").click();
  await page.keyboard.press("/");
  await queue(page, ["我们把范围再核对一下。"]);
  await say(page, "这张卡的范围怎么确认？");
  await expect(
    card(page, "goal-bg").locator(
      '.weight-footer[data-weight="core"] .weight-options button',
    ),
  ).toHaveCount(2);
});

// Seal spec A: 摸底「已会」shows as an outlined stamp, a quieter card and one 复习一下 footer.
for (const mode of ["light", "dark"] as const) {
  test(`${mode}: 摸底已会 stamp beside 读过/掌握, and a reviewed background card counts as mastered`, async ({ page }) => {
    const b = goalBoard();
    const base = b.nodes[1];
    const known = { ...base, id: "goal-known", title: "先认清交付对象", order: -1, seal: "probe" as const, status: "explained" as const, beat: "done" as const, weight: "core" as const };
    const kid = (id: string, title: string, weight: "background" | "core") => ({ ...base, id, title, parentId: "goal-known", order: 0, status: "unseen" as const, beat: undefined, seal: undefined, weight });
    b.nodes.push(known, kid("goal-known-bg", "背景：什么是交付", "background"), kid("goal-known-core", "核心：验收清单", "core"));
    b.route = ["goal-known", ...b.route!];
    await theme(page, mode);
    await installFakeAtlas(page, true, "web", [b]);
    await gotoApp(page);
    // Station 1 and both cards under it inherit 已会; station 2 keeps its 读过 dot, nothing else.
    await expect(page.locator(".card .known-mark")).toHaveCount(3);
    await expect(card(page, "goal-known").locator(".station")).toContainText("已会· 第 1 站");
    await expect(card(page, "goal-known").getByRole("img", { name: "你已经会了（摸底推断），可跳过或复习" })).toBeVisible();
    await expect(card(page, "goal-known")).toContainText("可跳过");
    await expect(card(page, "goal-known").locator(".weight-options")).toHaveCount(0);
    await expect(card(page, "goal-bg").locator(".station-dot.read")).toHaveCount(1);
    await expect(page.locator(".progress")).toContainText("已会 3");
    await screenshot(page, `seal-route-${mode}`);
    // 复习一下 restores the card's own footer; a background 懂了 after 摸底 counts as mastery.
    await card(page, "goal-known-bg").getByRole("button", { name: "复习一下" }).click();
    await card(page, "goal-known-bg").getByRole("button", { name: "懂了", exact: true }).click();
    await expect(card(page, "goal-known-bg")).toContainText("已掌握");
    await expect(card(page, "goal-known-bg").locator(".known-mark")).toHaveCount(0);
    await expect.poll(async () => (await disk(page)).nodes.find((n: any) => n.id === "goal-known-bg").seal).toBe("probe-reviewed");
    await expect(page.locator(".progress")).toContainText("已会 2");
    await screenshot(page, `seal-reviewed-${mode}`);
  });
}

// Seal spec A: a miss on a 已会 card fades the mark out over 240ms; reduced motion drops it at once.
for (const motion of ["no-preference", "reduce"] as const) {
  test(`revoked 已会 mark fades out (${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const b = goalBoard();
    const core = b.nodes.find((n: any) => n.id === "goal-core")!;
    Object.assign(core, { seal: "probe", status: "unseen", beat: undefined });
    await installFakeAtlas(page, true, "web", [b]);
    await gotoApp(page);
    await expect(card(page, "goal-core").locator(".known-mark")).toHaveCount(1);
    await card(page, "goal-core").getByRole("button", { name: "复习一下" }).click();
    await card(page, "goal-core").getByRole("button", { name: "所有图片使用相同说明", exact: true }).click();
    await expect.poll(async () => (await disk(page)).nodes.find((n: any) => n.id === "goal-core").seal).toBe("probe-revoked");
    if (motion === "reduce") await expect(card(page, "goal-core").locator(".known-mark.leaving")).toHaveCount(0);
    await expect(card(page, "goal-core").locator(".known-mark")).toHaveCount(0);
    await expect(card(page, "goal-core")).not.toHaveClass(/known-out/);
  });
}
