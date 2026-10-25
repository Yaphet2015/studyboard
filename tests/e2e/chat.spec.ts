import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { chatBoard } from "./fixtures";
import { gotoApp } from "./ready";

// v2 part 1: after 摸底, every message is one ordinary chat call; at most one proposal per answer.
const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const disk = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0]);
const asks = (page: Page) => page.evaluate(() => (window as any).__atlasAsks as any[]);
const reply = (page: Page, ...texts: string[]) =>
  page.evaluate((t) => ((window as any).__atlasChatAnswers = t), texts);
const proposal = (p: unknown) => "\n```json\n" + JSON.stringify({ proposal: p }) + "\n```";

async function openChat(page: Page) {
  await installFakeAtlas(page, true, "web", [chatBoard()]);
  await gotoApp(page);
  await page.locator(".react-flow__node-root").click();
  await page.keyboard.press("/");
  return page.locator(".drawer");
}
async function say(page: Page, text: string) {
  const box = page.locator(".drawer").getByLabel("向 AI 提问");
  await box.fill(text);
  await box.press("Enter");
}
const stationTitles = (page: Page) =>
  page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0];
    return b.route.map((id: string) => b.nodes.find((n: any) => n.id === id)?.title);
  });

test("1 · a replace shows a diff and a dashed 待替换 card; 应用 renames stop 3, 撤销 restores it", async ({ page }) => {
  const drawer = await openChat(page);
  const cards = await page.locator(".react-flow__node").count();
  await reply(page, "可以把第 3 站换成讲等待期里最容易踩的坑。" + proposal({ type: "editRoute", ops: [{ op: "replace", stop: 3, title: "等待期里最容易踩的坑" }] }));
  await say(page, "第三站太浅了，换成讲等待期的坑");
  const diff = drawer.getByRole("group", { name: "路线改动" });
  await expect(diff.locator(".rd-old")).toHaveText("3 · 等待期与观察期");
  await expect(diff.locator(".rd-new")).toHaveText("3 · 等待期里最容易踩的坑");
  await expect(drawer.locator(".msg.chat").first()).not.toContainText("proposal");
  // Before 应用: the canvas is unchanged apart from the dashed highlight.
  await expect(card(page, "c-how").locator(".card.pv-replace")).toHaveCount(1);
  await expect(card(page, "c-how").locator(".pv-tag")).toHaveText("待替换");
  expect(await page.locator(".react-flow__node").count()).toBe(cards);
  // The canvas card and the saved board keep the old stop title until 应用.
  await expect(card(page, "c-how")).toContainText("等待期与观察期");
  await expect(card(page, "c-how")).not.toContainText("等待期里最容易踩的坑");
  await page.waitForTimeout(600);
  expect((await stationTitles(page))[2]).toBe("等待期与观察期");
  expect((await asks(page)).at(-1)).toMatchObject({ mode: "chat", canvas: false });
  await expect(drawer.getByLabel("向 AI 提问")).toHaveAttribute("placeholder", "继续说…");
  await diff.getByRole("button", { name: "应用" }).click();
  await expect(diff).toContainText("已改路线");
  await expect.poll(() => stationTitles(page)).toEqual(["保费豁免条款", "保额怎么定才够", "等待期里最容易踩的坑", "重疾、中症、轻症的赔付比例"]);
  expect(await page.locator(".react-flow__node").count()).toBe(cards);
  await expect(card(page, "c-how").locator(".card.pv-replace")).toHaveCount(0);
  await expect(card(page, "c-how")).toContainText("等待期里最容易踩的坑");
  await expect(card(page, "c-how")).not.toContainText("等待期与观察期");
  await diff.getByRole("button", { name: /撤销/ }).click();
  await expect(diff).toContainText("已撤销");
  await expect.poll(() => stationTitles(page)).toEqual(["保费豁免条款", "保额怎么定才够", "等待期与观察期", "重疾、中症、轻症的赔付比例"]);
});

test("2 · a question gets a plain answer, no proposal and no canvas change; 存成批注卡 adds a note", async ({ page }) => {
  const drawer = await openChat(page);
  const before = await disk(page);
  await say(page, "等待期是什么？");
  const turn = drawer.locator(".msg.chat");
  await expect(turn).toContainText("等待期是合同生效后");
  await expect(drawer.getByRole("group", { name: "路线改动" })).toHaveCount(0);
  await expect(drawer.getByLabel("向 AI 提问")).toHaveAttribute("placeholder", "继续问…");
  expect((await disk(page)).nodes).toEqual(before.nodes);
  await expect.poll(async () => (await disk(page)).notes.length).toBe(1);
  await turn.getByRole("button", { name: "存成批注卡" }).click();
  await expect(turn).toContainText("已存成批注卡");
  await expect.poll(async () => (await disk(page)).notes.length).toBe(2);
  const saved = (await disk(page)).notes.at(-1);
  expect(saved.text).toContain("问：等待期是什么？");
  expect((await asks(page)).every((r: any) => !r.canvas)).toBe(true);
});

test("3 · 「好，开始吧」 after a startStop equals its button: stop 2 starts, no extra call", async ({ page }) => {
  const drawer = await openChat(page);
  await reply(page, "第 1 站你已经讲通了，下一站看保额。" + proposal({ type: "startStop", stop: 2 }));
  await say(page, "继续往下走");
  await expect(drawer.getByRole("button", { name: "开始第 2 站 · 保额怎么定才够" })).toBeVisible();
  await expect(drawer.getByLabel("向 AI 提问")).toHaveAttribute("placeholder", "或者先问点别的…");
  const calls = (await asks(page)).length;
  await say(page, "好，开始吧");
  await expect(page.getByRole("region", { name: "这一站" })).toBeVisible();
  await expect(page.locator(".drawer h2")).toHaveText("保额怎么定才够");
  expect((await asks(page)).length).toBe(calls);
  await expect.poll(async () => (await disk(page)).nodes.find((n: any) => n.id === "c-when-not").beat).toBe("guess");
});

test("5 · bad JSON or an out-of-range stop shows only the text", async ({ page }) => {
  const drawer = await openChat(page);
  await reply(page, '我想改一下路线。\n```json\n{"proposal":{"type":"editRoute","ops":[{"op":"remo', "删掉它。" + proposal({ type: "editRoute", ops: [{ op: "remove", stop: 9 }] }));
  await say(page, "改一下路线");
  await expect(drawer.locator(".msg.chat").nth(0)).toHaveText(/我想改一下路线。/);
  await say(page, "删掉第 9 站");
  await expect(drawer.locator(".msg.chat").nth(1)).toContainText("删掉它。");
  await expect(drawer.getByRole("group", { name: "路线改动" })).toHaveCount(0);
  await expect(drawer).not.toContainText("```");
  await expect(drawer).not.toContainText("proposal");
});

test("6 · removing a sealed stop: struck with no number, an archive note, 撤销 brings it back", async ({ page }) => {
  const drawer = await openChat(page);
  await reply(page, "可以先去掉第 1 站。" + proposal({ type: "editRoute", ops: [{ op: "remove", stop: 1 }] }));
  await say(page, "第 1 站不要了");
  const diff = drawer.getByRole("group", { name: "路线改动" });
  await expect(diff).toContainText("已讲通，会归档");
  await expect(card(page, "c-what").locator(".card.pv-remove")).toHaveCount(1);
  await expect(card(page, "c-what").locator(".station")).toHaveCount(0);
  await diff.getByRole("button", { name: "应用" }).click();
  await expect(card(page, "c-what")).toHaveCount(0);
  await expect.poll(async () => (await disk(page)).cardArchives?.some((a: any) => a.node.id === "c-what")).toBe(true);
  await diff.getByRole("button", { name: /撤销/ }).click();
  await expect(card(page, "c-what")).toHaveCount(1);
  await expect.poll(() => stationTitles(page)).toEqual(["保费豁免条款", "保额怎么定才够", "等待期与观察期", "重疾、中症、轻症的赔付比例"]);
});

test("7 · no mode switch, no internal fields; talking on expires an unhandled proposal", async ({ page }) => {
  const drawer = await openChat(page);
  await reply(page, "可以把第 4 站挪到第 3 站前面。" + proposal({ type: "editRoute", ops: [{ op: "move", stop: 4, to: 3 }] }));
  await say(page, "先讲赔付比例");
  const diff = drawer.getByRole("group", { name: "路线改动" });
  await expect(diff).toContainText("从第 4 站移来");
  for (const word of ["editRoute", "startStop", "op", "ops", "模式"]) await expect(drawer.locator(".thread")).not.toContainText(new RegExp(`\\b${word}\\b|${word === "模式" ? word : "$^"}`));
  await say(page, "算了，等待期是什么？");
  await expect(diff).toContainText("已过期");
  await expect(diff.getByRole("button", { name: "应用" })).toHaveCount(0);
});

test("8 · 选中一张卡说「下一层按每个 Skill 拆」: reExpand diff, 应用 replaces its children, 撤销 restores them", async ({ page }) => {
  await installFakeAtlas(page, true, "web", [chatBoard()]);
  await gotoApp(page);
  await card(page, "c-what").click();
  await page.keyboard.press("/");
  const drawer = page.locator(".drawer");
  const kids = () => disk(page).then((b) => b.nodes.filter((n: any) => n.parentId === "c-what").map((n: any) => n.title));
  expect(await kids()).toEqual(["重疾、中症、轻症怎么分"]);
  const skills = [
    ["病种定义怎么读", "每种病在合同附表里有一条定义，先看定义里的诊断标准和手术名称，再谈赔不赔。"],
    ["重疾与中症的界线", "同一种病，按分期或手术范围，分别落进重疾或中症，赔付比例随之不同。"],
    ["轻症赔付与保费豁免", "确诊轻症时，多数产品免交之后的保费，合同继续有效，但轻症赔付不占重疾保额。"],
    ["多次赔付的间隔期", "第二次赔付要隔一段时间，且必须是不同病种或新发病，否则不赔。"],
    ["特定人群的额外给付", "少儿和老人有的产品会额外多赔，条件写在特别约定里，要逐条核对年龄与病种。"],
  ];
  await page.evaluate((s) => {
    (window as any).__atlasExpansionAnswers = [
      JSON.stringify({ nodes: s.map(([title, body], i) => ({ id: `sk${i}`, parent: "anchor", title, body })), relations: [] }),
    ];
  }, skills);
  await reply(
    page,
    "可以，我把「保费豁免条款」的下一层重做成一个 Skill 一张卡。" +
      proposal({ type: "reExpand", stop: "保费豁免条款", instruction: "下一层按每个 Skill 拆成一张卡" }),
  );
  await say(page, "下一层直接按每个 Skills 拆，一个 Skill 一张卡");
  // The turn knew which card was selected and what sat under it.
  const prompt = String((await asks(page)).at(-1).prompt);
  expect(prompt).toContain("保费豁免条款");
  expect(prompt).toContain("重疾、中症、轻症怎么分");
  const diff = drawer.getByRole("group", { name: "重做下层" });
  await expect(diff).toContainText("替换 1 张子卡");
  await expect(card(page, "c-tiers").locator(".card.pv-replace")).toHaveCount(1);
  // Nothing moved yet.
  expect(await kids()).toEqual(["重疾、中症、轻症怎么分"]);
  await diff.getByRole("button", { name: "应用" }).click();
  await expect(diff).toContainText("已重做下层");
  await expect.poll(kids).toEqual(skills.map(([t]) => t));
  const after = await disk(page);
  expect(after.cardArchives.some((a: any) => a.node.id === "c-tiers")).toBe(true);
  expect(after.nodes.some((n: any) => n.id === "c-tiers")).toBe(false);
  await diff.getByRole("button", { name: /撤销/ }).click();
  await expect(diff).toContainText("已撤销");
  await expect.poll(kids).toEqual(["重疾、中症、轻症怎么分"]);
});
