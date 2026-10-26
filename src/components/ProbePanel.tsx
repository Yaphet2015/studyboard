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

function Dots({
  n,
  total,
  confirm = false,
}: {
  n: number;
  total: number;
  confirm?: boolean;
}) {
  return (
    <span className={`probe-dots${confirm ? " confirm" : ""}`} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < n ? "d" : i === n ? "n" : ""} />
      ))}
    </span>
  );
}

function Skeleton({
  phase,
  topic,
  slow,
  confirm,
}: {
  phase: Exclude<ProbePhase, null>;
  topic: string;
  slow: boolean;
  confirm: boolean;
}) {
  const line = confirm
    ? phase === "result"
      ? "正在对照你的了解排路线…"
      : phase === "first"
        ? "正在对照你的了解出确认题…"
        : "答对了，再确认下一个…"
    : phase === "first"
      ? `正在为「${topic}」出第一道题…`
      : phase === "deeper"
        ? "答对了，在往更深处找…"
        : phase === "refine"
          ? "在缩小范围…"
          : "正在确定你的起点…";
  return (
    <div
      className="probe-sk"
      role="status"
      aria-live="polite"
      data-phase={phase}
    >
      <p className="probe-st">
        <i />
        {line}
      </p>
      {phase === "first" && (
        <p className="probe-sub">
          {confirm ? "只要 1–2 道，随时可以跳过" : "大约 5–8 题，随时可以跳过"}
        </p>
      )}
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
export function ProbePanel({
  state,
  busy,
  phase,
  topic,
  stations,
  onAnswer,
  onSkip,
  onStart,
  onRestart,
  onFromStart,
}: ProbeProps) {
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [why, setWhy] = useState(false);
  const { shown, slow } = useDelayed(phase !== null);
  const asking = state.status === "asking";
  const step = asking && state.ladder.length ? nextStep(state) : undefined;
  const point = step?.kind === "ask" ? state.ladder[step.index] : undefined;
  const confirm = state.meta?.mode === "confirm";
  const n = state.answers.length - (state.meta?.confirmFailedAt ?? 0);
  const transitioning =
    asking && state.meta?.confirmFailedAt !== undefined && n === 0;
  const skipLabel = confirm ? "跳过确认，直接开始" : "跳过摸底";
  const total = Math.max(6, Math.min(MAX_QUESTIONS, n + 3));
  const opts = point?.probe.options ?? [];
  const submit = () => {
    if (busy || !point || choice === null) return;
    onAnswer(choice, choice === -1 ? "" : text);
    setChoice(null);
    setText("");
    setWhy(false);
  };
  const skip = () => {
    setChoice(null);
    setText("");
    setWhy(false);
    onSkip();
  };
  const head = (
    <>
      <div className="probe-head">
        <h3>{confirm ? "确认你的起点" : "找到你的起点"}</h3>
        {asking && (
          <span className="probe-prog">
            {confirm ? `确认 ${n + 1}/2` : `第 ${n + 1} 题`}{" "}
            <Dots n={n} total={confirm ? 2 : total} confirm={confirm} />
          </span>
        )}
      </div>
      {asking && confirm && n === 0 && (
        <p className="probe-intro">
          {state.meta?.confirmIntro?.trim() ||
            "我记得你已经懂前面这些，先确认一下"}
        </p>
      )}
      {transitioning && (
        <p className="probe-st">
          <i />
          这题没答上来，我从基础重新摸一下。
        </p>
      )}
    </>
  );
  if (phase) {
    return (
      <section className="stop probe" aria-label="摸底" aria-busy>
        {head}
        {shown ? (
          <Skeleton phase={phase} topic={topic} slow={slow} confirm={confirm} />
        ) : (
          <div className="probe-sk-hold" />
        )}
        <div className="probe-actions">
          <button className="btn" disabled style={{ opacity: 0.4 }}>
            确定
          </button>
          {phase !== "result" && (
            <button className="btn quiet" onClick={skip}>
              {skipLabel}
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
        {!confirm && !transitioning && (
          <p className="probe-st">
            <i />
            正在找你的起点
          </p>
        )}
        {point ? (
          <div className="probe-q">
            <p className="beat-q">{point.probe.q}</p>
            <div
              className="beat-options"
              role="radiogroup"
              aria-label="摸底选项"
            >
              {(confirm ? opts : [...opts, IDK]).map((o, i) => {
                const v = i === opts.length ? -1 : i;
                return (
                  <button
                    key={i}
                    role="radio"
                    aria-checked={choice === v}
                    className={`opt ${v === -1 ? "idk" : ""} ${choice === v ? "on" : ""}`}
                    onClick={() => setChoice(v)}
                  >
                    {o}
                  </button>
                );
              })}
            </div>
            {confirm && (
              <button
                className="probe-idk"
                disabled={busy}
                onClick={() => {
                  onAnswer(-1, "");
                  setChoice(null);
                  setText("");
                  setWhy(false);
                }}
              >
                不对，我不懂这个
              </button>
            )}
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
          <button
            className="btn primary"
            disabled={choice === null || busy}
            style={choice === null || busy ? { opacity: 0.4 } : undefined}
            onClick={submit}
          >
            {busy ? "在看你的理由…" : "确定"}
          </button>
          <button className="btn quiet" onClick={skip}>
            {skipLabel}
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
        {confirm && o.known ? (
          <>
            <span className="probe-k">已确认 · {o.questions} 题</span>
            <h4>按你的了解，{o.known.desc}你已经懂</h4>
            <p>路线从「{o.start?.desc}」开始，前面的只会一笔带过。</p>
          </>
        ) : o.skipped && !o.questions ? (
          <h4>跳过也没关系，我会从最基础的开始排。</h4>
        ) : o.capped ? (
          <h4>你懂得挺深，先从这里开始，后面随时可以往下钻。</h4>
        ) : o.known ? (
          <>
            <span className="probe-k">你已经懂到</span>
            <h4>{o.known.desc}</h4>
            <p>从「{o.start?.desc}」开始，正好在你会的上面一层。</p>
          </>
        ) : (
          <h4>我们从最基础的开始。</h4>
        )}
        {!confirm && o.knownList.length > 0 && (
          <ul className="probe-known">
            {o.knownList.length > 4 && (
              <li className="probe-more">
                ……还有 {o.knownList.length - 4} 个更基础的
              </li>
            )}
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
          {stations > 0 && (
            <span className="probe-sub"> · 共 {stations} 站</span>
          )}
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
