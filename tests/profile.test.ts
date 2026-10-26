import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "../electron/profile-store";
import {
  boardEvidence,
  emptyProfile,
  enqueueEvidence,
  PENDING_LIMIT,
  profileText,
  rewritePrompt,
  shouldRewrite,
  type ProfileEvent,
} from "../src/shared/profile";
import { createEmptyBoard } from "../src/model/boards";
import {
  answerProbe,
  chainPrompt,
  newProbe,
  nextStep,
  parsePoints,
  probeBrief,
  probeLearner,
} from "../src/model/probe";
import { chatPrompt } from "../src/model/chat";
import { expandPrompt } from "../src/model/expand";
import { planPrompt } from "../src/model/plan";
import { regeneratePrompt } from "../src/model/novelty";
import { setLearnerProfile } from "../src/model/profile-context";
import { probeStateSchema } from "../src/shared/validation";
import type { LadderLevel } from "../src/shared/types";

const event = (
  id = "one",
  kind: ProfileEvent["kind"] = "test",
): ProfileEvent => ({ id, kind, topic: "折射", detail: "测试通过" });
const profile = () => ({
  ...emptyProfile(),
  text: "你理解折射，对全反射还不熟悉。",
});
const chain = (known: number): LadderLevel[] =>
  Array.from({ length: 5 }, (_, i) => ({
    level: i,
    id: `p${i}`,
    desc: `概念${i}`,
    keyPoints: [`要点${i}`],
    prior: i < known ? "known" : "shaky",
    probe: {
      type: "choice",
      q: "小明把一根筷子放进透明水杯里，从侧面观察发现水下部分看起来偏移了，这是为什么呢？",
      options: [
        "光在水和空气的边界改变方向",
        "筷子在水里变弯了",
        "水把筷子的颜色改变了",
      ],
      answer: 0,
    },
  }));
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "profile-test-"));
  setLearnerProfile(emptyProfile());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  setLearnerProfile(emptyProfile());
});

it("queues evidence, deduplicates and keeps a bounded latest queue", () => {
  const p = enqueueEvidence(emptyProfile(), [
    event(),
    event(),
    ...Array.from({ length: PENDING_LIMIT + 3 }, (_, i) => event(String(i))),
  ]);
  expect(p.pending).toHaveLength(PENDING_LIMIT);
  expect(p.pending[0].id).toBe("3");
  expect(enqueueEvidence(p, [event("4")]).pending).toHaveLength(PENDING_LIMIT);
  const changed = enqueueEvidence(p, [
    { ...event("4"), detail: "新的判题结果" },
  ]);
  expect(changed.pending.at(-1)?.id).toBe("4");
});
it("rewrites immediately after a probe, at 30 events, and only at startup after >7 days", () => {
  const now = Date.now();
  const p = {
    ...emptyProfile(),
    pending: [event()],
    lastRewriteAt: new Date(now - 7 * 86400000).toISOString(),
  };
  expect(shouldRewrite(p, "probe", now)).toBe(true);
  expect(shouldRewrite(p, "queue", now)).toBe(false);
  expect(shouldRewrite(p, "startup", now)).toBe(false);
  expect(shouldRewrite(p, "startup", now + 1)).toBe(true);
  const many = enqueueEvidence(
    p,
    Array.from({ length: 29 }, (_, i) => event(String(i))),
  );
  expect(shouldRewrite(many, "queue", now)).toBe(true);
  expect(shouldRewrite({ ...many, enabled: false }, "probe", now)).toBe(false);
  expect(shouldRewrite(emptyProfile(), "startup", now)).toBe(false);
});
it("observes only learning signals and never infers mastery from a probe seal or edits", () => {
  const b = createEmptyBoard("折射");
  b.nodes.push({
    ...b.nodes[0],
    id: "card",
    parentId: b.nodes[0].id,
    seal: "probe",
    status: "explained",
  });
  expect(boardEvidence(b)).toEqual([]);
  const tested = structuredClone(b);
  tested.nodes[1] = {
    ...tested.nodes[1],
    seal: "test",
    meta: { gate: { claims: ["光会折射"] } },
  };
  expect(boardEvidence(tested, b)).toMatchObject([
    { kind: "test", detail: expect.stringContaining("光会折射") },
  ]);
  expect(boardEvidence(tested, tested)).toEqual([]);
  const missed = structuredClone(b);
  missed.nodes[1] = {
    ...missed.nodes[1],
    seal: undefined,
    status: "exploring",
    fails: 2,
    meta: { missed: "方向" },
  };
  expect(boardEvidence(missed, b).map((e) => e.kind)).toEqual(["miss"]);
  const recovered = structuredClone(missed);
  recovered.nodes[1] = { ...recovered.nodes[1], fails: 0, status: "explained", seal: "test" };
  expect(boardEvidence(recovered, missed).map((e) => e.kind)).toEqual(["test"]);
  missed.nodes[1] = {
    ...missed.nodes[1],
    beat: "learn",
    fails: 0,
    meta: undefined,
  };
  expect(boardEvidence(missed, b).map((e) => e.kind)).toEqual(["recheck"]);
  missed.wrap = { text: "总结", lit: ["card"], done: true };
  expect(boardEvidence(missed, b).map((e) => e.kind)).toContain("wrap");
  missed.probe = {
    ...newProbe(chain(0)),
    status: "done",
    answers: [{ level: 0, verdict: "wrong", missing: "方向" }],
  };
  expect(
    boardEvidence(missed, b).find((e) => e.kind === "probe")?.detail,
  ).toContain("方向");
  const asking = {
    ...missed,
    probe: { ...missed.probe!, status: "asking" as const },
  };
  expect(
    boardEvidence(missed, asking).filter((e) => e.kind === "probe"),
  ).toHaveLength(1);
});

it("backs up a corrupt file, rebuilds safely and uses private atomic files", async () => {
  const file = join(dir, "profile.json");
  await writeFile(file, '{"version":88}');
  const backfill = vi.fn(async () => []);
  const store = new ProfileStore(file, vi.fn());
  await store.initialize(backfill);
  expect(await store.get()).toEqual(emptyProfile());
  expect(backfill).not.toHaveBeenCalled();
  const backup = (await readdir(dir)).find((f) =>
    f.startsWith("profile.json.corrupt-"),
  )!;
  expect(await readFile(join(dir, backup), "utf8")).toBe('{"version":88}');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
});
it("backfills once, persists pending and silently retains old prose on model failure", async () => {
  const b = createEmptyBoard("折射");
  b.nodes[0] = { ...b.nodes[0], seal: "test", status: "explained" };
  const backfill = vi.fn(async () => [b]);
  const fail = vi.fn(async () => {
    throw new Error("offline");
  });
  const file = join(dir, "profile.json");
  const store = new ProfileStore(file, fail);
  await store.initialize(backfill);
  await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
  expect((await store.get()).pending).toHaveLength(1);
  const next = new ProfileStore(file, fail);
  await next.initialize(backfill);
  expect(backfill).toHaveBeenCalledOnce();
  expect((await next.get()).text).toBe("");
  await writeFile(
    file,
    JSON.stringify({ ...profile(), pending: [event("probe", "probe")] }),
  );
  const old = new ProfileStore(file, fail);
  await old.initialize(backfill);
  await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(3));
  expect((await old.get()).text).toBe(profile().text);
  expect((await old.get()).pending).toHaveLength(1);
});
it("commits one successful batch while retaining events arriving during the call", async () => {
  let resolve!: (text: string) => void;
  const rewrite = vi.fn(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  const store = new ProfileStore(join(dir, "profile.json"), rewrite);
  await store.initialize(async () => []);
  await store.enqueue([event("first", "probe")]);
  expect(rewrite).toHaveBeenCalledOnce();
  await store.enqueue([event("second")]);
  expect((await store.get()).pending).toHaveLength(2);
  resolve("你已理解折射的基本规律。");
  await vi.waitFor(async () =>
    expect((await store.get()).text).toBe("你已理解折射的基本规律。"),
  );
  const p = await store.get();
  expect(p.pending.map((e) => e.id)).toEqual(["second"]);
  expect(p.updatedAt).toEqual(p.lastRewriteAt);
});
it("keeps pending and text when the model returns empty or overlong prose", async () => {
  for (const result of [
    "",
    "字".repeat(501),
    "- 你理解折射",
    "你理解折射。\n你需要更多练习。",
    '{"text":"你理解折射"}',
  ]) {
    const file = join(dir, `profile-${result.length}.json`);
    await writeFile(file, JSON.stringify(profile()));
    const rewrite = vi.fn(async () => result);
    const store = new ProfileStore(file, rewrite);
    await store.initialize(async () => []);
    await store.enqueue([event("p", "probe")]);
    await vi.waitFor(() => expect(rewrite).toHaveBeenCalledOnce());
    expect((await store.get()).text).toBe(profile().text);
    expect((await store.get()).pending).toHaveLength(1);
  }
});

it("injects full prose only when enabled and nonempty, with board results taking priority", () => {
  const p = profile();
  expect(profileText({ ...p, enabled: false })).toBe("");
  expect(profileText(emptyProfile())).toBe("");
  const b = createEmptyBoard("折射");
  b.probe = { ...newProbe(chain(0)), status: "done", frontier: 1 };
  const brief = probeBrief(b, p);
  expect(brief.indexOf("摸底结果")).toBeLessThan(brief.indexOf(p.text));
  expect(brief).toContain("摸底结果优先");
  expect(probeLearner(b.probe, { ...p, enabled: false })).not.toContain(p.text);
  setLearnerProfile(p);
  expect(chainPrompt(b.topic)).toContain(p.text);
  expect(chainPrompt(b.topic)).toContain("prior: known|shaky|none");
  expect(chatPrompt(b, undefined, "解释一下")).toContain(p.text);
  expect(planPrompt(b.topic, [], brief)).toContain(p.text);
  expect(planPrompt(b.topic, [], brief)).not.toContain("按初学者处理");
  expect(expandPrompt(b, b.nodes[0].id)).toContain(p.text);
  expect(regeneratePrompt(`补充卡片\n${profileText(p)}`, [], b)).not.toContain(
    p.text,
  );
  setLearnerProfile({ ...p, enabled: false });
  expect(chainPrompt(b.topic)).not.toContain(p.text);
  expect(chatPrompt(b, undefined, "解释一下")).not.toContain(p.text);
  expect(rewritePrompt(p)).toContain("不编造");
});
describe("prior-based probing", () => {
  it("defaults to the existing full machine without priors", () => {
    const s = newProbe(chain(0));
    expect(s.meta?.mode).toBe("full");
    expect(nextStep(s)).toMatchObject({ kind: "ask", index: 1 });
  });
  it("asks the first point beyond the known prefix in partial mode", () => {
    const s = newProbe(chain(2));
    expect(s.meta?.mode).toBe("partial");
    expect(nextStep(s)).toMatchObject({ kind: "ask", index: 2 });
    expect(probeStateSchema.safeParse(s).success).toBe(true);
  });
  it("confirms with two questions and starts at the first non-known point", () => {
    let s = newProbe(chain(3));
    expect(s.meta?.mode).toBe("confirm");
    expect(nextStep(s)).toMatchObject({ kind: "ask", index: 1 });
    s = answerProbe(s, { verdict: "correct" });
    expect(nextStep(s)).toMatchObject({ kind: "ask", index: 2 });
    s = answerProbe(s, { verdict: "correct" });
    expect(s.status).toBe("done");
    expect(s.frontier).toBe(3);
    expect(s.answers).toHaveLength(2);
  });
  it("a failed confirmation drops prior assumptions and returns to full bisection", () => {
    const s = answerProbe(newProbe(chain(4)), {
      verdict: "wrong",
      missing: "边界",
    });
    expect(s.meta?.mode).toBe("full");
    expect(s.status).toBe("asking");
    expect(nextStep(s)).toMatchObject({ kind: "ask", index: 0 });
  });
  it("confirmation after one success still falls back when the second answer is unsure", () => {
    let s = answerProbe(newProbe(chain(3)), { verdict: "correct" });
    s = answerProbe(s, { verdict: "unsure" });
    expect(s.meta?.mode).toBe("full");
    expect(s.status).toBe("asking");
    expect(nextStep(s).kind).not.toBe("done");
  });
  it("parses priors and leaves absent or invalid values unknown", () => {
    const p = chain(1)[0];
    const raw = (prior: string | undefined) => ({
      concept: p.desc,
      keyPoints: p.keyPoints,
      prior,
      probe: p.probe,
    });
    expect(
      parsePoints(
        JSON.stringify({
          points: [raw("known"), raw("invented"), raw(undefined)],
        }),
      )?.points.map((p) => p.prior),
    ).toEqual(["known", "none", "none"]);
  });
});
