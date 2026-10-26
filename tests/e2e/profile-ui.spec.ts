import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installFakeAtlas } from "./fake-atlas";
import { routedBoard } from "./fixtures";
import { gotoApp } from "./ready";
import { newProbe } from "../../src/model/probe";

const INTRO = "我记得你已经懂前面这些，先确认一下";
const TRANSITION = "这题没答上来，我从基础重新摸一下。";
const PROSE =
  "你在保险上已经有不错的基础：重疾险的保费、保额你基本讲得通。等待期和免责期你有时会混着用，讲到这里要多区分一下。你喜欢先看一个具体的例子，再看定义。";
const LONG =
  PROSE +
  "债券价格和利率的反向关系你也很清楚，复利和单利的区别能用自己的话讲出来。票面利率和到期收益率你还不太稳，容易把两者当成同一件事。最好例子里带着真实的数字，对数学推导兴趣不大，点到为止就行。你很在意为什么这样规定，所以讲条款时多讲背后的道理。你习惯一次只学一个点，学完再往下走，不太喜欢一口气看很多内容。机器学习刚入门，Transformer 的注意力机制还没真正理解，先建立直觉更重要。你通常在晚上学习，每次大约二十分钟，我会尽量把每一站控制在这个长度里。你对能不能赔这类实际问题比对条款原文更敏感，我会尽量把条款翻译成这样的问题来讲。";
function confirmationBoard() {
  const board = routedBoard();
  board.probe = newProbe(
    ["保障范围", "保费与保额", "给付与报销", "等待期", "免责条款"].map(
      (desc, level) => ({
        level,
        desc,
        keyPoints: [desc],
        prior: level < 3 ? ("known" as const) : ("none" as const),
        probe: {
          type: "choice" as const,
          q: `小周正在读保险合同，想弄清${desc}，哪种理解能帮他判断？`,
          options: [
            "根据合同约定的保障范围判断",
            "只看广告里的宣传语",
            "保费越贵就一定赔得越多",
          ],
          answer: 0,
        },
      }),
    ),
  );
  return board;
}
async function seedProfile(page: Page, text: string) {
  await page.addInitScript(
    (text) =>
      localStorage.setItem(
        "studyboard-preview-profile-v1",
        JSON.stringify({
          version: 1,
          enabled: true,
          text,
          updatedAt: new Date().toISOString(),
          lastRewriteAt: new Date().toISOString(),
          pending: [],
        }),
      ),
    text,
  );
}
async function openProfile(page: Page) {
  await page.keyboard.press("ControlOrMeta+.");
  await page
    .getByRole("dialog", { name: "设置" })
    .getByRole("button", { name: "学习画像" })
    .click();
}
async function openConfirmation(page: Page) {
  await installFakeAtlas(page, true, "web", [confirmationBoard()]);
  await gotoApp(page);
  await page
    .getByRole("region", { name: "下一步" })
    .getByRole("button", { name: /开始/ })
    .click();
  return page.getByRole("region", { name: "摸底", exact: true });
}

test("confirmation first and second questions, then the direct result", async ({
  page,
}) => {
  const probe = await openConfirmation(page);
  await expect(probe.locator("h3")).toHaveText("确认你的起点");
  await expect(probe.locator(".probe-prog")).toHaveText("确认 1/2");
  await expect(probe.locator(".probe-dots i")).toHaveCount(2);
  await expect(probe.locator(".probe-intro")).toHaveText(INTRO);
  await expect(probe.locator(".probe-head .probe-intro")).toHaveCount(0);
  await expect(probe.getByRole("radio")).toHaveCount(3);
  await expect(
    probe.getByRole("button", { name: "不对，我不懂这个" }),
  ).toBeVisible();
  await expect(
    probe.getByRole("button", { name: "跳过确认，直接开始" }),
  ).toBeVisible();
  await probe.getByRole("radio").first().click();
  await probe.getByRole("button", { name: "确定", exact: true }).click();
  await expect(probe.locator(".probe-prog")).toHaveText("确认 2/2");
  await expect(probe.locator(".probe-intro")).toHaveCount(0);
  await probe.getByRole("radio").first().click();
  await probe.getByRole("button", { name: "确定", exact: true }).click();
  const result = page.getByRole("region", { name: "摸底结果" });
  await expect(result.locator(".probe-k")).toHaveText("已确认 · 2 题");
  await expect(result.locator("h4")).toHaveText(
    "按你的了解，给付与报销你已经懂",
  );
  await expect(result).toContainText(
    "路线从「等待期」开始，前面的只会一笔带过。",
  );
  await expect(
    result.getByRole("button", { name: "从这里开始" }),
  ).toBeVisible();
});

test("declining confirmation enters full probing without treating it as a skip", async ({
  page,
}) => {
  const probe = await openConfirmation(page);
  await probe.getByRole("radio").first().click();
  await probe.getByRole("button", { name: "确定", exact: true }).click();
  await probe.getByRole("radio").nth(1).click();
  await probe.getByRole("button", { name: "跳过确认，直接开始" }).click();
  await expect(probe.locator("h3")).toHaveText("找到你的起点");
  await expect(probe.locator(".probe-prog")).toHaveText("第 1 题");
  await expect(probe.getByRole("radio", { name: "不了解这块" })).toBeVisible();
  await expect(
    probe.getByRole("button", { name: "确定", exact: true }),
  ).toBeDisabled();
  await expect(probe).not.toContainText(TRANSITION);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0].probe,
      ),
    )
    .toMatchObject({ status: "asking", answers: [], meta: { mode: "full" } });
});

for (const exit of ["wrong", "idk"] as const) {
  test(`${exit} confirmation answer shows the transition once and restores full options`, async ({
    page,
  }) => {
    const probe = await openConfirmation(page);
    if (exit === "idk")
      await probe.getByRole("button", { name: "不对，我不懂这个" }).click();
    else {
      await probe.getByRole("radio").nth(1).click();
      await probe.getByRole("button", { name: "确定", exact: true }).click();
    }
    await expect(probe).toContainText(TRANSITION);
    await expect(probe.locator(".probe-prog")).toHaveText("第 1 题");
    await expect(
      probe.getByRole("radio", { name: "不了解这块" }),
    ).toBeVisible();
    await expect(probe.getByRole("button", { name: "跳过摸底" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0].probe.meta,
        ),
      )
      .toMatchObject({ mode: "full", confirmFailedAt: 1 });
    await probe.getByRole("radio").first().click();
    await probe.getByRole("button", { name: "确定", exact: true }).click();
    await expect(page.locator(".probe")).not.toContainText(TRANSITION);
  });
}

test("long profile grows naturally and the settings body scrolls to its footer", async ({
  page,
}) => {
  await installFakeAtlas(page);
  await seedProfile(page, LONG.repeat(3));
  await gotoApp(page);
  await openProfile(page);
  const card = page.locator(".profile-card");
  await expect(card).toHaveCSS("overflow-y", "visible");
  expect(await card.evaluate((el) => el.clientHeight)).toBeGreaterThan(800);
  await card.locator("footer").scrollIntoViewIfNeeded();
  await expect(card.locator("footer time")).toBeVisible();
  expect(
    await page.locator(".settings-body").evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  await expect(card.locator("footer")).toContainText("最近更新于 今天");
});

for (const scheme of ["light", "dark"] as const) {
  test(`profile design screenshots · ${scheme}`, async ({ page }) => {
    const dir = process.env.SHOTS_DIR;
    test.skip(!dir, "set SHOTS_DIR to capture the profile states");
    mkdirSync(dir!, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${dir}/${name}-${scheme}.png` });
    };
    await installFakeAtlas(page, true, "web", [confirmationBoard()]);
    for (const [name, text] of [
      ["profile-page", PROSE],
      ["profile-long", LONG],
      ["profile-empty", ""],
    ]) {
      await seedProfile(page, text);
      await gotoApp(page);
      await openProfile(page);
      await expect(
        page.locator(text ? ".profile-text" : ".profile-empty"),
      ).toBeVisible();
      await shot(name);
    }
    await page.keyboard.press("Escape");
    await shot("next-step-confirm");
    await page
      .getByRole("region", { name: "下一步" })
      .getByRole("button", { name: /开始/ })
      .click();
    const probe = page.getByRole("region", { name: "摸底", exact: true });
    await expect(probe.locator(".probe-intro")).toBeVisible();
    await shot("probe-confirm-first");
    await probe.getByRole("radio").nth(1).click();
    await probe.getByRole("button", { name: "确定", exact: true }).click();
    await expect(probe).toContainText(TRANSITION);
    await shot("probe-after-wrong");
    // Reset only the fake disk; the result screenshot is reached through real UI answers.
    await page.evaluate(
      (board) =>
        localStorage.setItem("fake-atlas-disk", JSON.stringify([board])),
      confirmationBoard(),
    );
    await gotoApp(page);
    await page
      .getByRole("region", { name: "下一步" })
      .getByRole("button", { name: /开始/ })
      .click();
    for (let i = 0; i < 2; i++) {
      await probe.getByRole("radio").first().click();
      await probe.getByRole("button", { name: "确定", exact: true }).click();
    }
    await expect(page.getByRole("region", { name: "摸底结果" })).toBeVisible();
    await shot("probe-confirm-result");
  });
}
