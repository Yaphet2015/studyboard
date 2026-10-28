import { describe, expect, it } from "vitest";
import {
  editDuration,
  P,
  planAgentEdits,
  sentenceDiff,
  sentences,
} from "../src/model/agent-edit";
import type { Board } from "../src/shared/types";
import { insuranceBoard } from "./e2e/fixtures";
const board = () => insuranceBoard(true) as Board;

describe("agent edit presentation", () => {
  it("splits Chinese/English endings and newlines losslessly", () => {
    const text = "你好。Really?!是的！\n下一句？Last.尾巴";
    expect(sentences(text).map((s) => s.text)).toEqual([
      "你好。",
      "Really?!",
      "是的！",
      "\n",
      "下一句？",
      "Last.",
      "尾巴",
    ]);
    expect(
      sentences(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
  it.each([
    ["相同。旧句。结尾。", "相同。新句。结尾。", ["相同。", "结尾。"]],
    ["甲。乙。", "甲。插入。乙。", ["甲。", "乙。"]],
    ["甲。删除。乙。", "甲。乙。", ["甲。", "乙。"]],
    ["重复。重复。尾。", "重复。尾。", ["重复。", "尾。"]],
    ["", "新句。", []],
    ["旧句。", "", []],
  ])("diff %s → %s", (a, b, same) => {
    const diff = sentenceDiff(a, b);
    expect(
      diff
        .flatMap((c) => c.old)
        .map((s) => s.text)
        .join(""),
    ).toBe(a);
    expect(
      diff
        .flatMap((c) => c.next)
        .map((s) => s.text)
        .join(""),
    ).toBe(b);
    expect(
      diff.filter((c) => c.old[0] === c.next[0]).map((c) => c.old[0].text),
    ).toEqual(same);
  });
  it("gives consecutive changed sentences separate sweep triggers", () => {
    const diff = sentenceDiff("旧一。旧二。没改。", "新一。新二。没改。");
    expect(diff.map((c) => c.old.map((s) => s.text).join(""))).toEqual([
      "旧一。",
      "旧二。",
      "没改。",
    ]);
  });
  it("sorts by canvas y then x, staggers and caps the wash at eight", () => {
    const a = board();
    a.nodes = Array.from({ length: 10 }, (_, i) => ({
      ...a.nodes[1],
      id: `c${i}`,
    }));
    const b = { ...a, nodes: a.nodes.map((n) => ({ ...n, body: "新正文。" })) };
    const pos = new Map(
      a.nodes.map((n, i) => [n.id, { x: i % 2, y: Math.floor((9 - i) / 2) }]),
    );
    const edits = [...planAgentEdits(a, b, pos, true, false, 100).entries()];
    expect(edits.map(([id]) => id)).toEqual([
      "c8",
      "c9",
      "c6",
      "c7",
      "c4",
      "c5",
      "c2",
      "c3",
      "c0",
      "c1",
    ]);
    expect(edits.slice(0, 8).map(([, e]) => e.start)).toEqual(
      Array.from({ length: 8 }, (_, i) => 100 + 400 + 150 * i),
    );
    expect(
      edits.slice(8).map(([, e]) => [e.sweep, e.start, editDuration(e)]),
    ).toEqual([
      [false, 100, 120],
      [false, 100, 120],
    ]);
  });
  it("only animates existing, nonempty bodies changed by Agent; never creation or user edit/undo/import", () => {
    const a = board(),
      b = structuredClone(a);
    b.nodes[1].body = "改写。";
    b.nodes.push({ ...b.nodes[1], id: "new" });
    expect([...planAgentEdits(a, b, new Map(), true, false, 0).keys()]).toEqual(
      [a.nodes[1].id],
    );
    expect(planAgentEdits(a, b, new Map(), false, false, 0).size).toBe(0);
    expect(planAgentEdits(a, a, new Map(), true, false, 0).size).toBe(0);
  });
  it("reduced motion bypasses sweep and swaps at 120ms, holds 600ms then fades for 400ms", () => {
    const a = board(),
      b = structuredClone(a);
    b.nodes[1].body = "新正文。";
    const e = [...planAgentEdits(a, b, new Map(), true, true, 0).values()][0];
    expect(e.reduced).toBe(true);
    expect(editDuration(e)).toBe(1000);
    expect(P.direct).toBe(120);
  });
});
