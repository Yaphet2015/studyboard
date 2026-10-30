import { goalText } from "../model/goal";
import { useState } from "react";
import { Check, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import type { BoardPlan } from "../shared/types";
import { removeBlock, renameBlock } from "../model/plan";

/** Draft learning plan in the kickoff drawer: rename or drop blocks, then confirm to lay the first level. */
export function PlanEditor({
  plan,
  planning,
  busy,
  onChange,
  onConfirm,
  onReplan,
}: {
  plan?: BoardPlan;
  planning: boolean;
  busy: boolean;
  onChange: (plan: BoardPlan) => void;
  onConfirm: () => void;
  onReplan: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (planning && !plan)
    return (
      <section className="plan-editor" aria-busy="true" aria-label="学习计划">
        <div className="plan-head">
          <LoaderCircle size={15} className="ico spin" />
          <span>正在拟定学习计划…</span>
        </div>
      </section>
    );
  if (!plan) return null;
  const confirmed = plan.status === "confirmed";
  const tops = plan.blocks.filter((b) => b.parent === null);
  const row = (id: string, sub: boolean) => {
    const b = plan.blocks.find((x) => x.id === id)!;
    return (
      <li key={b.id} className={sub ? "plan-block sub" : "plan-block"}>
        <div className="plan-row">
          {editing === b.id && !confirmed ? (
            <input
              className="plan-title-input"
              aria-label="块标题"
              autoFocus
              defaultValue={b.title}
              maxLength={80}
              onBlur={(e) => {
                const t = e.currentTarget.value.trim();
                if (t && t !== b.title) onChange(renameBlock(plan, b.id, t));
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <button
              className="plan-title"
              disabled={confirmed}
              title={confirmed ? undefined : "点击修改"}
              onClick={() => setEditing(b.id)}
            >
              {b.title}
            </button>
          )}
          {b.core && <span className="plan-core">核心</span>}
          {!confirmed && (
            <button
              className="icon-btn plan-del"
              aria-label={`删除「${b.title}」`}
              disabled={tops.length <= 1 && !sub}
              onClick={() => onChange(removeBlock(plan, b.id))}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {b.why && <div className="plan-why">{b.why}</div>}
      </li>
    );
  };
  return (
    <section className="plan-editor" aria-label="学习计划" data-intent={plan.intent}>
      <div className="plan-head">
        <span className="plan-goal">{goalText(plan.goal)}</span>
      </div>
      {plan.learner && <div className="plan-learner">{plan.learner}</div>}
      <ol className="plan-blocks">
        {tops.map((t) => [
          row(t.id, false),
          ...plan.blocks.filter((b) => b.parent === t.id).map((b) => row(b.id, true)),
        ])}
      </ol>
      {plan.outOfScope.length > 0 && (
        <div className="plan-out">不展开：{plan.outOfScope.join("、")}</div>
      )}
      {!confirmed && (
        <div className="plan-acts">
          <button
            className="btn sm primary"
            disabled={busy || tops.length === 0}
            onClick={onConfirm}
          >
            <Check size={15} className="ico" />
            确认计划，铺成第一层
          </button>
          <button className="btn sm" disabled={planning} onClick={onReplan}>
            <RotateCcw size={14} className="ico" />
            重新拟定
          </button>
        </div>
      )}
    </section>
  );
}
