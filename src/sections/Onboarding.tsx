import { useState } from "react";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { BrandMark } from "../components/BrandMark";
import { Toggle } from "../components/Toggle";
import { patchForUiMode, uiModeOf } from "../lib/ipc";
import { LANGUAGES } from "../lib/languages";
import { useConfig } from "../state/ConfigContext";

const LAST = 3;

export function Onboarding() {
  const { config, patch } = useConfig();
  const [step, setStep] = useState(0);
  if (!config) return null;

  return (
    <div className="onb">
      <div className="onb-card">
        {step === 0 && (
          <>
            <BrandMark size={56} />
            <h1>Willkommen bei Echo</h1>
            <p>Drücken &amp; sprechen — den Rest übernehmen wir.</p>
          </>
        )}
        {step === 1 && (
          <>
            <h1>Dein Hotkey</h1>
            <p>
              Halte <b>{config.hotkey}</b> gedrückt und sprich. Loslassen = fertig, der Text
              landet direkt im aktiven Fenster.
            </p>
            <p className="hint">Jederzeit in den Einstellungen änderbar.</p>
          </>
        )}
        {step === 2 && (
          <>
            <h1>Lokal, Cloud oder Superfast?</h1>
            <p className="hint">Lokal = 100% privat · Cloud = DSGVO-Server · Superfast = ultraschnell.</p>
            <BigModeSwitch value={uiModeOf(config)} onChange={(m) => patch(patchForUiMode(m))} />
          </>
        )}
        {step === 3 && (
          <>
            <h1>Sprache &amp; Features</h1>
            <div className="onb-row">
              <span>Transkriptions-Sprache</span>
              <select value={config.language} onChange={(e) => patch({ language: e.target.value })}>
                {LANGUAGES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="onb-row">
              <span>Auto-Paste</span>
              <Toggle checked={config.autopaste} onChange={(v) => patch({ autopaste: v })} />
            </div>
            <div className="onb-row">
              <span>KI-Cleanup</span>
              <Toggle checked={config.cleanup_enabled} onChange={(v) => patch({ cleanup_enabled: v })} />
            </div>
          </>
        )}

        <div className="onb-dots">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
        <div className="onb-nav">
          {step > 0 ? (
            <button className="sub-tab" onClick={() => setStep(step - 1)}>
              Zurück
            </button>
          ) : (
            <span />
          )}
          {step < LAST ? (
            <button className="sub-tab onb-primary" onClick={() => setStep(step + 1)}>
              Weiter
            </button>
          ) : (
            <button
              className="sub-tab onb-primary"
              onClick={() => patch({ has_seen_onboarding: true })}
            >
              Fertig
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
