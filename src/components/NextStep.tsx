import type { NextStep } from "../model/next-step";
import { BEAT_LABEL } from "../model/next-step";

const ACTION: Record<string, string> = {
  guess: "先猜一猜",
  learn: "读一读",
  explain: "用你的话讲一遍",
  test: "做检查题",
};

/** The persistent 下一步 bar at the bottom centre: what to do now, and why it is this one. */
export function NextStepBar({
  step,
  onStart,
  onSkip,
  onRoute,
  welcome,
}: {
  step: NextStep;
  onStart: () => void;
  onSkip?: () => void;
  onRoute: () => void;
  /** First open after coming back: greet with where they left off. */
  welcome?: boolean;
}) {
  if (step.kind === "none") return null;
  if (step.kind === "route")
    return (
      <div className="chrome next-step" role="region" aria-label="下一步">
        <div className="ns-text">
          <span className="ns-k">下一步</span>
          <span className="ns-main">{step.why}</span>
        </div>
        <button className="btn primary" onClick={onRoute}>
          帮我排一条路线
        </button>
      </div>
    );
  if (step.kind === "wrapped")
    return (
      <div className="chrome next-step" role="region" aria-label="下一步">
        <span className="ns-no star" aria-hidden="true">★</span>
        <div className="ns-text">
          <span className="ns-k">全部讲清楚了</span>
          <span className="ns-main">{step.why}</span>
        </div>
      </div>
    );
  const station = "station" in step ? step.station : undefined;
  const head =
    step.kind === "wrap"
      ? "★ 下一步 · 收尾"
      : step.kind === "probe"
        ? "下一步 · 摸底"
        : `下一步${station ? ` · 第 ${station} 站` : ""}`;
  const main =
    step.kind === "probe"
      ? step.confirm ? "先确认一下你的基础" : "继续摸底，找到你的起点"
      : step.kind === "wrap"
      ? "把所有站合起来，讲回你的起点问题"
      : step.kind === "continue"
        ? `${step.card.title} —— 继续：${BEAT_LABEL[step.beat]}`
        : step.kind === "deeper"
          ? `${step.card.title} —— 往下一层`
          : `${step.card.title} —— ${ACTION[step.card.beat ?? "guess"]}`;
  const why =
    welcome && step.kind === "continue"
      ? `欢迎回来。上次做到第 ${station ?? "?"} 站的「${BEAT_LABEL[step.beat]}」，接着来？`
      : `为什么是它：${step.why}`;
  return (
    <div className="chrome next-step" role="region" aria-label="下一步">
      {station !== undefined && <span className="ns-no" aria-hidden="true">{station}</span>}
      <div className="ns-text">
        <span className="ns-k">{head}</span>
        <span className="ns-main">{main}</span>
        <span className="ns-why">{why}</span>
      </div>
      <button className="btn primary" onClick={onStart} aria-keyshortcuts="Enter">
        {step.kind === "wrap" ? "开始讲" : "开始"} <span className="kbd">↵</span>
      </button>
      {onSkip && step.kind !== "wrap" && step.kind !== "probe" && (
        <button className="btn quiet" onClick={onSkip}>
          换一个
        </button>
      )}
    </div>
  );
}
