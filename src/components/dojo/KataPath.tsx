import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  kataRecordCancel,
  kataRecordLevel,
  kataRecordStart,
  kataRecordStop,
  PROMPT_RUBRIC_KEYS,
  type KataInfo,
  type KataList,
  type KataResult,
} from "../../lib/ipc";
import { HankoSeal } from "./HankoSeal";

// ── Local stroke glyphs (enterprise UI: no emojis, no CJK) ──
const LockGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const CheckGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** Which of the five rubric lamps is the kata's focus (highlighted): a single
 *  criterion, ALL five (the master exam), or none (few-shot, which is not a
 *  rubric lamp). Mirrors the §5 `focus` contract. */
function focusLamps(focus: string): Set<string> {
  if (focus === "all") return new Set(PROMPT_RUBRIC_KEYS);
  if ((PROMPT_RUBRIC_KEYS as readonly string[]).includes(focus)) return new Set([focus]);
  return new Set();
}

/** The Kata-Schriftrolle: the teaching scroll for one kata — the lesson, the
 *  contrasting good/bad example cards, the mission, and the Start CTA. */
function KataScroll({
  kata,
  onStart,
  onClose,
}: {
  kata: KataInfo;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const base = `learning.kata.${kata.id}`;
  const good = t(`${base}.good`);
  const bad = t(`${base}.bad`);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card kata-scroll" onClick={(e) => e.stopPropagation()}>
        <div className="kata-scroll-rod kata-scroll-rod--top" aria-hidden="true" />
        <div className="kata-scroll-body">
          <div className="kata-scroll-eyebrow">
            {t("learning.kata.stationLabel", { idx: kata.idx })}
          </div>
          <h3 className="kata-scroll-title">{t(`${base}.title`)}</h3>

          <span className="kata-lesson-label">{t("learning.kata.teachLabel")}</span>
          <p className="kata-scroll-teach">{t(`${base}.teach`)}</p>

          <div className="kata-examples">
            {good && good !== "—" && (
              <div className="kata-example kata-example--good">
                <span className="kata-example-tag">{t("learning.kata.goodLabel")}</span>
                <p className="kata-example-text">{good}</p>
              </div>
            )}
            {bad && bad !== "—" && (
              <div className="kata-example kata-example--bad">
                <span className="kata-example-tag">{t("learning.kata.badLabel")}</span>
                <p className="kata-example-text">{bad}</p>
              </div>
            )}
          </div>

          <div className="kata-mission">
            <span className="kata-mission-label">{t("learning.kata.missionLabel")}</span>
            <p className="kata-mission-text">{t(`${base}.mission`)}</p>
          </div>

          {kata.id === "master" && (
            <p className="kata-master-hint">{t("learning.kata.masterHint")}</p>
          )}

          <div className="confirm-actions">
            <button className="confirm-btn" onClick={onClose}>
              {t("common.close")}
            </button>
            <button className="confirm-btn primary kata-start-btn" onClick={onStart}>
              {t("learning.kata.startBtn")}
            </button>
          </div>
        </div>
        <div className="kata-scroll-rod kata-scroll-rod--bottom" aria-hidden="true" />
      </div>
    </div>
  );
}

/** The recording overlay — a 1:1 mirror of the Dojo record modal: arm the
 *  recorder, poll the mic level for the pulsing orb, count down against a fixed
 *  deadline (auto-stop at 0), lift the recorder on cancel/stop, and cancel a
 *  stranded take on unmount. Only the IPC (kata_record_*) + the 60 s budget
 *  differ. */
function KataRecordModal({
  kata,
  seconds,
  onCancel,
  onResult,
  toastErr,
}: {
  kata: KataInfo;
  seconds: number;
  onCancel: () => void;
  onResult: (r: KataResult) => void;
  toastErr: (m: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"starting" | "recording" | "transcribing" | "error">("starting");
  const [level, setLevel] = useState(0);
  const [remaining, setRemaining] = useState(seconds);
  const started = useRef(false);
  const stopping = useRef(false);
  const done = useRef(false);
  const deadline = useRef<number | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    kataRecordStart(kata.id)
      .then(() => setPhase("recording"))
      .catch((e) => {
        done.current = true;
        setPhase("error");
        const s = String(e);
        toastErr(
          s.includes("busy")
            ? t("learning.kata.busyError")
            : s.includes("locked")
              ? t("learning.kata.lockedError")
              : t("learning.kata.recordFailed") + " (" + s + ")",
        );
        onCancel();
      });
  }, [kata.id, t, toastErr, onCancel]);

  // Safety net: cancel if torn down mid-take (e.g. a sidebar switch).
  useEffect(() => () => {
    if (!done.current) kataRecordCancel().catch(() => {});
  }, []);

  const stop = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    done.current = true;
    setPhase("transcribing");
    try {
      const r = await kataRecordStop(kata.id);
      onResult(r);
    } catch (e) {
      toastErr(t("learning.kata.transcribeFailed") + " (" + String(e) + ")");
      onCancel();
    }
  }, [kata.id, onResult, onCancel, toastErr, t]);

  const cancel = useCallback(async () => {
    done.current = true;
    await kataRecordCancel().catch(() => {});
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    if (phase !== "recording") {
      deadline.current = null;
      return;
    }
    if (deadline.current === null) deadline.current = Date.now() + seconds * 1000;
    const lv = window.setInterval(() => {
      kataRecordLevel().then(setLevel).catch(() => {});
    }, 80);
    const tm = window.setInterval(() => {
      const left = Math.ceil((deadline.current! - Date.now()) / 1000);
      setRemaining(Math.max(0, left));
      if (left <= 0) void stop();
    }, 250);
    return () => {
      window.clearInterval(lv);
      window.clearInterval(tm);
    };
  }, [phase, seconds, stop]);

  const scale = 1 + Math.min(level, 1) * 0.5;

  return (
    <div className="modal-backdrop" onClick={phase === "recording" ? undefined : cancel}>
      <div className="modal-card dojo-modal kata-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{t(`learning.kata.${kata.id}.title`)}</h3>
        <p className="kata-rec-mission">{t(`learning.kata.${kata.id}.mission`)}</p>

        <div className="dojo-rec-stage">
          <div className="dojo-rec-orb" style={{ transform: `scale(${scale})` }} />
          {phase === "transcribing" ? (
            <div className="dojo-rec-status">{t("learning.kata.recording.transcribing")}</div>
          ) : phase === "starting" ? (
            <div className="dojo-rec-status">{t("learning.kata.recording.starting")}</div>
          ) : (
            <div className="dojo-rec-count">{remaining}</div>
          )}
        </div>

        <div className="confirm-actions">
          <button className="confirm-btn" onClick={cancel} disabled={phase === "transcribing"}>
            {t("common.cancel")}
          </button>
          <button className="confirm-btn primary" onClick={stop} disabled={phase !== "recording"}>
            {t("learning.kata.recording.stopBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The verdict: the Hanko seal (score), the five rubric lamps (the focus lamp
 *  raised), the pass/fail line, the collapsible raw transcript, a first-pass
 *  brush-check celebration, a belt-up ceremony banner, and retry/close. */
function KataResultView({
  kata,
  result,
  onClose,
  onAgain,
}: {
  kata: KataInfo;
  result: KataResult;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { t } = useTranslation();
  const [showTranscript, setShowTranscript] = useState(false);
  const focus = focusLamps(kata.focus);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card dojo-modal kata-result" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{t("learning.kata.resultTitle")}</h3>

        {result.belt_up && (
          <div className="obi-ceremony" role="status">
            <span className="obi-ceremony-title">{t("learning.dojoWorld.ceremony.title")}</span>
            <span className="obi-ceremony-body">
              {t("learning.dojoWorld.ceremony.body", {
                rank: t(`learning.dojoWorld.belt.${result.belt_up}`),
              })}
            </span>
          </div>
        )}

        <div className="kata-result-stage">
          <HankoSeal score={result.score} size={112} />
          <div className={`kata-verdict ${result.passed ? "is-pass" : "is-fail"}`}>
            {result.passed ? t("learning.kata.passed") : t("learning.kata.failed")}
          </div>
        </div>

        {result.first_pass && (
          <div className="kata-celebrate" role="status">
            <svg className="kata-celebrate-svg" viewBox="0 0 120 40" aria-hidden="true">
              <path className="kata-celebrate-stroke" pathLength={1} d="M12 24 C 30 30, 40 34, 50 30 C 66 24, 84 8, 108 10" />
            </svg>
            <span className="kata-celebrate-text">{t("learning.kata.firstPass")}</span>
          </div>
        )}

        <div className="kata-lamps">
          {PROMPT_RUBRIC_KEYS.map((k) => {
            const on = !!result.rubric[k];
            const isFocus = focus.has(k);
            return (
              <div
                key={k}
                className={`kata-lamp ${on ? "on" : "off"}${isFocus ? " is-focus" : ""}`}
              >
                <span className="kata-lamp-dot" aria-hidden="true" />
                <span className="kata-lamp-name">{t(`learning.prompts.rubric.${k}.name`)}</span>
              </div>
            );
          })}
        </div>

        <div className={`dojo-xp-line ${result.xp_awarded > 0 ? "earned" : "already"}`}>
          {result.xp_awarded > 0
            ? t("learning.kata.xpAwarded", { xp: result.xp_awarded })
            : t("learning.kata.xpNone")}
        </div>

        <button
          type="button"
          className="dojo-transcript-toggle"
          aria-expanded={showTranscript}
          onClick={() => setShowTranscript((v) => !v)}
        >
          {showTranscript ? t("learning.kata.transcriptHide") : t("learning.kata.transcriptShow")}
        </button>
        {showTranscript && <p className="dojo-transcript kata-transcript">{result.transcript.trim() || "—"}</p>}

        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="confirm-btn primary" onClick={onAgain}>
            {t("learning.kata.retryBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One stepping-stone station on the vertical path. done = filled disc + brush
 *  check + best score; open = pulsing ring + index, clickable; locked = pale
 *  disc + lock, inert. */
function KataStation({ kata, onOpen }: { kata: KataInfo; onOpen: () => void }) {
  const { t } = useTranslation();
  const base = `learning.kata.${kata.id}`;
  const interactive = kata.state !== "locked";

  const stone = (
    <span className={`kata-stone kata-stone--${kata.state}`} aria-hidden="true">
      <span className="kata-stone-ring" />
      {kata.state === "done" ? (
        <span className="kata-stone-mark"><CheckGlyph /></span>
      ) : kata.state === "locked" ? (
        <span className="kata-stone-mark"><LockGlyph /></span>
      ) : (
        <span className="kata-stone-idx">{kata.idx}</span>
      )}
    </span>
  );

  const body = (
    <span className="kata-station-body">
      <span className="kata-station-title">{t(`${base}.title`)}</span>
      <span className="kata-station-meta">
        {kata.state === "done"
          ? t("learning.kata.bestLabel", { score: kata.best_score })
          : kata.state === "open"
            ? t("learning.kata.thresholdLabel", { score: kata.threshold })
            : t("learning.kata.lockedHint")}
      </span>
    </span>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={`kata-station is-${kata.state}`}
        onClick={onOpen}
        aria-label={t(`${base}.title`)}
      >
        {stone}
        {body}
      </button>
    );
  }
  return (
    <div className={`kata-station is-${kata.state}`} aria-disabled="true">
      {stone}
      {body}
    </div>
  );
}

/** The Kata-Pfad — the heart of the Prompt hall. A vertical brush-stroke path
 *  with seven stepping-stone stations. Tapping a done/open station opens its
 *  scroll → recording → verdict. `onResult` lets the parent refresh the belt +
 *  station states (and play the stage promotion sweep) after every take. */
export function KataPath({
  data,
  onResult,
  toastErr,
}: {
  data: KataList;
  onResult: (r: KataResult) => void;
  toastErr: (m: string) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<KataInfo | null>(null);
  const [phase, setPhase] = useState<"scroll" | "recording" | "result">("scroll");
  const [result, setResult] = useState<KataResult | null>(null);

  return (
    <div className="kata-path">
      <div className="kata-path-head">
        <h3 className="kata-path-title">{t("learning.kata.pathTitle")}</h3>
        <p className="kata-path-sub">{t("learning.kata.pathSub")}</p>
      </div>

      <div className="kata-path-body">
        <svg className="kata-path-line" viewBox="0 0 20 700" preserveAspectRatio="none" aria-hidden="true">
          <path
            className="kata-path-line-stroke"
            pathLength={1}
            d="M10 6 C 6 100, 14 200, 10 300 S 6 500, 10 694"
          />
        </svg>
        <div className="kata-stations">
          {data.katas.map((k) => (
            <KataStation
              key={k.id}
              kata={k}
              onOpen={() => {
                setSelected(k);
                setResult(null);
                setPhase("scroll");
              }}
            />
          ))}
        </div>
      </div>

      {selected && phase === "scroll" && (
        <KataScroll
          kata={selected}
          onStart={() => setPhase("recording")}
          onClose={() => setSelected(null)}
        />
      )}
      {selected && phase === "recording" && (
        <KataRecordModal
          kata={selected}
          seconds={data.seconds}
          onCancel={() => {
            setSelected(null);
            setPhase("scroll");
          }}
          onResult={(r) => {
            setResult(r);
            setPhase("result");
            onResult(r);
          }}
          toastErr={toastErr}
        />
      )}
      {selected && phase === "result" && result && (
        <KataResultView
          kata={selected}
          result={result}
          onClose={() => {
            setSelected(null);
            setPhase("scroll");
          }}
          onAgain={() => {
            setResult(null);
            setPhase("recording");
          }}
        />
      )}
    </div>
  );
}
