import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { routedBoard } from "./fixtures";
import { gotoApp } from "./ready";

const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const gates = (page: Page) => page.evaluate(() => (window as any).__atlasGates as any[]);
const disk = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0]);

async function newQuestion(page: Page, topic: string) {
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill(topic);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
}

// New question: 摸底 first, then the goal questions (spec-v2 kickoff), then the plan/route.
test("摸底 v2: brackets the edge without levels or marks, then goal questions, then the route; stations below the start get the light seal", async ({ page }) => {
  await installFakeAtlas(page);
  await gotoApp(page);
  await page.evaluate(() => { (window as any).__atlasChatAnswers = [
    '摸底完成。做完以后，你想拿到什么？\n```json\n{"chips":["一份投保核对清单"]}\n```',
    '记下了，路线会帮你做出这份清单。\n```json\n{"goal":{"deliverable":"一份投保核对清单","criteria":[{"id":"check","label":"能逐条核对合同条款"}],"constraints":[]},"ready":true}\n```',
  ]; });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill("重疾险有哪些重要条款？");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const probe = page.locator(".drawer").getByRole("region", { name: "摸底" });
  // No levels, scores or right/wrong marks: just 第 n 题 + dots and 正在找你的起点.
  await expect(probe).toContainText("第 1 题");
  await expect(probe).toContainText("正在找你的起点");
  await expect(probe.locator(".probe-dots i")).not.toHaveCount(0);
  await expect(probe).not.toContainText(/L\d|✓|✗/);
  // Starts at the second point (not the intro); options end with a dashed 不了解这块.
  await expect(probe).toContainText("给付型 vs 报销型");
  await expect(probe.getByRole("radio").last()).toHaveText("不了解这块");
  await expect(probe.locator(".opt.idk")).toHaveCount(1);
  const confirm = probe.getByRole("button", { name: "确定" });
  await expect(confirm).toBeDisabled();
  const pick = async (re: RegExp) => {
    await probe.getByRole("radio", { name: re }).click();
    await probe.getByRole("button", { name: "确定" }).click();
  };
  await pick(/核对合同/); // p1 ✓ → p3
  await expect(probe).toContainText("条款细读");
  await expect(probe).toContainText("第 2 题");
  await pick(/凭常识/); // p3 ✗ → p2
  await expect(probe).toContainText("最可能卡在哪一条");
  await pick(/等待期/); // p2 ✓ → refine (adjacent) → confirm deeper at p4
  await expect(probe).toContainText("产品取舍");
  await pick(/凭常识/); // p4 ✗ → precise
  await expect(probe).toContainText("你已经懂到");
  await expect(probe).toContainText("合同结构");
  await expect(probe).toContainText("从「条款细读」开始，正好在你会的上面一层。");
  await expect(probe.locator(".probe-known li")).toHaveCount(3);
  // Then the goal questions (not the plan yet): no plan request before the goal is ready.
  const drawerEl = page.locator(".drawer");
  await expect(drawerEl).toContainText("你想拿到什么？");
  expect(await page.evaluate(() => (window as any).__atlasPlans?.length ?? 0)).toBe(0);
  await drawerEl.getByRole("button", { name: "一份投保核对清单", exact: true }).click();
  // MCQ without a reason is graded locally: no mark calls.
  expect((await gates(page)).filter((r) => r.mode === "mark")).toHaveLength(0);
  // After the goal is ready, the plan is written for this learner and goal; the route starts from the drawer.
  const start = page.locator(".drawer").getByRole("button", { name: "开始第 1 站", exact: true });
  await expect(start).toBeEnabled();
  // Plain prose: no question-type chip (机制/决策/…) anywhere in the probe or plan UI.
  await expect(page.locator(".drawer .plan-kind")).toHaveCount(0);
  await expect(page.locator(".drawer")).not.toContainText(/概念：是什么|机制：如何运作|决策：怎么选|操作：怎么做|学习路径：怎么学|对比：有什么区别/);
  const plans = await page.evaluate(() => (window as any).__atlasPlans);
  expect(plans[0].prompt).toContain("一份投保核对清单");
  expect(plans[0].prompt).toContain("摸底结果：学习者已经懂：「生病了保险给钱」、「给付型 vs 报销型」、「合同结构」。路线从「条款细读」开始");
  await start.click();
  await expect(page.locator(".react-flow__node-concept")).toHaveCount(3);
  // Without card levels, the 3 stations spread over the 5-point chain (0, 2, 4): two fall before 条款细读
  // and get the probe seal. (Weighted AI stations show 读过/掌握 dots instead of the light stamp.)
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!).find((b: any) => b.probe)?.nodes.filter((n: any) => n.seal === "probe").length))
    .toBe(2);
  // …and those two stations show the outlined 已会 stamp in place of the 读过/掌握 dot.
  await expect(page.locator(".card .station .known-mark")).toHaveCount(2);
  await expect(page.locator(".progress .bar i.s-known")).toHaveCount(2);
  await page.locator(".drawer").getByLabel("关闭").click();
  const bar = page.getByRole("region", { name: "下一步" });
  await expect(bar).toContainText("下一步 · 第 3 站");
  // 重新摸底 lives only in the canvas ⋯ menu (first item), not the drawer or the root card.
  await page.locator(".react-flow__node-root").click();
  await expect(page.locator(".select-toolbar").getByRole("button", { name: "更多操作" })).toHaveCount(0);
  const openDrawer = page.locator(".drawer");
  if (await openDrawer.count()) await openDrawer.getByLabel("关闭").click();
  await page.getByRole("button", { name: "画布操作" }).click();
  await expect(page.locator(".canvas-menu [role=menuitem]").first()).toHaveText("重新摸底");
  await expect(page.getByRole("menuitem", { name: "重新摸底" })).toBeEnabled();
  await page.keyboard.press("Escape");
  // 我想从头学: the light seals go, the route starts at 第 1 站.
  await page.locator(".react-flow__node-root").click();
  await page.keyboard.press("n");
  const drawer = page.locator(".drawer");
  await expect(drawer.getByRole("region", { name: "摸底" })).toContainText("共 3 站");
  await drawer.getByRole("button", { name: "我想从头学" }).click();
  await expect(page.locator(".seal.light")).toHaveCount(0);
  await expect(page.locator(".card .known-mark")).toHaveCount(0);
  await drawer.getByLabel("关闭").click();
  await expect(bar).toContainText("下一步 · 第 1 站");
});

test("a light-sealed stop can be rechecked; failing it removes the seal and queues it next", async ({ page }) => {
  const b = routedBoard();
  const what = b.nodes.find((n: any) => n.id === "c-what");
  Object.assign(what, {
    seal: "probe",
    check: { q: "医疗费全报销了，重疾险还赔吗？", options: ["不赔", "照样赔", "只赔一半"] },
    meta: { check: { keyPoints: ["给付型与报销无关"], answer: 1 } },
  });
  await installFakeAtlas(page, true, "web", [b]);
  await gotoApp(page);
  await expect(card(page, "c-what").locator(".seal.light")).toHaveCount(1);
  await card(page, "c-what").click();
  await page.keyboard.press("n");
  const stop = page.getByRole("region", { name: "这一站" });
  await expect(stop).toContainText("你已经会了 · 可跳过");
  await stop.getByRole("button", { name: "复查一下" }).click();
  await stop.getByRole("radio", { name: /不赔/ }).click();
  await stop.getByRole("button", { name: /提交/ }).click();
  await expect(page.getByText(/这一站排在下一步之后/)).toBeVisible();
  await expect
    .poll(async () => {
      const d = await disk(page);
      return [d.nodes.find((n: any) => n.id === "c-what").seal ?? "none", d.route.join(",")];
    })
    .toEqual(["none", "c-when-not,c-what,c-how,c-money"]);
});

test("合起来讲: with every stop sealed, the root asks for the wrap-up; the stations it reaches light up", async ({ page }) => {
  const b = routedBoard();
  for (const n of b.nodes) if (n.parentId && n.parentId !== null) Object.assign(n, { status: "explained", seal: "test", beat: "done" });
  await installFakeAtlas(page, true, "web", [b]);
  await gotoApp(page);
  const bar = page.getByRole("region", { name: "下一步" });
  await expect(bar).toContainText("★ 下一步 · 收尾");
  await bar.getByRole("button", { name: /开始讲/ }).click();
  const wrap = page.getByRole("region", { name: "合起来讲" });
  await expect(wrap).toContainText("不看卡片，用 5 句话回答起点问题");
  await wrap.getByLabel("合起来讲").fill("先看保哪些病。再看等待期。然后看怎么赔。最后看保额和保费。");
  await expect(wrap).toContainText("4 句");
  await wrap.getByRole("button", { name: /讲完了/ }).click();
  await expect(wrap).toContainText("全图讲通了");
  await expect(page.locator(".card.lit")).toHaveCount(4);
  const mark = (await gates(page)).filter((r) => r.mode === "mark").at(-1);
  expect(mark.prompt).not.toContain("SECRET-KEYPOINT");
  await page.locator(".drawer").getByLabel("关闭").click();
  await expect(bar).toContainText("全部讲清楚了");
});
