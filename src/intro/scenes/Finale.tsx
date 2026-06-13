import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keyName, modifierName, parseCombo } from "../../lib/hotkeys";
import { onState } from "../../lib/ipc";
import { useConfig } from "../../state/ConfigContext";
import { VirtualKeyboard, keyLabel } from "../VirtualKeyboard";
import { VoiceCanvas } from "../VoiceCanvas";
import { useTypewriter } from "../useTypewriter";
import type { SceneProps } from "../Intro";

type Phase = "idle" | "recording" | "transcribing" | "done" | "error";

// The magic moment: a real first dictation inside the intro. The global hotkey
// is still suspended, so the combo arrives as plain DOM events — hold it to
// record, release to transcribe via `transcribe_preview` (no injection, no
// history), and the transcript types itself into the glass card.
export function Finale({ finish }: SceneProps) {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [partial, setPartial] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const hadPartial = useRef(false);
  // Synchronous re-entry guard: keyup + window-blur can fire in the same tick,
  // and phaseRef only updates after the re-render — without this, a double
  // stop() would run transcribe_preview twice and the second call's
  // "no_recording" error would overwrite a perfectly good transcript.
  const stopping = useRef(false);

  const combo = useMemo(() => parseCombo(config?.hotkey ?? ""), [config?.hotkey]);
  const comboKey = combo.find((k) => !["ctrl", "shift", "alt", "cmd"].includes(k)) ?? "";
  const comboMods = useMemo(
    () => combo.filter((k) => ["ctrl", "shift", "alt", "cmd"].includes(k)),
    [combo],
  );

  useEffect(() => {
    const matchesKey = (e: KeyboardEvent) => keyName(e) === comboKey;
    const modsHeld = (e: KeyboardEvent) =>
      comboMods.every(
        (m) =>
          (m === "ctrl" && e.ctrlKey) ||
          (m === "shift" && e.shiftKey) ||
          (m === "alt" && e.altKey) ||
          (m === "cmd" && e.metaKey),
      );

    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (phaseRef.current === "recording" || phaseRef.current === "transcribing") return;
      if (!matchesKey(e) || !modsHeld(e)) return;
      e.preventDefault();
      stopping.current = false;
      setErrMsg(null);
      setText("");
      setPartial("");
      hadPartial.current = false;
      setPhase("recording");
      invoke("start_recording").catch(() => {});
      // Live partials: the recording streams to the server over one WebSocket
      // and partial transcripts flow back while you're still speaking.
      invoke("intro_stream_start").catch(() => {});
    };

    const stop = async () => {
      if (stopping.current) return;
      stopping.current = true;
      setPhase("transcribing");
      setAttempted(true);
      // No stream_stop here — transcribe_preview FINISHES the stream: it
      // flushes the audio tail and takes the server's final without
      // re-uploading. Cancelling first would throw that away.
      try {
        const result = await invoke<string>("transcribe_preview");
        setText(result);
        setPhase("done");
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (err?.code === "empty" || err?.code === "no_recording") {
          setErrMsg(t("intro.finaleNothingHeard"));
        } else {
          setErrMsg(t("intro.finaleError", { detail: err?.message ?? String(e) }));
        }
        setPhase("error");
      }
    };

    const up = (e: KeyboardEvent) => {
      if (phaseRef.current !== "recording") return;
      // Releasing ANY part of the combo ends the take (hold semantics).
      const token = modifierName(e.key) ?? keyName(e);
      if (token && (token === comboKey || comboMods.includes(token))) {
        e.preventDefault();
        void stop();
      }
    };

    // Window lost focus mid-hold → treat as release so nothing keeps recording.
    const blur = () => {
      if (phaseRef.current === "recording") void stop();
    };

    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [comboKey, comboMods, t]);

  // Live partials stream in while recording — and during "transcribing",
  // where a late lookahead can still land while the final computes. Once the
  // phase is done/error the final owns the card.
  useEffect(() => {
    const sub = listen<string>("echo://stream-partial", (e) => {
      if (phaseRef.current !== "recording" && phaseRef.current !== "transcribing") return;
      hadPartial.current = true;
      setPartial(e.payload);
    });
    return () => {
      sub.then((un) => un());
    };
  }, []);

  // Mic-open failures (no device / busy / permission) surface as engine error
  // states, not as a transcribe_preview rejection — without this listener a
  // dead mic would read as a confusing "nothing heard" after release.
  useEffect(() => {
    const sub = onState((p) => {
      if (p.state === "error" && phaseRef.current === "recording" && p.detail) {
        setErrMsg(p.detail);
        setPhase("error");
        invoke("intro_stream_stop").catch(() => {});
      }
    });
    return () => {
      sub.then((un) => un());
    };
  }, []);

  // Never strand a recording (or its partial stream) when the scene goes away.
  useEffect(
    () => () => {
      invoke("intro_stream_stop").catch(() => {});
      if (phaseRef.current === "recording") {
        invoke("cancel_recording").catch(() => {});
      }
    },
    [],
  );

  // Typewriter only when nothing streamed live — after watching your words
  // appear in real time, re-typing the final text would feel like a rewind.
  const typed = useTypewriter(phase === "done" && !hadPartial.current ? text : "", { cps: 28 });
  const pressedSet = useMemo(
    () => (phase === "recording" ? new Set(combo) : new Set<string>()),
    [phase, combo],
  );

  if (!config) return null;

  return (
    <>
      <h1 className="intro-title">{t("intro.finaleTitle")}</h1>
      <p className="intro-body">
        {t("intro.finaleHint")}{" "}
        <span className="intro-chips">
          {combo.map((k, i) => (
            <span className="intro-chip" key={`${k}-${i}`}>
              {keyLabel(k)}
            </span>
          ))}
        </span>{" "}
        {t("intro.finaleHint2")}
      </p>
      <VoiceCanvas active={phase === "recording"} height={96} />
      <div className={`intro-transcript ${text || partial ? "" : "is-empty"}`}>
        {phase === "recording" ? (
          partial ? (
            <span className="intro-caret">{partial}</span>
          ) : (
            t("intro.finaleListening")
          )
        ) : phase === "transcribing" ? (
          // Keep the last live partial on screen while the final lands —
          // the text "settles" instead of blinking through a status line.
          partial ? (
            <span className="intro-caret">{partial}</span>
          ) : (
            t("intro.finaleTranscribing")
          )
        ) : phase === "done" ? (
          hadPartial.current ? (
            text
          ) : (
            typed.shown
          )
        ) : partial ? (
          // Error after live partials: keep the user's words on screen (the
          // hint below explains) instead of wiping them with an error line.
          partial
        ) : (
          (errMsg ?? "…")
        )}
      </div>
      {phase === "done" && (hadPartial.current || typed.done) && (
        <p className="intro-hint intro-fade-late">{t("intro.finaleSuccess")}</p>
      )}
      {phase === "error" && (
        <p className="intro-hint">
          {partial && errMsg ? `${errMsg} · ` : ""}
          {t("intro.finaleSkipHint")}
        </p>
      )}
      <div className="intro-nav">
        {attempted ? (
          <button type="button" className="intro-btn" onClick={finish}>
            {t("intro.finish")}
          </button>
        ) : (
          <button type="button" className="intro-ghost" onClick={finish}>
            {t("intro.finishWithout")}
          </button>
        )}
      </div>
      {/* Mini keyboard mirrors the hold so the combo feels tangible. */}
      <div style={{ width: "min(480px, 92%)", opacity: 0.85 }}>
        <VirtualKeyboard pressed={pressedSet} highlighted={new Set(combo)} />
      </div>
    </>
  );
}
