import { useEffect, useRef, useState } from "react";
import type { PlanGoal } from "../shared/types";

export function GoalSummary({ goal }: { goal: PlanGoal }) {
  return (
    <div className="route-diff goal-summary">
      <b>{goal.deliverable}</b>
      <p>
        {[
          ...goal.criteria.map((c) => c.label),
          ...goal.constraints,
          goal.experience,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}
export function GoalPin({ goal }: { goal: string | PlanGoal }) {
  const text = JSON.stringify(goal);
  const last = useRef(text);
  const [sweep, setSweep] = useState(false);
  useEffect(() => {
    if (last.current === text) return;
    last.current = text;
    setSweep(true);
    const timer = setTimeout(() => setSweep(false), 600);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className={`goal-pin ${sweep ? "sweep" : ""}`} aria-label="当前目标">
      目标 ·{" "}
      {typeof goal === "string" ? (
        <b>{goal}</b>
      ) : (
        <>
          <b>{goal.deliverable}</b>
          {[...goal.criteria.map((c) => c.label), ...goal.constraints].map(
            (s, i) => (
              <span key={i}> · {s}</span>
            ),
          )}
        </>
      )}
    </div>
  );
}
