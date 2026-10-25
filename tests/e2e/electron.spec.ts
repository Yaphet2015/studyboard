import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { waitForApp } from "./ready";

test("macOS desktop bridge, edit flush on immediate close, and durable reopening", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin",
    "Actual desktop acceptance runs on macOS.",
  );
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-e2e-"));
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    STUDYBOARD_E2E: "1",
    STUDYBOARD_TEST_USERDATA: directory,
  };
  delete environment.STUDYBOARD_DEV_SERVER;
  delete environment.OPENAI_API_KEY;
  const diagnostics: string[] = [];
  const applications: { app: ElectronApplication; child: ChildProcess }[] = [];
  const pages: Page[] = [];
  async function launch() {
    const app = await electron.launch({
      args: ["."],
      env: environment,
      timeout: 25_000,
    });
    // Playwright disposes its application handle after close(), so retain the
    // actual process while the handle is still valid for later failure cleanup.
    const child = app.process();
    applications.push({ app, child });
    app.on("console", (message) =>
      diagnostics.push(`[main ${message.type()}] ${message.text()}`),
    );
    child.stderr?.on("data", (chunk) =>
      diagnostics.push(`[stderr] ${String(chunk)}`),
    );
    const page = await app.firstWindow();
    pages.push(page);
    page.on("console", (message) =>
      diagnostics.push(`[renderer ${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) =>
      diagnostics.push(`[pageerror] ${error.message}`),
    );
    page.on("close", () => diagnostics.push("[test] native window closed"));
    return { app, page };
  }
  try {
    const { app, page } = await launch();
    await expect(page.locator(".react-flow__node-root h2")).toBeVisible();
    await waitForApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByText(/白板保存在这台 Mac/)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: "test-results/atlas-macos-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "批注", exact: true }).click();
    const nativeWindow = await app.browserWindow(page);
    await page
      .getByLabel("批注标题")
      .fill("Close immediately: this edit must survive.");

    // Trigger the same native close event as the macOS window button. Do not wait
    // for autosave, call destroy(), or force the process to exit for this check.
    const windowClosed = page.waitForEvent("close", { timeout: 15_000 });
    await nativeWindow.evaluate((window) => window.close());
    await windowClosed;

    // Playwright owns a Node inspector connection. Its supported close method
    // disconnects that debugger so a naturally quitting Electron process can exit.
    await app.close();
    const boardDirectory = path.join(directory, "boards");
    const boardFiles = (await readdir(boardDirectory)).filter((file) =>
      file.endsWith(".json"),
    );
    expect(boardFiles).toHaveLength(1);
    const persisted = JSON.parse(
      await readFile(path.join(boardDirectory, boardFiles[0]), "utf8"),
    );
    expect(persisted.notes.at(-1).title).toBe(
      "Close immediately: this edit must survive.",
    );
    // Conversations carry their creation time for the session list.
    expect(persisted.notes.at(-1).createdAt).toMatch(/^\d{4}-\d\d-\d\d/);

    const { app: reopened, page: nextPage } = await launch();
    // Wait for the reopened board and the app's readiness signal (⌘K listener attached).
    await expect(nextPage.locator(".react-flow__node-root h2")).toBeVisible();
    await waitForApp(nextPage);
    // Nothing selected: N goes back to the board's latest conversation.
    await nextPage.keyboard.press("n");
    await expect(nextPage.getByLabel("批注标题")).toHaveValue(
      "Close immediately: this edit must survive.",
    );
    // The reopened board lists and selects that conversation in the sidebar.
    const current = nextPage
      .getByRole("complementary", { name: "学习空间", exact: true })
      .locator('.workspace-session[aria-current="page"]');
    await expect(current).toContainText("Close immediately");
    await expect(current).toHaveAttribute("title", /自由批注/);
    await nextPage.screenshot({
      path: "test-results/atlas-macos-sticky-reopened.png",
      fullPage: true,
    });
    await reopened.close();
  } catch (error) {
    for (const [index, page] of pages.entries()) {
      if (!page.isClosed()) {
        await page
          .screenshot({
            path: testInfo.outputPath(`electron-failure-${index}.png`),
            fullPage: true,
          })
          .catch(() => {});
        await writeFile(
          testInfo.outputPath(`electron-dom-${index}.html`),
          await page.content().catch(() => "Page content unavailable"),
        ).catch(() => {});
      }
    }
    throw error;
  } finally {
    // Failure cleanup is separate from the assertion above and never makes a
    // failed close/reopen check pass. Do not leave the test's own app orphaned.
    try {
      for (const { app, child } of applications) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (
            child.exitCode === null &&
            child.signalCode === null &&
            !child.killed
          ) {
            await Promise.race([
              app.close().catch(() => {}),
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 5000);
              }),
            ]);
            if (
              child.exitCode === null &&
              child.signalCode === null &&
              !child.killed
            )
              child.kill("SIGTERM");
          }
        } catch (error) {
          diagnostics.push(`[cleanup] ${String(error)}`);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    } finally {
      // Diagnostic/cleanup errors must not replace the original test failure.
      await writeFile(
        testInfo.outputPath("electron-diagnostics.txt"),
        diagnostics.join("\n"),
      ).catch((error) =>
        console.warn("Unable to write Electron diagnostics", error),
      );
      await rm(directory, { recursive: true, force: true }).catch((error) =>
        console.warn("Unable to remove temporary Electron test data", error),
      );
    }
  }
});
