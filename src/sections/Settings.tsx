import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { HotkeyCapture } from "../components/HotkeyCapture";
import { ModelManager } from "../components/ModelManager";
import { Toggle } from "../components/Toggle";
import {
  checkForUpdates,
  installUpdate,
  listAudioDevices,
  patchForUiMode,
  uiModeOf,
  type Config,
} from "../lib/ipc";
import { LANGUAGES } from "../lib/languages";
import { useConfig } from "../state/ConfigContext";

type Tab = "general" | "transcription" | "overlay" | "account";
const TABS: { key: Tab; label: string }[] = [
  { key: "general", label: "Allgemein" },
  { key: "transcription", label: "Transkription" },
  { key: "overlay", label: "Overlay" },
  { key: "account", label: "Account" },
];

function Row({ name, hint, children }: { name: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="meta">
        <div className="name">{name}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Sel({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function Settings() {
  const { config, patch, reload, save, savedTick } = useConfig();
  const [tab, setTab] = useState<Tab>("general");
  const [devices, setDevices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");
  const [foundUpdate, setFoundUpdate] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => {});
  }, []);

  // Flash a brief "Gespeichert ✓" after each auto-save (no manual save button).
  useEffect(() => {
    if (!savedTick) return;
    setShowSaved(true);
    const id = window.setTimeout(() => setShowSaved(false), 1400);
    return () => window.clearTimeout(id);
  }, [savedTick]);

  if (!config) return null;
  const c = config;
  const set = <K extends keyof Config>(k: K, v: Config[K]) => patch({ [k]: v } as Partial<Config>);

  const doLogin = async () => {
    setBusy(true);
    try {
      await invoke("login");
      await reload();
    } catch (e) {
      console.error("login failed", e);
    } finally {
      setBusy(false);
    }
  };
  const doLogout = async () => {
    await invoke("logout").catch(() => {});
    await reload();
  };
  const doUpdate = async () => {
    setUpdateMsg("Suche…");
    setFoundUpdate(null);
    try {
      const v = await checkForUpdates();
      if (v) {
        setFoundUpdate(v);
        setUpdateMsg(`Update verfügbar: v${v}`);
      } else {
        setUpdateMsg("Aktuell — kein Update");
      }
    } catch (e) {
      setUpdateMsg(`Fehler: ${String(e)}`);
    }
  };
  const doInstall = async () => {
    setUpdating(true);
    setUpdateMsg("Wird installiert… Echo startet gleich automatisch neu.");
    try {
      await installUpdate(); // on success the app relaunches; never returns
    } catch (e) {
      setUpdateMsg(`Fehler: ${String(e)}`);
      setUpdating(false);
    }
  };

  return (
    <div>
      <h1 className="section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        Einstellungen
        <span
          aria-live="polite"
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            color: "#22d3ee",
            background: "rgba(34,211,238,0.12)",
            border: "1px solid rgba(34,211,238,0.35)",
            borderRadius: 999,
            padding: "3px 10px",
            opacity: showSaved ? 1 : 0,
            transform: showSaved ? "translateY(0)" : "translateY(-2px)",
            transition: "opacity 0.25s ease, transform 0.25s ease",
            pointerEvents: "none",
          }}
        >
          Gespeichert ✓
        </span>
      </h1>
      <div className="sub-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`sub-tab ${t.key === tab ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === "general" && (
          <>
            <Row name="Aufnahme-Modus" hint="Halten (Push-to-Talk) oder Umschalten">
              <Sel
                value={c.recording_mode}
                onChange={(v) => set("recording_mode", v)}
                options={[
                  ["hold", "Halten"],
                  ["toggle", "Umschalten"],
                ]}
              />
            </Row>
            <Row name="Hotkey" hint="Klicken, dann Tastenkombination drücken">
              <HotkeyCapture value={c.hotkey} onChange={(v) => set("hotkey", v)} />
            </Row>
            <Row name="Mikrofon">
              <Sel
                value={c.mic_device_name || ""}
                onChange={(v) => set("mic_device_name", v)}
                options={[["", "System-Standard"], ...devices.map((d): [string, string] => [d, d])]}
              />
            </Row>
            <Row name="Auto-Paste" hint="Text nach der Transkription einfügen">
              <Toggle checked={c.autopaste} onChange={(v) => set("autopaste", v)} />
            </Row>
            <Row name="Fenster-Fokus merken" hint="Ins zuletzt fokussierte Fenster einfügen">
              <Toggle checked={c.target_lock} onChange={(v) => set("target_lock", v)} />
            </Row>
            <Row name="Bubble anzeigen">
              <Toggle checked={c.show_bubble} onChange={(v) => set("show_bubble", v)} />
            </Row>
            <Row name="Sounds">
              <Toggle checked={c.sound_enabled} onChange={(v) => set("sound_enabled", v)} />
            </Row>
            <Row name="Lautstärke">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={c.sound_volume}
                onChange={(e) => set("sound_volume", parseFloat(e.target.value))}
              />
            </Row>
            <Row name="Design">
              <Sel
                value={c.ui_theme}
                onChange={(v) => set("ui_theme", v)}
                options={[
                  ["dark", "Dunkel"],
                  ["light", "Hell"],
                ]}
              />
            </Row>
            <Row name="Oberflächen-Sprache">
              <Sel
                value={c.ui_language}
                onChange={(v) => set("ui_language", v)}
                options={[
                  ["de", "Deutsch"],
                  ["en", "English"],
                ]}
              />
            </Row>
          </>
        )}

        {tab === "transcription" && (
          <>
            <Row name="Modus" hint="Lokal (privat) · Cloud (DSGVO) · Superfast">
              <div style={{ flex: 1, maxWidth: 360 }}>
                <BigModeSwitch value={uiModeOf(c)} onChange={(m) => patch(patchForUiMode(m))} />
              </div>
            </Row>
            <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div className="meta">
                <div className="name">Lokales Modell</div>
                <div className="hint">
                  Klick wählt + lädt das Modell (mit GPU ruhig groß — large-v3-turbo).
                </div>
              </div>
              <ModelManager />
            </div>
            <Row name="Transkriptions-Sprache" hint='"Automatisch erkennen" für gemischte Sprachen'>
              <Sel value={c.language} onChange={(v) => set("language", v)} options={LANGUAGES} />
            </Row>
            <Row name="Cloud-Qualität">
              <Sel
                value={c.cloud_quality_mode}
                onChange={(v) => set("cloud_quality_mode", v)}
                options={[
                  ["quality", "Qualität"],
                  ["fast", "Schnell"],
                  ["instant", "Instant"],
                  ["auto", "Auto"],
                ]}
              />
            </Row>
            <Row name="Live-Text" hint="Phrasen schon beim Sprechen tippen (experimentell)">
              <Toggle checked={c.live_type} onChange={(v) => set("live_type", v)} />
            </Row>
            <Row name="DACH-Formatierung" hint="Abkürzungen, Währung, „deutsche“ Anführungszeichen">
              <Toggle checked={c.dach_format_enabled} onChange={(v) => set("dach_format_enabled", v)} />
            </Row>
            <Row name="KI-Cleanup">
              <Toggle checked={c.cleanup_enabled} onChange={(v) => set("cleanup_enabled", v)} />
            </Row>
            <Row name="Cleanup-Stil">
              <Sel
                value={c.cleanup_style}
                onChange={(v) => set("cleanup_style", v)}
                options={[
                  ["prompt", "Prompt"],
                  ["email", "E-Mail"],
                  ["slack", "Slack"],
                  ["formal", "Formal"],
                ]}
              />
            </Row>
          </>
        )}

        {tab === "overlay" && (
          <>
            <Row name="Orb-Overlay anzeigen">
              <Toggle checked={c.use_orb_overlay} onChange={(v) => set("use_orb_overlay", v)} />
            </Row>
            <Row name="Stil">
              <Sel
                value={c.orb_overlay_style}
                onChange={(v) => set("orb_overlay_style", v)}
                options={[
                  ["ping", "Ping (Echo-Ringe)"],
                  ["sphere", "Sphere"],
                  ["sonar", "Sonar"],
                  ["bars", "Bars"],
                  ["wave", "Wave"],
                  ["classic", "Classic"],
                ]}
              />
            </Row>
            <Row name="Farbe">
              <Sel
                value={c.orb_color_theme}
                onChange={(v) => set("orb_color_theme", v)}
                options={[
                  ["cyan", "Cyan"],
                  ["violet", "Violet"],
                  ["mint", "Mint"],
                ]}
              />
            </Row>
            <Row name="Position">
              <Sel
                value={c.orb_position}
                onChange={(v) => set("orb_position", v)}
                options={[
                  ["bottom-center", "Unten Mitte"],
                  ["bottom-left", "Unten Links"],
                  ["bottom-right", "Unten Rechts"],
                  ["top-center", "Oben Mitte"],
                  ["top-left", "Oben Links"],
                  ["top-right", "Oben Rechts"],
                ]}
              />
            </Row>
            <Row name="Größe">
              <Sel
                value={String(c.orb_overlay_size)}
                onChange={(v) => set("orb_overlay_size", parseFloat(v))}
                options={[
                  ["0.5", "0.5×"],
                  ["1", "1×"],
                  ["1.5", "1.5×"],
                  ["2", "2×"],
                  ["3", "3×"],
                ]}
              />
            </Row>
            <Row name="Idle-Puls">
              <Toggle checked={c.orb_idle_pulse} onChange={(v) => set("orb_idle_pulse", v)} />
            </Row>
            <Row name="Im Leerlauf verstecken">
              <Toggle checked={c.orb_overlay_auto_hide} onChange={(v) => set("orb_overlay_auto_hide", v)} />
            </Row>
          </>
        )}

        {tab === "account" && (
          <>
            <Row
              name="Konto"
              hint={c.account_email || "Mit auth.subunit.ai anmelden für Cloud-Transkription"}
            >
              {c.account_email ? (
                <button className="sub-tab" onClick={doLogout}>
                  Abmelden
                </button>
              ) : (
                <button className="sub-tab" onClick={doLogin} disabled={busy}>
                  {busy ? "Browser geöffnet…" : "Anmelden"}
                </button>
              )}
            </Row>
            <Row name="Plan">
              <span style={{ textTransform: "uppercase", fontWeight: 700 }}>{c.plan}</span>
            </Row>
            <Row name="Speaker-Diarization" hint="Wer-spricht-wann bei langen Aufnahmen (Server)">
              <Toggle checked={c.diarization_enabled} onChange={(v) => set("diarization_enabled", v)} />
            </Row>
            <Row name="In Synapse speichern" hint="Transkripte in die Wissensbasis schreiben">
              <Toggle checked={c.synapse_save_enabled} onChange={(v) => set("synapse_save_enabled", v)} />
            </Row>
            <Row name="Verlauf speichern">
              <Toggle checked={c.history_enabled} onChange={(v) => set("history_enabled", v)} />
            </Row>
            <Row name="Auto-Update">
              <Toggle checked={c.auto_update_check} onChange={(v) => set("auto_update_check", v)} />
            </Row>
            <Row name="Updates" hint={updateMsg}>
              {foundUpdate ? (
                <button className="sub-tab" onClick={doInstall} disabled={updating}>
                  {updating ? "Installiere…" : `Jetzt installieren (v${foundUpdate})`}
                </button>
              ) : (
                <button className="sub-tab" onClick={doUpdate}>
                  Nach Updates suchen
                </button>
              )}
            </Row>
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 14,
          marginTop: 18,
        }}
      >
        <span style={{ fontSize: "0.78rem", color: "var(--muted, #93a4bd)" }}>
          Änderungen werden automatisch gespeichert
        </span>
        <button
          onClick={() => save()}
          style={{
            border: "1px solid rgba(34,211,238,0.5)",
            background: showSaved ? "rgba(34,211,238,0.18)" : "rgba(34,211,238,0.1)",
            color: "#22d3ee",
            fontWeight: 700,
            fontSize: "0.85rem",
            padding: "9px 22px",
            borderRadius: 10,
            cursor: "pointer",
            transition: "background 0.15s ease, transform 0.08s ease",
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.96)")}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
        >
          {showSaved ? "Gespeichert ✓" : "Speichern"}
        </button>
      </div>
    </div>
  );
}
