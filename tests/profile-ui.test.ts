import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProbePanel, type ProbeProps } from "../src/components/ProbePanel";
import {
  answerProbe,
  leaveConfirmation,
  MAX_QUESTIONS,
  newProbe,
  nextStep,
  settle,
} from "../src/model/probe";
import { nextStep as boardNextStep } from "../src/model/next-step";
import { createEmptyBoard } from "../src/model/boards";
import { probeStateSchema } from "../src/shared/validation";
import type { LadderLevel, ProbeState } from "../src/shared/types";

const chain: LadderLevel[] = [
  "保障范围",
  "保费",
  "保额",
  "等待期",
  "免责条款",
].map((desc, level) => ({
  level,
  desc,
  prior: level < 3 ? "known" : "none",
  keyPoints: [desc],
  probe: {
    type: "choice",
    q: `小周投保后遇到了关于${desc}的问题，该怎么处理？`,
    options: ["正确选项", "错误选项", "另一选项"],
    answer: 0,
  },
}));
const panel = (state: ProbeState, props: Partial<ProbeProps> = {}) =>
  renderToStaticMarkup(
    createElement(ProbePanel, {
      state,
      busy: false,
      phase: null,
      topic: "保险",
      stations: 3,
      onAnswer() {},
      onSkip() {},
      ...props,
    }),
  );

describe("confirmation presentation", () => {
  it("uses two progress segments, the first-question opening and confirmation exits", () => {
    const s = newProbe(chain);
    const html = panel(s);
    expect(html).toContain("确认 1/2");
    expect(html.match(/<i /g)).toHaveLength(2);
    expect(html).toContain("我记得你已经懂前面这些，先确认一下");
    expect(html).toContain("不对，我不懂这个");
    expect(html).toContain("跳过确认，直接开始");
    expect(html).not.toContain("不了解这块");
    expect(
      panel({
        ...s,
        meta: { ...s.meta!, confirmIntro: "你在保险上有一些基础。" },
      }),
    ).toContain("你在保险上有一些基础。");
    const second = panel(answerProbe(s, { verdict: "correct" }));
    expect(second).toContain("确认 2/2");
    expect(second).not.toContain("我记得你已经懂前面这些");
  });
  it("declining confirmation clears answers and starts the ordinary full probe", () => {
    const s = leaveConfirmation(
      answerProbe(newProbe(chain), { verdict: "correct" }),
    );
    expect(s.meta?.mode).toBe("full");
    expect(s.answers).toEqual([]);
    expect(nextStep(s)).toEqual(
      nextStep(newProbe(chain.map((p) => ({ ...p, prior: "none" })))),
    );
    expect(probeStateSchema.parse(s)).toEqual(s);
    expect(panel(s)).toContain("跳过摸底");
    expect(panel(s)).toContain("不了解这块");
  });
  it.each(["wrong", "unsure"] as const)(
    "a %s answer persists the transition marker for only the first full question",
    (verdict) => {
      const failed = answerProbe(newProbe(chain), { verdict });
      expect(failed.meta).toMatchObject({ mode: "full", confirmFailedAt: 1 });
      expect(probeStateSchema.parse(failed)).toEqual(failed);
      expect(panel(failed)).toContain("这题没答上来，我从基础重新摸一下。");
      expect(panel(failed)).toContain("第 1 题");
      const next = answerProbe(failed, { verdict: "correct" });
      expect(panel(next)).not.toContain("这题没答上来");
      expect(panel(next)).not.toContain("按你的了解");
    },
  );
  it("marks the first full question even when the second confirmation fails", () => {
    const failed = answerProbe(
      answerProbe(newProbe(chain), { verdict: "correct" }),
      { verdict: "wrong" },
    );
    expect(failed.meta?.confirmFailedAt).toBe(2);
    expect(panel(failed)).toContain("第 1 题");
    expect(panel(failed)).toContain("这题没答上来");
  });
  it("finishes immediately after two correct answers with profile-voiced result copy", () => {
    const s = answerProbe(
      answerProbe(newProbe(chain), { verdict: "correct" }),
      { verdict: "correct" },
    );
    expect(s.status).toBe("done");
    expect(s.answers).toHaveLength(2);
    const html = panel(s);
    expect(html).toContain("已确认 · 2 题");
    expect(html).toContain("按你的了解，保额你已经懂");
    expect(html).toContain("路线从「等待期」开始，前面的只会一笔带过。");
    expect(html).not.toContain("你已经懂到");
    expect(panel({ ...s, meta: { ...s.meta!, mode: "full" } })).toContain(
      "你已经懂到",
    );
  });
  it("counts confirmation answers toward the ten-question full-probe cap", () => {
    const failed = answerProbe(newProbe(chain), { verdict: "wrong" });
    const atCap = settle({
      ...failed,
      answers: [
        ...failed.answers,
        ...Array.from({ length: MAX_QUESTIONS - 1 }, () => ({
          level: 0,
          pointId: "p0",
          verdict: "correct" as const,
        })),
      ],
    });
    expect(atCap.answers).toHaveLength(10);
    expect(atCap.status).toBe("done");
    expect(atCap.meta?.stopReason).toBe("cap");
  });
  it("changes the next-step explanation only for confirmation", () => {
    const board = createEmptyBoard("保险");
    for (const mode of ["confirm", "partial", "full"] as const) {
      const probe = newProbe(chain);
      probe.meta!.mode = mode;
      expect(boardNextStep({ ...board, probe })).toEqual({
        kind: "probe",
        why:
          mode === "confirm"
            ? "我记得你的一些基础，先确认 1–2 个点就开始。"
            : "先用约 3 道题找到你的起点，路线会从那里开始。",
      });
    }
  });
});
