import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  P,
  editDuration,
  inEase,
  outEase,
  sentenceDiff,
  sentences,
  sweepEase,
  type AgentEdit,
} from "../model/agent-edit";

export const AgentEdits = createContext<ReadonlyMap<string, AgentEdit>>(
  new Map(),
);

/** Only presentation lives here; body already contains the value used by save/export. */
export function AgentEditProse({
  body,
  cardId,
  className,
  project = (s: string) => s,
}: {
  body: string;
  cardId?: string;
  className: string;
  project?: (s: string) => string;
}) {
  const edits = useContext(AgentEdits);
  const candidate = cardId ? edits.get(cardId) : undefined;
  const [finished, setFinished] = useState<AgentEdit>();
  const edit =
    candidate?.after === body &&
    candidate !== finished &&
    project(candidate.before) !== project(body) &&
    performance.now() < candidate.start + editDuration(candidate)
      ? candidate
      : undefined;
  const before = project(edit?.before ?? body),
    after = project(body);
  const chunks = useMemo(
    () => (edit ? sentenceDiff(before, after) : []),
    [before, after, !!edit],
  );
  const root = useRef<HTMLParagraphElement>(null);
  const old = useRef<HTMLSpanElement>(null);
  const next = useRef<HTMLSpanElement>(null);
  const wash = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!edit || !root.current || !old.current || !next.current) return;
    const el = root.current,
      a = old.current,
      b = next.current,
      w = wash.current;
    const oldHeight = a.offsetHeight,
      newHeight = b.offsetHeight;
    const height = Math.max(oldHeight, newHeight) + 12;
    const rect = a.getBoundingClientRect();
    // getClientRects()[0] is the sentence's first line, not the multi-line bounding box.
    const scale = rect.height / (a.offsetHeight || 1) || 1;
    const oldSpans = [...a.querySelectorAll<HTMLElement>("[data-change]")];
    const newSpans = [...b.querySelectorAll<HTMLElement>("[data-change]")];
    const triggers = oldSpans.map((s) => {
      const y =
        ((s.getClientRects()[0]?.top ?? rect.top) - rect.top) / scale + 6;
      let lo = 0,
        hi: number = P.sweep;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (sweepEase(mid / P.sweep) * height < y) lo = mid;
        else hi = mid;
      }
      return P.washIn + hi;
    });
    let frame = 0;
    const draw = () => {
      const u = performance.now() - edit.start;
      const direct = edit.reduced || !edit.sweep;
      const endSwap = direct
        ? P.direct
        : Math.max(0, ...triggers) + P.swapInDelay + P.swapIn;
      oldSpans.forEach((s, i) => {
        const t = u - (direct ? 0 : triggers[i]);
        s.style.opacity = String(
          direct ? (u < P.direct ? 1 : 0) : 1 - outEase(t / P.swapOut),
        );
        newSpans[i].style.opacity = String(
          direct
            ? u < P.direct
              ? 0
              : 1
            : inEase((t - P.swapInDelay) / P.swapIn),
        );
      });
      el.style.height = `${direct ? (u < P.direct ? oldHeight : newHeight) : oldHeight + (newHeight - oldHeight) * inEase((u - endSwap) / P.swapOut)}px`;
      if (w) {
        const fade = edit.reduced ? P.reducedHold : P.washIn + P.sweep + P.hold;
        w.style.height = `${edit.reduced ? height : sweepEase((u - P.washIn) / P.sweep) * height}px`;
        w.style.opacity = String(
          (edit.reduced ? Number(u >= 0) : inEase(u / P.washIn)) *
            (1 -
              inEase((u - fade) / (edit.reduced ? P.reducedOut : P.washOut))),
        );
      }
      if (u >= editDuration(edit)) {
        setFinished(edit);
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      el.style.removeProperty("height");
    };
  }, [edit, before, after]);

  return (
    <p
      ref={root}
      className={`${className}${edit ? " agent-edit-prose" : ""}`}
      data-agent-edit={
        edit
          ? edit.reduced
            ? "reduced"
            : edit.sweep
              ? "sweep"
              : "direct"
          : undefined
      }
    >
      {edit && <span className="sr-only">{after}</span>}
      {edit?.sweep && (
        <span
          ref={wash}
          className={`agent-edit-wash${edit.reduced ? " reduced" : ""}`}
          aria-hidden="true"
        />
      )}
      <span
        ref={old}
        className={edit ? "agent-edit-old" : undefined}
        aria-hidden={edit ? true : undefined}
      >
        {edit
          ? chunks.flatMap((c, i) =>
              c.old[0] === c.next[0]
                ? [<span key={c.next[0].key}>{c.next[0].text}</span>]
                : [
                    <span key={`change-${i}`} data-change="">
                      {c.old.map((s) => s.text).join("")}
                    </span>,
                  ],
            )
          : sentences(after).map((s) => <span key={s.key}>{s.text}</span>)}
      </span>
      {edit && (
        <span ref={next} className="agent-edit-new" aria-hidden="true">
          {chunks.map((c, i) =>
            c.old[0] === c.next[0] ? (
              // Invisible layout placeholders: unchanged text exists only in the old text layer.
              <span
                key={i}
                className="agent-edit-placeholder"
                data-text={c.next[0].text}
              />
            ) : (
              <span key={i} data-change="">
                {c.next.map((s) => s.text).join("")}
              </span>
            ),
          )}
        </span>
      )}
    </p>
  );
}
