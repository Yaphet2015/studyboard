import { useEffect, useState } from "react";
import type { ProbeState } from "../shared/types";
import { MAX_QUESTIONS, nextStep, probeOutcome } from "../model/probe";

export type ProbePhase = "first" | "deeper" | "refine" | "result" | null;

export interface ProbeProps {
  state: ProbeState;
  /** Grading a free-text reason. */
  busy: boolean;
  /** Which generation call is running (README §9 skeletons); "result" = the route is being laid. */
  phase: ProbePhase;
  topic: string;
  stations: number;
  onAnswer: (choice: number | null, text: string) => void;
  onSkip: () => void;
  /** 从这里开始 */
  onStart?: () => void;
  /** 换个起点: probe again. */
  onRestart?: () => void;
  /** Kept for 我想从头学 in other surfaces. */
  onFromStart?: () => void;
}

const IDK = "不了解这块";

/** Show the skeleton only after 300ms; add the slow line after 12s. */
function useDelayed(on: boolean) {
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setShown(false);
    setSlow(false);
    if (!on) return;
    const a = setTimeout(() => setShown(true), 300);
    const b = setTimeout(() => setSlow(true), 12000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [on]);
  return { shown, slow };
}

function Dots({ n, total }: { n: number; total: number }) {
  return (
    <span className="probe-dots" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < n ? "d" : i === n ? "n" : ""} />
      ))}
    </span>
  );
}

function Skeleton({ phase, topic, slow }: { phase: Exclude<ProbePhase, null>; topic: string; slow: boolean }) {
  const line =
    phase === "first" ? `正在为「${topic}」出第一道题…` : phase === "deeper" ? "答对了，在往更深处找…" : phase === "refine" ? "在缩小范围…" : "正在确定你的起点…";
  return (
    <div className="probe-sk" role="status" aria-live="polite" data-phase={phase}>
      <p className="probe-st">
        <i />
        {line}
      </p>
      {phase === "first" && <p className="probe-sub">大约 5–8 题，随时可以跳过</p>}
      {phase === "result" ? (
        <div className="probe-res sk-wrap">
          <span className="sk" style={{ width: "40%", height: 12 }} />
          <span className="sk" style={{ width: "80%", height: 18 }} />
          <span className="sk" style={{ width: "65%", height: 12 }} />
        </div>
      ) : (
        <div className="probe-q sk-wrap">
          <span className="sk" style={{ width: "90%", height: 16 }} />
          <span className="sk" style={{ width: "70%", height: 16 }} />
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk sk-opt" />
          ))}
        </div>
      )}
      {slow && <p className="probe-sub">比平时慢一点…</p>}
    </div>
  );
}

/** 摸底 v2 (README): no levels, no scores, no right/wrong marks; one question at a time. */
export function ProbePanel({ state, busy, phase, topic, stations, onAnswer, onSkip, onStart, onRestart, onFromStart }: ProbeProps) {
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [why, setWhy] = useState(false);
  const { shown, slow } = useDelayed(phase !== null);
  const asking = state.status === "asking";
  const step = asking && state.ladder.length ? nextStep(state) : undefined;
  const point = step?.kind === "ask" ? state.ladder[step.index] : undefined;
  const n = state.answers.length;
  const total = Math.max(6, Math.min(MAX_QUESTIONS, n + 3));
  const opts = point?.probe.options ?? [];
  const submit = () => {
    if (busy || !point || choice === null) return;
    onAnswer(choice, choice === -1 ? "" : text);
    setChoice(null);
    setText("");
    setWhy(false);
  };
  const head = (
    <div className="probe-head">
      <h3>找到你的起点</h3>
      {asking && state.meta?.mode === "confirm" && n === 0 && <p className="probe-sub">我记得你已经懂前面这些，先确认一下</p>}
      {asking && (
        <span className="probe-prog">
          第 {n + 1} 题 <Dots n={n} total={total} />
        </span>
      )}
    </div>
  );
  if (phase) {
    return (
      <section className="stop probe" aria-label="摸底" aria-busy>
        {head}
        {shown ? <Skeleton phase={phase} topic={topic} slow={slow} /> : <div className="probe-sk-hold" />}
        <div className="probe-actions">
          <button className="btn" disabled style={{ opacity: 0.4 }}>
            确定
          </button>
          {phase !== "result" && (
            <button className="btn quiet" onClick={onSkip}>
              跳过摸底
            </button>
          )}
        </div>
      </section>
    );
  }
  if (asking) {
    return (
      <section className="stop probe" aria-label="摸底">
        {head}
        <p className="probe-st">
          <i />
          正在找你的起点
        </p>
        {point ? (
          <div className="probe-q">
            <p className="beat-q">{point.probe.q}</p>
            <div className="beat-options" role="radiogroup" aria-label="摸底选项">
              {[...opts, IDK].map((o, i) => {
                const v = i === opts.length ? -1 : i;
                return (
                  <button key={i} role="radio" aria-checked={choice === v} className={`opt ${v === -1 ? "idk" : ""} ${choice === v ? "on" : ""}`} onClick={() => setChoice(v)}>
                    {o}
                  </button>
                );
              })}
            </div>
            <textarea
              className={`probe-why ${why || text ? "open" : ""}`}
              aria-label="说说理由（可选）"
              placeholder="说说理由（可选）"
              value={text}
              disabled={choice === -1}
              rows={why || text ? 3 : 1}
              onFocus={() => setWhy(true)}
              onBlur={() => setWhy(false)}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        ) : null}
        <div className="probe-actions">
          <button className="btn primary" disabled={choice === null || busy} style={choice === null || busy ? { opacity: 0.4 } : undefined} onClick={submit}>
            {busy ? "在看你的理由…" : "确定"}
          </button>
          <button className="btn quiet" onClick={onSkip}>
            跳过摸底
          </button>
        </div>
      </section>
    );
  }
  const o = probeOutcome(state);
  return (
    <section className="stop probe" aria-label="摸底结果">
      {head}
      <div className="probe-res">
        {o.skipped && !o.questions ? (
          <h4>跳过也没关系，我会从最基础的开始排。</h4>
        ) : o.capped ? (
          <h4>你懂得挺深，先从这里开始，后面随时可以往下钻。</h4>
        ) : o.known ? (
          <>
            <span className="probe-k">你已经懂到</span>
            <h4>{o.known.desc}</h4>
            <p>
              从「{o.start?.desc}」开始，正好在你会的上面一层。
            </p>
          </>
        ) : (
          <h4>我们从最基础的开始。</h4>
        )}
        {o.knownList.length > 0 && (
          <ul className="probe-known">
            {o.knownList.length > 4 && <li className="probe-more">……还有 {o.knownList.length - 4} 个更基础的</li>}
            {o.knownList.slice(-4).map((k) => (
              <li key={k.id ?? k.level}>{k.desc}</li>
            ))}
          </ul>
        )}
      </div>
      {o.start && (
        <div className="probe-start">
          <span className="no">1</span>
          <b>{o.start.desc}</b>
          {stations > 0 && <span className="probe-sub"> · 共 {stations} 站</span>}
        </div>
      )}
      <div className="probe-actions">
        {onStart && (
          <button className="btn primary" onClick={onStart}>
            从这里开始
          </button>
        )}
        {onRestart && (
          <button className="btn quiet" onClick={onRestart}>
            换个起点
          </button>
        )}
        {onFromStart && (
          <button className="btn quiet" onClick={onFromStart}>
            我想从头学
          </button>
        )}
      </div>
    </section>
  );
}
