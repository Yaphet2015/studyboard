import { describe, expect, it } from "vitest";
import { createEmptyBoard, buildMapFromAI } from "../src/model/boards";
import { layoutTree } from "../src/model/layout";
import { cardReview } from "../src/model/card-review";
import {
  overviewFrontier,
  overviewLabels,
  overviewOpacity,
  overviewRegions,
  overviewSignature,
  overviewSummary,
} from "../src/model/overview";
import { boardSchema } from "../src/shared/validation";
import type { Board, ConceptNode } from "../src/shared/types";

function tree(depth = 3): Board {
  const board = createEmptyBoard("浏览器怎样渲染页面");
  board.nodes[0].id = "root";
  function children(parent: string, level: number): void {
    if (level > depth) return;
    for (let order = 0; order < 2; order++) {
      const id = `${parent}-${order}`;
      board.nodes.push({
        id,
        kind: "concept",
        title: `主题${id}`,
        body: `这是${id}的解释。还有细节。`,
        parentId: parent,
        order,
        status: "unseen",
      });
      children(id, level + 1);
    }
  }
  children("root", 1);
  return board;
}

describe("zoom overview cache", () => {
  it("reads old boards and uses local text immediately", () => {
    const board = tree();
    expect(boardSchema.parse(board)).toEqual({ ...board, nodes: board.nodes.map(n => ({ ...n, weight: n.weight ?? "background" })) });
    expect(overviewSummary(board, "root-0")).toBe("这是root-0的解释。");
    board.nodes.find((node) => node.id === "root-0")!.body = "";
    expect(overviewSummary(board, "root-0")).toContain("主题root-0-0");
  });

  it("invalidates summaries for subtree content and structure, but not learning status or viewport", () => {
    const board = tree();
    const parent = board.nodes.find((node) => node.id === "root-0")!;
    parent.overview = {
      summary: "内容、样式共同构成页面。",
      sig: overviewSignature(board, parent.id),
    };
    expect(overviewSummary(board, parent.id)).toBe(parent.overview.summary);
    board.viewport = { x: 10, y: 20, zoom: 0.3 };
    parent.status = "explained";
    parent.hand = "我的笔记";
    expect(overviewSummary(board, parent.id)).toBe(parent.overview.summary);
    const leaf = board.nodes.find((node) => node.id === "root-0-0")!;
    for (const patch of [
      { body: "已修改" },
      { title: "新标题" },
      { parentId: "root-1" },
      { order: 1 },
      { visual: { kind: "parts", labels: ["甲", "乙"], basis: "literal" } },
    ]) {
      const changed = {
        ...board,
        nodes: board.nodes.map((node) =>
          node.id === leaf.id ? ({ ...node, ...patch } as ConceptNode) : node,
        ),
      };
      expect(overviewSignature(changed, parent.id)).not.toBe(
        parent.overview.sig,
      );
    }
    expect(
      boardSchema.parse(board).nodes.find((node) => node.id === parent.id)
        ?.overview,
    ).toEqual(parent.overview);
  });

  const response = () => ({
    nodes: [
      { id: "new", title: "新细节", body: "新细节的解释", parent: "anchor" },
    ],
    relations: [],
    overviews: [
      { id: "anchor", summary: "主题包含已有概念和新细节。" },
      { id: "new", summary: "新细节的一句话概览。" },
    ],
  });

  it("maps new ids and caches summaries from the same card generation", () => {
    const board = tree(1);
    const next = buildMapFromAI(
      JSON.stringify(response()),
      board,
      "root-0",
      "expand",
      {
        topic: board.topic,
        references: [],
        summary: "",
        review: cardReview(board, ["root-0"]),
      },
    );
    const added = next.nodes.find((node) => node.title === "新细节")!;
    expect(added.id).not.toBe("new");
    expect(overviewSummary(next, added.id)).toBe("新细节的一句话概览。");
    expect(overviewSummary(next, "root-0")).toBe("主题包含已有概念和新细节。");
    expect(boardSchema.safeParse(next).success).toBe(true);
  });

  it("keeps cards when optional summaries are malformed", () => {
    const board = tree(1);
    const next = buildMapFromAI(
      JSON.stringify({
        ...response(),
        overviews: [{ id: "anchor", summary: "<script>bad</script>" }],
      }),
      board,
      "root-0",
      "expand",
    );
    expect(next.nodes).toHaveLength(board.nodes.length + 1);
    expect(next.nodes.every((node) => !node.overview)).toBe(true);
  });

  it("rejects stale, excluded and incomplete summary sources", () => {
    const original = tree(6);
    const context = {
      topic: original.topic,
      references: [],
      summary: "",
      review: cardReview(original, ["root"]),
    };
    const incomplete = buildMapFromAI(
      JSON.stringify(response()),
      original,
      "root",
      "expand",
      context,
    );
    expect(incomplete.nodes[0].overview).toBeUndefined();
    const small = tree(2);
    const review = cardReview(small, ["root"]);
    const edited = {
      ...small,
      nodes: small.nodes.map((node) =>
        node.id === "root-0" ? { ...node, body: "编辑后的内容" } : node,
      ),
    };
    const stale = buildMapFromAI(
      JSON.stringify(response()),
      edited,
      "root",
      "expand",
      { ...context, review },
    );
    expect(stale.nodes.every((node) => !node.overview)).toBe(true);
    const excluded = buildMapFromAI(
      JSON.stringify(response()),
      small,
      "root",
      "expand",
      { ...context, review: cardReview(small, ["root"], ["node:root-0"]) },
    );
    expect(excluded.nodes[0].overview).toBeUndefined();
    const removed = {
      ...small,
      nodes: small.nodes.filter((node) => node.id !== "root-0-0"),
    };
    const removedResult = buildMapFromAI(
      JSON.stringify(response()),
      removed,
      "root",
      "expand",
      { ...context, review },
    );
    expect(removedResult.nodes.every((node) => !node.overview)).toBe(true);
  });

  it("can refresh summaries without adding cards", () => {
    const board = tree(1);
    const next = buildMapFromAI(
      JSON.stringify({
        nodes: [],
        relations: [],
        overviews: [{ id: "anchor", summary: "已有主题的概览。" }],
      }),
      board,
      "root-0",
      "expand",
    );
    expect(next.nodes).toHaveLength(board.nodes.length);
    expect(overviewSummary(next, "root-0")).toBe("已有主题的概览。");
  });
});

describe("overview hierarchy", () => {
  it("places introductions clear of cards and each other at fractional zoom", () => {
    const board = tree(2);
    const layout = layoutTree(board.nodes);
    const regions = overviewRegions(board, layout, new Map());
    for (const zoom of [0.3, 0.271735, 0.2, 0.12, 0.1]) {
      const { visible } = overviewFrontier(regions, zoom, 1512);
      const labels = [
        ...overviewLabels(regions, visible, zoom, layout, new Map()).values(),
      ];
      const boxes = labels.map((label) => ({
        x: label.x - label.width / zoom / 2,
        y: label.y - 104 / zoom,
        w: label.width / zoom,
        h: 104 / zoom,
      }));
      const overlaps = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number },
      ) =>
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y;
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes.slice(i + 1).some((box) => overlaps(boxes[i], box))).toBe(
          false,
        );
        expect(
          [...layout.positions.values()].some((p) =>
            overlaps(boxes[i], { ...p, h: p.level === 0 ? 150 : 130 }),
          ),
        ).toBe(false);
      }
    }
  });
  it("caps preview depth at three, preserves bounds and ends at first-level topics", () => {
    const board = tree(5);
    const layout = layoutTree(board.nodes);
    const regions = overviewRegions(board, layout, new Map());
    expect(Math.max(...regions.map((region) => region.depth))).toBe(3);
    expect(overviewFrontier(regions, 0.31, 600).visible.size).toBe(0);
    const close = overviewFrontier(regions, 0.3, 600);
    expect(
      [...close.visible].some(
        (id) => regions.find((region) => region.id === id)!.depth === 3,
      ),
    ).toBe(true);
    const medium = overviewFrontier(regions, 0.2, 600);
    expect(
      [...medium.visible].every(
        (id) => regions.find((region) => region.id === id)!.depth <= 2,
      ),
    ).toBe(true);
    const far = overviewFrontier(regions, 0.12, 1512);
    expect([...far.visible]).toEqual(["root-0", "root-1"]);
    for (const visible of [close.visible, far.visible]) {
      const members = [...visible].flatMap(
        (id) => regions.find((region) => region.id === id)!.members,
      );
      expect(new Set(members).size).toBe(members.length);
    }
    const small = tree(2);
    const smallRegions = overviewRegions(
      small,
      layoutTree(small.nodes),
      new Map(),
    );
    expect([...overviewFrontier(smallRegions, 0.18, 1512).visible]).toEqual([
      "root-0",
      "root-1",
    ]);
    expect(layoutTree(board.nodes)).toEqual(layout);
    for (const region of regions) {
      for (const id of region.members) {
        const p = layout.positions.get(id)!;
        expect(p.x).toBeGreaterThanOrEqual(region.x);
        expect(p.x + p.w).toBeLessThanOrEqual(region.x + region.width);
      }
    }
  });

  it("skips single chains and uses one overview for an ordinary board", () => {
    const board = tree(1);
    board.nodes.push({
      ...board.nodes[1],
      id: "detail",
      parentId: "root-0",
      order: 0,
    });
    const regions = overviewRegions(board, layoutTree(board.nodes), new Map());
    expect(regions.map((region) => region.depth)).toEqual([1, 1]);
  });

  it("keeps the previous frontier inside the 24px hysteresis band", () => {
    const board = tree(2);
    const regions = overviewRegions(board, layoutTree(board.nodes), new Map());
    const parent = regions.find((region) => region.id === "root-0")!;
    parent.width = 2000;
    for (const child of regions.filter((region) =>
      parent.children.includes(region.id),
    ))
      child.width = 800;
    expect(overviewFrontier(regions, 0.29, 500).visible.has(parent.id)).toBe(
      true,
    );
    expect(
      overviewFrontier(regions, 0.29, 500, new Set([parent.id])).split.has(
        parent.id,
      ),
    ).toBe(true);
    expect(
      overviewFrontier(regions, 0.27, 500, new Set([parent.id])).visible.has(
        parent.id,
      ),
    ).toBe(true);
  });

  it("starts only at 30%, preserving readable cards above that threshold", () => {
    expect(overviewOpacity(1)).toBe(0);
    expect(overviewOpacity(0.65)).toBe(0);
    expect(overviewOpacity(0.31)).toBe(0);
    expect(overviewOpacity(0.3)).toBe(1);
    expect(overviewOpacity(0.18)).toBe(1);
  });
});
