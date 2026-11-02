import { test, expect, type Page } from "@playwright/test";
import { installFakeAtlas } from "./fake-atlas";
import { routedBoard } from "./fixtures";
import { gotoApp } from "./ready";

const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const gates = (page: Page) => page.evaluate(() => (window as any).__atlasGates as any[]);
/** The routed board without the fixture's own child under 第 2 站, so a stuck stop has none yet. */
const bare = () => {
  const b = routedBoard();
  b.nodes = b.nodes.filter((n: any) => n.parentId !== "c-when-not");
  return b;
};
const disk = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("fake-atlas-disk")!)[0]);

async function newQuestion(page: Page, topic: string) {
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: /新的问题/ }).click();
  await page.getByLabel("新白板问题").fill(topic);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
}

// spec-v2 (goal-weights): a new question now opens the chat kickoff (产出物/成功标准/约束 3–5 题),
// not the 摸底 probe, so this entry path is no longer reachable from 新问题. Kept for reference until the
// probe code is either rewired or removed.
test.skip("摸底 v2: brackets the edge without levels or marks; stations below the start get the light seal", async ({ page }) => {
  await installFakeAtlas(page);
  await newQuestion(page, "重疾险有哪些重要条款？");
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
  // MCQ without a reason is graded locally: no mark calls.
  expect((await gates(page)).filter((r) => r.mode === "mark")).toHaveLength(0);
  // The plan is written for this learner, and the map is asked for ladder levels.
  const plan = page.locator(".drawer .plan-editor");
  await expect(plan).toContainText("学完后");
  // Plain prose: no question-type chip (机制/决策/…) anywhere in the probe or plan UI.
  await expect(page.locator(".drawer .plan-kind")).toHaveCount(0);
  await expect(page.locator(".drawer")).not.toContainText(/概念：是什么|机制：如何运作|决策：怎么选|操作：怎么做|学习路径：怎么学|对比：有什么区别/);
  const plans = await page.evaluate(() => (window as any).__atlasPlans);
  expect(plans[0].prompt).toContain("摸底结果：学习者已经懂：「生病了保险给钱」、「给付型 vs 报销型」、「合同结构」。路线从「条款细读」开始");
  await plan.getByRole("button", { name: "确认计划，铺成第一层" }).click();
  await expect(page.locator(".react-flow__node-concept")).toHaveCount(3);
  const first = page.locator(".react-flow__node-concept").first();
  await expect(first.locator(".seal.light")).toHaveCount(1);
  // Without card levels, the 3 stations spread over the 5-point chain (0, 2, 4): two fall before 条款细读.
  await expect(page.locator(".react-flow__node-concept .seal.light")).toHaveCount(2);
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

// spec-v2 (goal-weights): the first wrong answer now promotes the card one weight level and swaps in
// the choice footer (see flow.spec.ts), so the old two-wrong-answers 卡住了 exits are no longer reached.
test.skip("stuck after two wrong answers: three exits; 换个类比 goes back to 学, 往下拆 drafts two children", async ({ page }) => {
  const b = bare();
  Object.assign(b.nodes.find((n: any) => n.id === "c-when-not"), { status: "exploring", beat: "test", fails: 1 });
  await installFakeAtlas(page, true, "web", [b]);
  await page.addInitScript(() => {
    (window as any).__atlasExpansionAnswers = [
      JSON.stringify({
        nodes: [
          { id: "s1", parent: "anchor", title: "观察期从哪天开始算", body: "从合同生效日起算，不是从交钱那天。续保的保单通常不再重新计算。" },
          { id: "s2", parent: "anchor", title: "健康告知没问到的不用说", body: "保险公司只就书面询问的事项要求如实回答，问卷外的情况不构成隐瞒。" },
        ],
        relations: [],
      }),
    ];
  });
  await gotoApp(page);
  const bar = page.getByRole("region", { name: "下一步" });
  await bar.getByRole("button", { name: /开始/ }).click();
  const stop = page.getByRole("region", { name: "这一站" });
  await stop.getByRole("radio", { name: /疾病定义/ }).click();
  await stop.getByRole("button", { name: /提交/ }).click();
  const exits = stop.getByRole("group", { name: "卡住了" });
  await expect(stop).toContainText("没关系，这说明这里藏着更小的概念。");
  await expect(exits.getByRole("button")).toHaveCount(3);
  await expect(exits.getByRole("button").first()).toContainText("推荐");
  // 换个类比: one short call; back to 学 with the analogy shown.
  await exits.getByRole("button", { name: /换个类比/ }).click();
  await expect(stop.locator(".beat.on")).toHaveText("学");
  await expect(stop.locator(".beat-analogy")).toContainText("健身卡");
  expect((await gates(page)).filter((r) => r.mode === "probe")).toHaveLength(1);
  // Stuck again → 往下拆.
  await stop.getByRole("button", { name: /读完了/ }).click();
  await stop.getByLabel("用我的话讲").fill("等待期里确诊一般不赔");
  await stop.getByRole("button", { name: /提交/ }).click();
  for (let i = 0; i < 2; i++) {
    await stop.getByRole("radio", { name: /疾病定义/ }).click();
    await stop.getByRole("button", { name: /提交/ }).click();
  }
  await exits.getByRole("button", { name: /往下拆/ }).click();
  await expect(page.locator(".react-flow__node", { hasText: "观察期从哪天开始算" })).toBeVisible();
  const asks = await page.evaluate(() => (window as any).__atlasAsks);
  expect(asks.at(-1).mode).toBe("expand");
  expect(asks.at(-1).prompt).toContain("只拆出 2 个更小、更基础的子问题");
  await expect
    .poll(async () => (await disk(page)).nodes.filter((n: any) => n.meta?.split).map((n: any) => n.parentId))
    .toEqual(["c-when-not", "c-when-not"]);
  await page.locator(".drawer").getByLabel("关闭").click();
  await expect(bar).toContainText("卡住了，先学拆出来的小问题");
  await expect(bar).toContainText("观察期从哪天开始算");
});

test("稍后 puts the stuck stop off to the end of the route", async ({ page }) => {
  const b = bare();
  Object.assign(b.nodes.find((n: any) => n.id === "c-when-not"), { status: "exploring", beat: "test", fails: 2 });
  await installFakeAtlas(page, true, "web", [b]);
  await gotoApp(page);
  const bar = page.getByRole("region", { name: "下一步" });
  await bar.getByRole("button", { name: /开始/ }).click();
  await page.getByRole("group", { name: "卡住了" }).getByRole("button", { name: /稍后/ }).click();
  await expect(bar).toContainText("下一步 · 第 2 站");
  await expect(bar).not.toContainText("等待期");
  await expect(card(page, "c-when-not").locator(".station")).toHaveText("第 4 站");
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
