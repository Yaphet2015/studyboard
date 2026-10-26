// Manual sample: build Electron first, source llm-test.env, then run only this file with
// npx vitest run -c scripts/vitest.sample.config.ts scripts/profile.sample.ts
// Uses Electron's system fetch; credentials remain in the child environment.
import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";
import { emptyProfile, rewritePrompt } from "../src/shared/profile";
import { chainPrompt, parsePoints, newProbe } from "../src/model/probe";
import { tutorInstructions } from "../electron/prompts";

it.skipIf(!process.env.LLM_TEST_API_KEY)(
  "samples profile rewriting and prior-aware probing through Electron",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "studyboard-profile-sample-"));
    const profile = {
      ...emptyProfile(),
      text: "你已理解光在均匀介质中沿直线传播、反射定律和折射时光路偏折，对全反射的适用条件还不熟悉。",
    };
    const events = [
      {
        id: "a",
        kind: "test" as const,
        topic: "全反射",
        detail: JSON.stringify({
          title: "全反射的两个必要条件",
          claims: ["光从光密介质射向光疏介质，入射角大于临界角才发生全反射"],
        }),
      },
      {
        id: "b",
        kind: "miss" as const,
        topic: "光学",
        detail: JSON.stringify({
          title: "临界角",
          fails: 2,
          missing: "仍把入射角与界面的夹角当作入射角，而非与法线的夹角",
        }),
      },
    ];
    await writeFile(
      join(dir, "input.json"),
      JSON.stringify({
        rewrite: rewritePrompt(profile, events),
        chain: chainPrompt("光纤为什么能传光", undefined, 5, [], profile),
        system: tutorInstructions("probe"),
      }),
    );
    // Keep this small harness out of the application. AIRuntime performs the real rewrite;
    // cloning its SSE response captures reported usage without changing the transport.
    await writeFile(
      join(dir, "sample.mjs"),
      `
import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { installSystemFetch } from ${JSON.stringify(resolve("dist-electron/electron/system-fetch.js"))};
import { AIRuntime } from ${JSON.stringify(resolve("dist-electron/electron/ai-runtime.js"))};
app.whenReady().then(async () => {
  let runtime;
  try {
    installSystemFetch();
    const input = JSON.parse(await readFile(${JSON.stringify(join(dir, "input.json"))}, 'utf8'));
    const original = globalThis.fetch;
    const reads = [];
    let usage;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      reads.push(response.clone().text().then(body => {
        for (const line of body.split('\\n')) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try { const data = JSON.parse(line.slice(6)); if (data.usage) usage = data.usage; } catch {}
        }
      }));
      return response;
    };
    runtime = new AIRuntime(${JSON.stringify(join(dir, "runtime"))}, () => {});
    await runtime.setSettings({ model: process.env.LLM_TEST_MODEL, baseUrl: process.env.LLM_TEST_BASE_URL, apiKey: process.env.LLM_TEST_API_KEY });
    const text = await runtime.rewriteProfile(input.rewrite);
    await Promise.all(reads);
    const response = await original(process.env.LLM_TEST_BASE_URL.replace(/\\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.LLM_TEST_API_KEY },
      body: JSON.stringify({ model: process.env.LLM_TEST_MODEL, thinking: { type: 'disabled' }, temperature: 0.3, max_tokens: 4000, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.chain }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const chain = await response.json();
    await writeFile(${JSON.stringify(join(dir, "output.json"))}, JSON.stringify({ rewrite: { text, usage }, chain: { text: chain.choices[0].message.content, usage: chain.usage } }));
    await runtime.close();
    app.exit(0);
  } catch { if (runtime) await runtime.close(); console.error('Profile sample failed (provider details withheld)'); app.exit(1); }
});
`,
    );
    try {
      await promisify(execFile)(
        String(electron),
        ["--no-sandbox", join(dir, "sample.mjs")],
        {
          timeout: 240_000,
          env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
        },
      );
      const result = JSON.parse(
        await readFile(join(dir, "output.json"), "utf8"),
      );
      await writeFile("/tmp/studyboard-profile-sample-raw.json", JSON.stringify(result, null, 2));
      expect(result.rewrite.text.length).toBeLessThanOrEqual(500);
      expect(result.rewrite.usage?.completion_tokens_details?.reasoning_tokens ?? 0).toBe(0);
      const parsed = parsePoints(result.chain.text);
      // Match the production chain acceptance threshold; malformed questions are filtered.
      expect(parsed.points.length).toBeGreaterThanOrEqual(3);
      expect(parsed.points.every((p) => p.prior)).toBe(true);
      const report = {
        ...result,
        rewrite: { ...result.rewrite, length: result.rewrite.text.length },
        rawPriorCount: JSON.parse(result.chain.text.slice(result.chain.text.indexOf("{"), result.chain.text.lastIndexOf("}") + 1)).points.filter((p: { prior?: string }) => p.prior).length,
        points: parsed.points.map((p) => ({ concept: p.desc, prior: p.prior })),
        mode: newProbe(parsed.points).meta?.mode,
      };
      await writeFile(
        "/tmp/studyboard-profile-sample.json",
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
