import { createEmptyBoard } from "../src/model/boards";
import type { Board, ConceptNode, PlanGoal } from "../src/shared/types";

export const fixtureGoal: PlanGoal = {
  deliverable: "作品集上线清单",
  criteria: [
    {
      id: "access",
      label: "可访问性评分至少 90",
      target: 90,
      direction: "atLeast",
      unit: "分",
    },
  ],
  constraints: ["本月底交付", "沿用现有素材"],
  experience: "曾因图片缺少说明而返工",
};
export function goalBoard(): Board {
  const board = createEmptyBoard("怎样交付一个能访问的作品集网站？");
  const root = board.nodes[0];
  const card = (
    id: string,
    title: string,
    body: string,
    order: number,
    extra: Partial<ConceptNode>,
  ): ConceptNode => ({
    id,
    kind: "concept",
    title,
    body,
    parentId: root.id,
    order,
    status: "unseen",
    source: "项目测量记录",
    date: "2026-10-20",
    check: {
      q: "替换插图时，哪种做法更便于读者理解？",
      options: ["按图片用途补充说明", "所有图片使用相同说明"],
    },
    upgradeCheck: {
      q: "替换插图时，哪种做法更便于读者理解？",
      options: ["按图片用途补充说明", "所有图片使用相同说明"],
    },
    questionPrompt:
      "如果页面中的插图无法加载，读者还能理解作品吗？先猜，再用你的话讲一遍理由。",
    meta: { check: { answer: 0, keyPoints: ["说明应表达用途"] } },
    ...extra,
  });
  board.nodes.push(
    card(
      "goal-bg",
      "先读懂交付范围",
      "交付清单把页面、素材和验收要求放在一起。本次已有素材可用，先核对用途，再补齐说明。",
      0,
      { weight: "background", status: "explained", beat: "done", seal: "test" },
    ),
    card(
      "goal-core",
      "图片说明要表达用途",
      "这次测量发现图片说明缺失，影响读者理解作品。沿用素材时，应按图片在页面里的用途补充描述。",
      1,
      { weight: "core", status: "exploring", beat: "test" },
    ),
    card(
      "goal-hard",
      "没有图片也能理解作品",
      "检查页面移除插图后是否仍能传达作品意图。文字描述应说明作品的作用，不能只重复文件名。",
      2,
      { weight: "hard" },
    ),
  );
  board.route = board.nodes.slice(1).map((n) => n.id);
  board.plan = {
    status: "confirmed",
    intent: "howto",
    goal: structuredClone(fixtureGoal),
    learner: "第一次独立交付作品集",
    blocks: board.nodes
      .slice(1)
      .map((n) => ({
        id: n.id,
        title: n.title,
        why: "填好交付清单中的这一块",
        parent: null,
        core: true,
        prerequisites: [],
      })),
    outOfScope: [],
    artifact: [
      { stopId: "goal-bg", title: "交付范围", content: "页面与素材已经核对。" },
    ],
  };
  return board;
}
