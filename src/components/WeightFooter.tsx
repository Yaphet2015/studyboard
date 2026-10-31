import { cardMastered } from "../model/goal";
import { useRef, useState } from "react";
import type { ConceptNode } from "../shared/types";

export interface WeightActions {
  onRead: () => void;
  onAnswer: (answer: string, choice: number | null) => Promise<void>;
}
/** All three cards share the same face. Only this footer changes. */
export function WeightFooter({
  card,
  actions,
}: {
  card: ConceptNode;
  actions: WeightActions;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const initialWeight = useRef(card.weight);
  const weight = card.weight ?? "background";
  const answer = async (value: string, choice: number | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await actions.onAnswer(value, choice);
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      key={weight}
      className={`weight-footer nodrag nopan ${weight === "background" ? "background" : ""} ${initialWeight.current !== card.weight ? "upgraded" : ""}`}
      data-weight={weight}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {cardMastered(card) ||
      (weight === "background" && (card.beat === "done" || card.status === "explained")) ? (
        <span className="lab">
          {cardMastered(card) ? "已掌握" : "读过"}
        </span>
      ) : weight === "background" ? (
        <button className="btn sm" onClick={actions.onRead}>
          懂了
        </button>
      ) : (
        <>
          <p className="weight-question">
            {weight === "hard"
              ? card.questionPrompt ||
                `你觉得「${card.title}」用到自己的情况会怎样？先猜，再用你的话讲一遍。`
              : card.check?.q || card.upgradeCheck?.q}
          </p>
          {weight === "core" &&
          (card.check?.options || card.upgradeCheck?.options)?.length ? (
            <div className="weight-options">
              {(card.check?.options || card.upgradeCheck?.options)!.map(
                (option, i) => (
                  <button
                    className="btn sm"
                    key={i}
                    disabled={busy}
                    onClick={() => void answer(option, i)}
                  >
                    {option}
                  </button>
                ),
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void answer(text.trim(), null);
              }}
            >
              <input
                aria-label="写下你的猜测"
                placeholder="你觉得呢？"
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
              {text.trim() && (
                <button className="btn sm" disabled={busy}>
                  提交
                </button>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}
