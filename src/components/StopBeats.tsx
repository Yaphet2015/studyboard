import { AgentEditProse } from "./AgentEditProse";
import { useState } from "react";
import { Check } from "lucide-react";
import type { Beat, ConceptNode } from "../shared/types";
import { BEATS, BEAT_LABEL } from "../model/next-step";
import { UNSURE, type Mark } from "../model/mark";

export interface StudyProps {
  station?: number;
  /** Save the learner's progress on this card (beat, guess, explain…). */
  onPatch: (patch: Partial<ConceptNode>) => void;
  /** Mark a 讲 or 测 answer; null when marking failed (AI unavailable). */
  onMark: (kind: "explain" | "test", answer: string, choice: number | null) => Promise<Mark | null>;
  /** Two wrong 测 answers: the stuck exits (phase 2 fills these in). */
  stuck?: React.ReactNode;
  /** A light (摸底) seal failed its recheck: drop it and queue the stop after the current one. */
  onRecheckFail?: () => void;
}

const BULLET = /^\s*([-•·]|\d+[.、])\s*/;

/** Title + natural prose (pre-wrap keeps paragraphs); a list only when every line is an item. */
export function CardProse({ body, cardId }: { body: string; cardId?: string }) {
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length >= 2 && lines.every((l) => BULLET.test(l)))
    return (
      <ul className="card-list">
        {lines.map((l, i) => (
          <li key={i}>
            <AgentEditProse
              body={body} cardId={cardId} className="card-list-prose"
              project={text => (text.split("\n").filter(l => l.trim())[i] ?? "").replace(BULLET, "")}
            />
          </li>
        ))}
      </ul>
    );
  return <AgentEditProse body={body} cardId={cardId} className="card-body" />;
}

/** The four beats of one stop: 先猜 → 学 → 讲 → 测; passing 测 earns the A seal. */
export function StopBeats({ card, study }: { card: ConceptNode; study: StudyProps }) {
  const [recheck, setRecheck] = useState(false);
  const beat: Beat = recheck ? "test" : card.status === "explained" ? "done" : (card.beat ?? "guess");
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const go = (patch: Partial<ConceptNode>) => {
    setText("");
    setChoice(null);
    setFeedback(null);
    study.onPatch(patch);
  };
  const submit = async (kind: "explain" | "test") => {
    if (busy) return;
    const answer = kind === "test" && choice !== null && choice >= 0 ? `${card.check?.options?.[choice] ?? ""}。理由：${text}` : text;
    if (kind === "explain" && !text.trim()) return;
    setBusy(true);
    const mark = await study.onMark(kind, answer, kind === "test" ? choice : null);
    setBusy(false);
    if (!mark) {
      setFeedback({ ok: false, text: "这次没判出来，稍后再提交一次。" });
      return;
    }
    if (kind === "explain") {
      if (mark.pass) go({ beat: "test", explain: text, status: "exploring" });
      else setFeedback({ ok: false, text: `还差一点：${mark.missing || "没说到这张卡的新点"}` });
      return;
    }
    if (mark.pass) {
      setRecheck(false);
      go({ beat: "done", status: "explained", seal: "test", fails: 0 });
      return;
    }
    if (recheck) {
      setRecheck(false);
      go({});
      study.onRecheckFail?.();
      return;
    }
    const fails = (card.fails ?? 0) + 1;
    setFeedback({ ok: false, text: fails >= 2 ? "没关系，这说明这里藏着更小的概念。" : `还没对：${mark.missing || "再想想"}。再试一次？` });
    study.onPatch({ fails });
  };
  const current = BEATS.indexOf(beat);
  const options = card.check?.options;
  return (
    <section className="stop" aria-label="这一站">
      <ol className="beats" aria-label="节拍">
        {BEATS.map((b, i) => (
          <li
            key={b}
            className={`beat ${beat === "done" || i < current ? "done" : i === current ? "on" : ""}`}
            aria-current={i === current ? "step" : undefined}
          >
            {(beat === "done" || i < current) && <Check size={12} className="ico" aria-hidden="true" />}
            {BEAT_LABEL[b]}
          </li>
        ))}
      </ol>
      {beat !== "guess" && <CardProse body={card.body} cardId={card.id} />}
      {beat === "guess" && (
        <div className="beat-pane">
          <span className="lab">第 1 拍 · 先猜一猜</span>
          <p className="beat-q">读之前先猜：「{card.title}」——你觉得为什么会这样？</p>
          <textarea
            className="beat-input"
            aria-label="我的猜测"
            rows={2}
            value={text}
            placeholder="猜错也没关系，先写下来。"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                go({ beat: "learn", guess: text, status: "exploring" });
              }
            }}
          />
          <div className="beat-acts">
            <button className="btn primary" onClick={() => go({ beat: "learn", guess: text, status: "exploring" })}>
              记下猜测 <span className="kbd">↵</span>
            </button>
          </div>
        </div>
      )}
      {beat === "learn" && (
        <div className="beat-pane">
          {card.guess && <p className="beat-note">你猜的是：{card.guess}</p>}
          {card.analogy && (
            <p className="beat-analogy">
              <span className="lab">换个类比</span>
              {card.analogy}
            </p>
          )}
          <div className="beat-acts">
            <button className="btn primary" onClick={() => go({ beat: "explain" })}>
              读完了，我来讲讲
            </button>
          </div>
        </div>
      )}
      {beat === "explain" && (
        <div className="beat-pane">
          <span className="lab">第 3 拍 · 用你的话讲</span>
          <textarea
            className="beat-input"
            aria-label="用我的话讲"
            rows={3}
            value={text}
            placeholder="写不出来？从这一句开始：『它的意思是……，比如……』"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit("explain");
            }}
          />
          {feedback && <p className={`beat-feedback ${feedback.ok ? "ok" : ""}`} role="status">{feedback.text}</p>}
          <div className="beat-acts">
            <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void submit("explain")}>
              {busy ? "正在看…" : "提交"} <span className="kbd">⌘↵</span>
            </button>
            {feedback && (
              <button
                className="btn"
                onClick={() => go({ beat: "test", explain: text, meta: { ...card.meta, missed: feedback.text.replace(/^还差一点：/, "").slice(0, 200) } })}
              >
                先去测
              </button>
            )}
          </div>
        </div>
      )}
      {beat === "test" && (
        <div className="beat-pane">
          <span className="lab">第 4 拍 · 检查题（新情境）</span>
          <p className="beat-q">{card.check?.q ?? `换个情境：「${card.title}」在哪种情况下会不成立？说出理由。`}</p>
          {options?.length ? (
            <div className="beat-options" role="radiogroup" aria-label="选项">
              {[...options, UNSURE].map((o, i) => {
                const v = i === options.length ? -1 : i;
                return (
                  <button
                    key={i}
                    role="radio"
                    aria-checked={choice === v}
                    className={`opt ${choice === v ? "on" : ""}`}
                    onClick={() => setChoice(v)}
                  >
                    {i < options.length ? `${String.fromCharCode(65 + i)}. ` : ""}
                    {o}
                  </button>
                );
              })}
            </div>
          ) : null}
          <textarea
            className="beat-input"
            aria-label={options?.length ? "再用一句话说说为什么" : "我的回答"}
            rows={2}
            value={text}
            placeholder={options?.length ? "再用一句话说说为什么" : "用一两句话回答，并说出理由"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit("test");
            }}
          />
          {feedback && <p className="beat-feedback" role="status">{feedback.text}</p>}
          {(card.fails ?? 0) >= 2 && study.stuck}
          <div className="beat-acts">
            <button
              className="btn primary"
              disabled={busy || (options?.length ? choice === null : !text.trim())}
              onClick={() => void submit("test")}
            >
              {busy ? "正在判…" : "提交"} <span className="kbd">⌘↵</span>
            </button>
          </div>
          <p className="beat-foot">答对且理由说中要点，才盖 A 印</p>
        </div>
      )}
      {beat === "done" && (
        <p className="beat-sealed">
          <span className="seal-a" aria-hidden="true">A</span>
          {card.seal === "probe" ? "你已经会了 · 可跳过" : "这一站讲清楚了"}
          {card.seal === "probe" && (
            <button className="btn quiet" onClick={() => setRecheck(true)}>
              复查一下
            </button>
          )}
        </p>
      )}
    </section>
  );
}
