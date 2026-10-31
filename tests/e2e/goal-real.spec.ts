/**
 * Opt-in desktop acceptance, with the real preload, AIRuntime, prompts, gate and model.
 * Build first. Source the private env file in the shell; never print its contents.
 * REAL_LLM=1 xvfb-run -a npx playwright test tests/e2e/goal-real.spec.ts --workers=1
 */
import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEmptyBoard } from "../../src/model/boards";
import { sourceLink } from "../../src/shared/card-source";
import type { AIUpdate, Board } from "../../src/shared/types";
import { waitForApp } from "./ready";

// Credentials must never enter Playwright artifacts, including on failure.
test.use({ trace: "off", screenshot: "off", video: "off" });
const shots = resolve(
  process.env.REAL_LLM_SHOTS ?? "/workspace/studyboard-goal/v2/shots-real",
);
const exec = promisify(execFile);
const readBoard = (page: Page, id: string): Promise<Board> =>
  page.evaluate(async (id) => (await window.atlas!.loadBoard(id))!, id);

function answerTo(question: string, turn: number): string {
  if (/经历|经验|买过|亏|基础|知道|了解多少/.test(question))
    return "我只买过货币基金，没经历过股票熊市，知道分散能降低单一资产风险，但不会配置比例或再平衡。应急金已单独留好。";
  if (/约束|预算|资金|金额|多少钱|期限|几年/.test(question))
    return "可投资资金10万元人民币，应急金另存；五年内不用这笔钱，不加杠杆，使用境内能买到的低成本基金，每季度检查。";
  if (/标准|成功|收益|回撤|风险|达标/.test(question))
    return "希望年化收益目标6%，只是愿望不是保证；最大可接受账面回撤15%。成功是交出一份说明资产比例、理由、风险和再平衡规则的方案。";
  if (/产出|拿到|成品|方案|做出|交付/.test(question) || turn === 0)
    return "我想拿到一份适合自己的投资组合书面方案，包含资产比例、选择理由、风险和再平衡规则，不需要具体买卖指令。";
  return "请以这些已确认情况为准：交付资产配置书面方案；本金10万元，应急金另留，五年不用，不加杠杆；年化6%是愿望而非保证，最大可接受回撤15%；只买过货币基金，不会再平衡。";
}

test("real model: portfolio onboarding, route, two stations and a station gap", async () => {
  test.skip(
    process.env.REAL_LLM !== "1",
    "Set REAL_LLM=1 and LLM_TEST_* to call the real model.",
  );
  test.setTimeout(1_800_000);
  if (
    ![
      process.env.LLM_TEST_API_KEY,
      process.env.LLM_TEST_BASE_URL,
      process.env.LLM_TEST_MODEL,
    ].every(Boolean)
  )
    throw new Error(
      "LLM_TEST_API_KEY / LLM_TEST_BASE_URL / LLM_TEST_MODEL are required",
    );
  await mkdir(shots, { recursive: true });
  await mkdir(resolve("test-results"), { recursive: true });
  const directory = await mkdtemp(resolve("test-results/real-goal-"));
  const seed: Board =
    process.env.REAL_LLM_RESUME === "1"
      ? JSON.parse(await readFile(join(shots, "board.json"), "utf8"))
      : createEmptyBoard("构建我的投资组合");
  const gapOnly = process.env.REAL_LLM_GAP_ONLY === "1";
  const previousOutput = gapOnly
    ? await readFile(join(shots, "output.md"), "utf8")
    : "";
  if (gapOnly && seed.route?.length) {
    const first = seed.nodes.find((n) => n.id === seed.route![0])!;
    first.status = "exploring";
    first.beat =
      first.weight === "background"
        ? "learn"
        : first.weight === "core"
          ? "test"
          : "explain";
    delete first.seal;
    if (seed.plan) seed.plan.artifact = [];
    for (const note of seed.notes)
      note.messages = note.messages.filter((m) => !m.meta?.artifact);
  }
  await mkdir(join(directory, "boards"));
  await writeFile(
    join(directory, "boards", `${seed.id}.json`),
    JSON.stringify(seed),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => typeof v[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.STUDYBOARD_DEV_SERVER;
  delete env.OPENAI_API_KEY;
  const app = await electron.launch({
    args: ["--no-sandbox", "."],
    env: { ...env, STUDYBOARD_E2E: "1", STUDYBOARD_TEST_USERDATA: directory },
    timeout: 30_000,
  });
  let page: Page | undefined;
  let board: Board = seed;
  let updates: AIUpdate[] = [];
  const checkpoints: string[] = [];
  try {
    // Keep only redacted HTTP error diagnostics; never retain request headers or keys.
    await app.evaluate(() => {
      const original = globalThis.fetch;
      (globalThis as any).__realHttpErrors = [];
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init);
        if (!response.ok) {
          const data = (await response
            .clone()
            .json()
            .catch(() => ({}))) as any;
          const key = process.env.LLM_TEST_API_KEY;
          const message = String(data.error?.message ?? "");
          (globalThis as any).__realHttpErrors.push({
            status: response.status,
            message: key ? message.replaceAll(key, "[redacted]") : "",
          });
        }
        return response;
      };
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
    await waitForApp(page);
    await page.evaluate(
      async (settings) => {
        await window.atlas!.setAISettings(settings);
      },
      {
        apiKey: process.env.LLM_TEST_API_KEY!,
        baseUrl: process.env.LLM_TEST_BASE_URL!,
        model: process.env.LLM_TEST_MODEL!,
      },
    );
    await page.reload();
    await waitForApp(page);
    await page.evaluate(() => {
      (window as any).__realUpdates = [];
      window.atlas!.onAIUpdate((u) => {
        if (u.status !== "streaming") (window as any).__realUpdates.push(u);
      });
    });
    const drawer = page.locator(".drawer");
    const say = async (text: string) => {
      const before = (await readBoard(page!, seed.id)).notes
        .flatMap((n) => n.messages)
        .filter((m) => m.role === "assistant").length;
      const input = drawer.getByLabel("向 AI 提问");
      await input.fill(text);
      await input.press("ControlOrMeta+Enter");
      await expect
        .poll(
          async () =>
            (await readBoard(page!, seed.id)).notes
              .flatMap((n) => n.messages)
              .filter((m) => m.role === "assistant").length,
          { timeout: 180_000 },
        )
        .toBeGreaterThan(before);
    };
    const snap = async (name: string) => {
      await page!
        .locator("textarea, input")
        .evaluateAll((els) => els.forEach((el) => (el as HTMLElement).blur()));
      await page!.evaluate(() => document.fonts.ready);
      await page!.screenshot({
        path: join(shots, `${name}.png`),
        animations: "disabled",
      });
      checkpoints.push(name);
      console.log(`[real] ${name}`);
    };
    if (!seed.notes.some((n) => n.messages.some((m) => m.meta?.goalSummary))) {
      await page.getByRole("button", { name: /AI 带我开始/ }).click();
      await expect
        .poll(
          async () =>
            (await readBoard(page!, seed.id)).notes
              .flatMap((n) => n.messages)
              .filter((m) => m.role === "assistant").length,
          { timeout: 180_000 },
        )
        .toBeGreaterThan(0);
      for (let turn = 0; turn < 7; turn++) {
        board = await readBoard(page, seed.id);
        if (
          board.notes.some((n) => n.messages.some((m) => m.meta?.goalSummary))
        )
          break;
        const question = board.notes
          .flatMap((n) => n.messages)
          .filter((m) => m.role === "assistant")
          .at(-1)!.text;
        await say(answerTo(question, turn));
      }
    } else {
      await page
        .locator(`.react-flow__node[data-id="${seed.nodes[0].id}"]`)
        .click();
      await page.keyboard.press("/");
    }
    if (!seed.route?.length) {
      await expect(drawer.locator(".goal-summary")).toBeVisible({
        timeout: 180_000,
      });
      await expect(
        drawer.getByRole("button", { name: "开始第 1 站", exact: true }),
      ).toBeEnabled({ timeout: 180_000 });
      await drawer
        .locator(".thread")
        .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await snap("01-onboard");
      await drawer
        .getByRole("button", { name: "开始第 1 站", exact: true })
        .click();
      await expect
        .poll(
          async () => {
            const errors = await page!.evaluate(() =>
              ((window as any).__realUpdates as AIUpdate[]).filter(
                (u) => u.stickyId === "map-root" && u.status === "error",
              ),
            );
            if (errors.length) throw new Error(errors.at(-1)!.error);
            return (await readBoard(page!, seed.id)).route?.length ?? 0;
          },
          { timeout: 240_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } else {
      checkpoints.push("01-onboard");
    }
    board = await readBoard(page, seed.id);
    const stops = board.route!.slice(0, 2);
    const closeDrawer = async () => {
      if (await drawer.isVisible())
        await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    };
    const select = async (id: string) => {
      await closeDrawer();
      await page!
        .getByRole("button", { name: "查看全图", exact: true })
        .click();
      await page!.locator(`.react-flow__node[data-id="${id}"]`).click();
    };
    for (const [index, id] of stops.entries()) {
      if (
        (await readBoard(page, seed.id)).nodes.some((n) => n.parentId === id)
      ) {
        checkpoints.push(`0${index + 2}-stop${index + 1}-cards`);
        continue;
      }
      await select(id);
      const count = (await readBoard(page, seed.id)).nodes.length;
      await page.getByRole("button", { name: "再看一层", exact: true }).click();
      await expect
        .poll(async () => (await readBoard(page!, seed.id)).nodes.length, {
          timeout: 240_000,
        })
        .toBeGreaterThan(count);
      await expect(page.locator(".map-progress")).toHaveCount(0, {
        timeout: 240_000,
      });
      await select(id);
      await page.keyboard.press("/");
      await expect(drawer.locator(".this-card h2")).toHaveText(
        (await readBoard(page, seed.id)).nodes.find((n) => n.id === id)!.title,
      );
      await snap(`0${index + 2}-stop${index + 1}-cards`);
    }
    await select(stops[0]);
    await page.keyboard.press("/");
    board = await readBoard(page, seed.id);
    const first = board.nodes.find((n) => n.id === stops[0])!;
    const footer = drawer.locator(".weight-footer");
    if (first.weight === "background") {
      await footer.getByRole("button", { name: "懂了", exact: true }).click();
    } else if (
      first.weight === "core" &&
      first.meta?.check?.answer !== undefined
    ) {
      await footer
        .locator(".weight-options button")
        .nth(first.meta.check.answer)
        .click();
    } else {
      const answer = `我会按这一点处理自己的组合：${first.body}。这只是配置框架，不能保证收益，缺少实测数据时保留不确定性。`;
      await footer.getByLabel("写下你的猜测").fill(answer);
      await footer.getByRole("button", { name: "提交", exact: true }).click();
    }
    await expect
      .poll(
        async () =>
          (await readBoard(page!, seed.id)).plan?.artifact?.length ?? 0,
        { timeout: 240_000 },
      )
      .toBeGreaterThan(0);
    await expect(drawer.locator("details.artifact-attachment")).toBeVisible();
    await drawer
      .locator(".thread")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await snap("04-gap");
    board = await readBoard(page, seed.id);
    expect(
      board.plan?.artifact?.[0].results?.every((r) =>
        ["measured", "estimated"].includes(r.basis),
      ),
    ).toBe(true);
    for (const n of board.nodes.filter((n) => n.parentId !== null)) {
      if (n.source) expect(sourceLink(n.source)).toBeDefined();
      else expect(n.body).not.toMatch(/\d/);
    }
    const numericCriteria =
      typeof board.plan?.goal === "object"
        ? board.plan.goal.criteria
            .filter((c) => c.target !== undefined)
            .map((c) => c.id)
        : [];
    // This simulated learner supplied goals, never a measured portfolio return/drawdown.
    for (const r of board.plan?.artifact?.flatMap((p) => p.results ?? []) ??
      []) {
      if (numericCriteria.includes(r.id) && r.current !== undefined)
        expect(r.basis).toBe("estimated");
    }
    // Exercise the actual new-window handler without launching a second browser.
    await app.evaluate(({ shell }) => {
      (globalThis as any).__realOpenExternal = shell.openExternal;
      (globalThis as any).__realOpened = [];
      shell.openExternal = async (url) => {
        (globalThis as any).__realOpened.push(url);
      };
    });
    try {
      const reference = board.nodes
        .map((n) => sourceLink(n.source))
        .find(Boolean);
      if (reference) {
        await select(
          board.nodes.find((n) => sourceLink(n.source)?.url === reference.url)!
            .id,
        );
        await page.keyboard.press("/");
        await drawer.locator(".srcl a").first().click();
      } else {
        await page.evaluate(() => {
          window.open("https://www.w3.org/", "_blank");
        });
      }
      expect(
        await app.evaluate(() => (globalThis as any).__realOpened),
      ).toEqual([reference?.url ?? "https://www.w3.org/"]);
      expect(await app.windows()).toHaveLength(1);
    } finally {
      await app.evaluate(({ shell }) => {
        shell.openExternal = (globalThis as any).__realOpenExternal;
      });
    }
    expect(checkpoints).toHaveLength(4);
  } finally {
    if (page && !page.isClosed()) {
      board = await readBoard(page, seed.id).catch(() => board);
      updates = await page
        .evaluate(() => (window as any).__realUpdates ?? [])
        .catch(() => []);
    }
    // Shut down this single browser before checking links or starting any other browser.
    const httpErrors = await app
      .evaluate(() => (globalThis as any).__realHttpErrors ?? [])
      .catch(() => []);
    console.log("[real] HTTP diagnostics:", JSON.stringify(httpErrors));
    await app.close();
    await rm(directory, { recursive: true, force: true });
    let output = `# 真实模型验收：构建我的投资组合\n\n时间：${new Date().toISOString()}\n\n模型：${process.env.LLM_TEST_MODEL}\n\n链路：真实 Electron preload → AIRuntime → pi-ai OpenAI 兼容接口 → 应用解析 / gate → 界面。无模型 mock。\n\n已完成截图：${checkpoints.join("、")}\n\n`;
    output += "## 摸底与路线\n\n";
    const rootId = seed.nodes[0].id;
    for (const m of board.notes.find((n) => n.attachedTo?.id === rootId)
      ?.messages ?? [])
      output += `### ${m.role}\n\n${m.text}\n\n`;
    output += `\n计划原文：\n\n\`\`\`json\n${JSON.stringify(board.plan, null, 2)}\n\`\`\`\n\n`;
    output += "## 实际卡片正文、来源\n\n";
    for (const n of board.nodes.filter((n) => n.id !== rootId))
      output += `### ${n.title}\n\n${n.body}\n\nsource: ${n.source ?? "（无可核对来源，隐藏来源行）"}\n\ndate: ${n.date ?? "无"}；weight: ${n.weight}\n\n${n.questionPrompt ?? ""}\n\n`;
    output += "## 站后差距消息原文\n\n";
    for (const m of board.notes
      .flatMap((n) => n.messages)
      .filter((m) => m.meta?.artifact))
      output += `${m.text}\n\n`;
    output += "## 模型返回原文（含生成、校验与站后评估）\n\n";
    if (previousOutput) {
      output +=
        "前序生成记录保留在 target-echo-attempt.md（旧评估已替换，卡片未重生成）。\n\n";
      const original =
        previousOutput
          .split("## 模型返回原文（含生成、校验与站后评估）")[1]
          ?.split("## 来源 HTTP 检查")[0] ?? "";
      output += original.split("### goal-gap-")[0];
    }
    for (const u of updates)
      output += `### ${u.stickyId} / ${u.status}\n\n\`\`\`text\n${u.text}\n${u.error ?? ""}\n\`\`\`\n\n`;
    const references = new Set(
      board.nodes.flatMap((n) => sourceLink(n.source)?.url ?? []),
    );
    // Include sources in raw responses, even if the generation gate discarded a card.
    for (const u of updates)
      for (const match of u.text.matchAll(/https:\/\/[^\s"<>\\]+/g))
        references.add(match[0]);
    output +=
      "## 来源 HTTP 检查\n\ncurl -sIL --max-time 30（逐条请求；状态仅证明可达性，不等于页面内容支持论断）\n\n";
    if (!references.size)
      output +=
        "模型未提供来源链接：0 条待检查；所有来源行隐藏，卡片采用定性正文。\n\n";
    for (const url of references) {
      try {
        const { stdout } = await exec("curl", [
          "-sIL",
          "--max-time",
          "30",
          "-w",
          "\nFINAL_STATUS=%{http_code}\n",
          url,
        ]);
        const statuses = stdout
          .split(/\r?\n/)
          .filter((s) => /^HTTP\/|^FINAL_STATUS=|^location:/i.test(s));
        output += `- ${url}\n\n\`\`\`text\n${statuses.join("\n")}\n\`\`\`\n\n`;
      } catch (error) {
        const e = error as { code?: number; stdout?: string };
        output += `- ${url}：curl exit ${e.code}；${e.stdout?.match(/FINAL_STATUS=\d+/)?.[0] ?? "无 HTTP 响应"}\n\n`;
      }
    }
    output += `\n## 模型请求 HTTP 错误（已脱敏）\n\n${JSON.stringify(httpErrors)}\n`;
    await writeFile(join(shots, "output.md"), output);
    await writeFile(join(shots, "board.json"), JSON.stringify(board, null, 2));
  }
});
