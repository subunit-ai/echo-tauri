import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { HotkeyCapture } from "../components/HotkeyCapture";
import { ModelManager } from "../components/ModelManager";
import { Toggle } from "../components/Toggle";
import {
  appVersion,
  checkForUpdates,
  installUpdate,
  listAudioDevices,
  openConfigDir,
  openExternal,
  setAutostart,
  patchForUiMode,
  uiModeOf,
  type Config,
} from "../lib/ipc";
import { LANGUAGES } from "../lib/languages";
import { SOUND_PRESETS, playSound } from "../lib/sounds";
import { SUPPORTED_LANGUAGES, setLanguage } from "../i18n";
import { useConfig } from "../state/ConfigContext";

type Tab = "general" | "transcription" | "overlay" | "account";
const TABS: { key: Tab; labelKey: string }[] = [
  { key: "general", labelKey: "settings.tabGeneral" },
  { key: "transcription", labelKey: "settings.tabTranscription" },
  { key: "overlay", labelKey: "settings.tabOverlay" },
  { key: "account", labelKey: "settings.tabAccount" },
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

/** A color swatch that opens the native picker. Shows the live hex + a soft glow
 *  in the chosen color so it reads premium rather than like a raw form control. */
function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: value,
          border: "1px solid rgba(255,255,255,0.2)",
          boxShadow: `0 0 12px -3px ${value}`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontVariantNumeric: "tabular-nums", fontSize: "0.8rem", opacity: 0.75, textTransform: "uppercase" }}>
        {value}
      </span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
      />
    </label>
  );
}

/** Curated, good-looking orb palettes (idle / working / done). "working" covers
 *  recording + transcribing. Picking one fills all three; the user can still tweak
 *  each color individually afterwards (→ the preset shows as "Eigene"). */
const ORB_PRESETS: { key: string; label: string; idle: string; working: string; done: string }[] = [
  { key: "klassik", label: "Klassik", idle: "#22d3ee", working: "#ff5c5c", done: "#50dc82" },
  { key: "aurora", label: "Aurora", idle: "#22d3ee", working: "#a855f7", done: "#34d399" },
  { key: "mono", label: "Mono Cyan", idle: "#38bdf8", working: "#22d3ee", done: "#67e8f9" },
  { key: "sunset", label: "Sonnenuntergang", idle: "#f59e0b", working: "#fb7185", done: "#c084fc" },
  { key: "smaragd", label: "Smaragd", idle: "#2dd4bf", working: "#10b981", done: "#a3e635" },
];

export function Settings() {
  const { t } = useTranslation();
  const { config, patch, reload, save, savedTick } = useConfig();
  const [tab, setTab] = useState<Tab>("general");
  const [devices, setDevices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [updateMsg, setUpdateMsg] = useState("");
  const [foundUpdate, setFoundUpdate] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [ver, setVer] = useState("");
  // Auto-Mode overrides edited as an ordered [substring, style] list (null = not loaded yet).
  const [ovr, setOvr] = useState<[string, string][] | null>(null);

  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => {});
    appVersion().then(setVer).catch(() => {});
  }, []);

  // Seed the overrides editor once from config (one-way; edits write back below).
  useEffect(() => {
    if (config && ovr === null) setOvr(Object.entries(config.auto_mode_overrides || {}));
  }, [config, ovr]);

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

  // Which preset (if any) the current per-state colors match — else "custom".
  const currentPreset =
    ORB_PRESETS.find(
      (p) =>
        p.idle.toLowerCase() === (c.orb_color_idle || "").toLowerCase() &&
        p.working.toLowerCase() === (c.orb_color_working || "").toLowerCase() &&
        p.done.toLowerCase() === (c.orb_color_done || "").toLowerCase(),
    )?.key ?? "custom";
  const applyPreset = (key: string) => {
    const p = ORB_PRESETS.find((x) => x.key === key);
    if (p) patch({ orb_color_idle: p.idle, orb_color_working: p.working, orb_color_done: p.done });
  };

  // Rebuild the overrides map from the editable list and persist (auto-saves).
  const writeOvr = (next: [string, string][]) => {
    setOvr(next);
    const obj: Record<string, string> = {};
    for (const [k, v] of next) if (k.trim()) obj[k.trim()] = v;
    set("auto_mode_overrides", obj);
  };

  const doLogin = async () => {
    setBusy(true);
    setLoginErr("");
    try {
      await invoke("login");
      await reload();
    } catch (e) {
      console.error("login failed", e);
      setLoginErr(t("settings.loginFailed"));
    } finally {
      setBusy(false);
    }
  };
  const doLogout = async () => {
    await invoke("logout").catch(() => {});
    await reload();
  };
  const toggleAutostart = async (v: boolean) => {
    try {
      await setAutostart(v);
      await reload();
    } catch (e) {
      console.error("autostart failed", e);
    }
  };
  const doUpdate = async () => {
    setUpdateMsg(t("settings.updateSearching"));
    setFoundUpdate(null);
    try {
      const v = await checkForUpdates();
      if (v) {
        setFoundUpdate(v);
        setUpdateMsg(t("settings.updateAvailable", { version: v }));
      } else {
        setUpdateMsg(t("settings.updateUpToDate"));
      }
    } catch (e) {
      setUpdateMsg(t("settings.updateError", { error: String(e) }));
    }
  };
  const doInstall = async () => {
    setUpdating(true);
    setUpdateMsg(t("settings.updateInstalling"));
    try {
      await installUpdate(); // on success the app relaunches; never returns
    } catch (e) {
      setUpdateMsg(t("settings.updateError", { error: String(e) }));
      setUpdating(false);
    }
  };

  return (
    <div>
      <h1 className="section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {t("settings.title")}
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
          {t("common.saved")}
        </span>
      </h1>
      <div className="sub-tabs">
        {TABS.map((tab2) => (
          <button
            key={tab2.key}
            className={`sub-tab ${tab2.key === tab ? "active" : ""}`}
            onClick={() => setTab(tab2.key)}
          >
            {t(tab2.labelKey)}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === "general" && (
          <>
            <Row name={t("settings.recordingMode")} hint={t("settings.recordingModeHint")}>
              <Sel
                value={c.recording_mode}
                onChange={(v) => set("recording_mode", v)}
                options={[
                  ["hold", t("settings.recordingModeHold")],
                  ["toggle", t("settings.recordingModeToggle")],
                ]}
              />
            </Row>
            <Row name={t("settings.hotkey")} hint={t("settings.hotkeyHint")}>
              <HotkeyCapture value={c.hotkey} onChange={(v) => set("hotkey", v)} />
            </Row>
            <Row name={t("settings.promptHotkey")} hint={t("settings.promptHotkeyHint")}>
              <HotkeyCapture value={c.prompt_console_hotkey} onChange={(v) => set("prompt_console_hotkey", v)} />
            </Row>
            <Row name={t("settings.promptAsTarget")} hint={t("settings.promptAsTargetHint")}>
              <Toggle checked={c.prompt_console_as_target} onChange={(v) => set("prompt_console_as_target", v)} />
            </Row>
            <Row name={t("settings.microphone")}>
              <Sel
                value={c.mic_device_name || ""}
                onChange={(v) => set("mic_device_name", v)}
                options={[["", t("settings.micSystemDefault")], ...devices.map((d): [string, string] => [d, d])]}
              />
            </Row>
            <Row name={t("settings.autoPaste")} hint={t("settings.autoPasteHint")}>
              <Toggle checked={c.autopaste} onChange={(v) => set("autopaste", v)} />
            </Row>
            <Row name={t("settings.targetLock")} hint={t("settings.targetLockHint")}>
              <Toggle checked={c.target_lock} onChange={(v) => set("target_lock", v)} />
            </Row>
            <Row name={t("settings.showBubble")} hint={t("settings.showBubbleHint")}>
              <Toggle checked={c.show_bubble} onChange={(v) => set("show_bubble", v)} />
            </Row>
            <Row name={t("settings.autostart")} hint={t("settings.autostartHint")}>
              <Toggle checked={c.autostart_enabled} onChange={toggleAutostart} />
            </Row>
            <Row name={t("settings.soundStart")} hint={t("settings.soundStartHint")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Toggle checked={c.sound_start_enabled} onChange={(v) => set("sound_start_enabled", v)} />
                <Sel
                  value={c.sound_start_id || "standard"}
                  onChange={(v) => set("sound_start_id", v)}
                  options={SOUND_PRESETS.map((p): [string, string] => [p.id, t(p.labelKey)])}
                />
                <button
                  className="sub-tab"
                  title={t("settings.soundPreview")}
                  onClick={() => playSound(c.sound_start_id || "standard", "start", c.sound_volume)}
                >
                  ▶
                </button>
              </div>
            </Row>
            <Row name={t("settings.soundPaste")} hint={t("settings.soundPasteHint")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Toggle checked={c.sound_paste_enabled} onChange={(v) => set("sound_paste_enabled", v)} />
                <Sel
                  value={c.sound_paste_id || "standard"}
                  onChange={(v) => set("sound_paste_id", v)}
                  options={SOUND_PRESETS.map((p): [string, string] => [p.id, t(p.labelKey)])}
                />
                <button
                  className="sub-tab"
                  title={t("settings.soundPreview")}
                  onClick={() => playSound(c.sound_paste_id || "standard", "paste", c.sound_volume)}
                >
                  ▶
                </button>
              </div>
            </Row>
            <Row name={t("settings.volume")} hint={t("settings.volumeHint")}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={c.sound_volume}
                onChange={(e) => set("sound_volume", parseFloat(e.target.value))}
              />
            </Row>
            <Row name={t("settings.theme")}>
              <Sel
                value={c.ui_theme}
                onChange={(v) => set("ui_theme", v)}
                options={[
                  ["dark", t("settings.themeDark")],
                  ["light", t("settings.themeLight")],
                ]}
              />
            </Row>
            <Row name={t("settings.language")} hint={t("settings.languageHint")}>
              <Sel
                value={c.ui_language}
                onChange={(v) => {
                  setLanguage(v);
                  set("ui_language", v);
                }}
                options={SUPPORTED_LANGUAGES.map((l) => [l.code, l.label])}
              />
            </Row>
            <Row name={t("settings.autoUpdate")}>
              <Toggle checked={c.auto_update_check} onChange={(v) => set("auto_update_check", v)} />
            </Row>
            <Row name={t("settings.updates")} hint={updateMsg}>
              {foundUpdate ? (
                <button className="sub-tab" onClick={doInstall} disabled={updating}>
                  {updating ? t("settings.installing") : t("settings.installNow", { version: foundUpdate })}
                </button>
              ) : (
                <button className="sub-tab" onClick={doUpdate}>
                  {t("settings.checkForUpdates")}
                </button>
              )}
            </Row>

            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line, rgba(255,255,255,0.08))" }}>
              <div className="name" style={{ marginBottom: 8, opacity: 0.7 }}>{t("settings.aboutEcho")}</div>
              <Row name={t("settings.version")} hint={ver ? t("settings.versionHint", { version: ver }) : ""}>
                <span style={{ fontWeight: 700 }}>{ver ? `v${ver}` : "…"}</span>
              </Row>
              <Row name={t("settings.dataFolder")} hint={t("settings.dataFolderHint")}>
                <button className="sub-tab" onClick={() => openConfigDir()}>
                  {t("settings.openFolder")}
                </button>
              </Row>
              <Row name={t("settings.sourceCode")}>
                <button
                  className="sub-tab"
                  onClick={() => openExternal("https://github.com/subunit-ai/echo-tauri")}
                >
                  {t("settings.github")}
                </button>
              </Row>
            </div>
          </>
        )}

        {tab === "transcription" && (
          <>
            {/* Stacked full-width row (like the model manager below) — squeezed
                next to the label the 3-segment switch wrapped and looked broken. */}
            <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div className="meta">
                <div className="name">{t("settings.mode")}</div>
                <div className="hint">{t("settings.modeHint")}</div>
              </div>
              <BigModeSwitch value={uiModeOf(c)} onChange={(m) => patch(patchForUiMode(m))} />
            </div>
            <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div className="meta">
                <div className="name">{t("settings.localModel")}</div>
                <div className="hint">
                  {t("settings.localModelHint")}
                </div>
              </div>
              <ModelManager />
            </div>
            <Row name={t("settings.transcriptionLanguage")} hint={t("settings.transcriptionLanguageHint")}>
              <Sel value={c.language} onChange={(v) => set("language", v)} options={LANGUAGES} />
            </Row>
            <Row name={t("settings.diarization")} hint={t("settings.diarizationHint")}>
              <Toggle checked={c.diarization_enabled} onChange={(v) => set("diarization_enabled", v)} />
            </Row>
            <Row name={t("settings.cloudQuality")}>
              <Sel
                value={c.cloud_quality_mode}
                onChange={(v) => set("cloud_quality_mode", v)}
                options={[
                  ["quality", t("settings.cloudQualityQuality")],
                  ["fast", t("settings.cloudQualityFast")],
                  ["instant", t("settings.cloudQualityInstant")],
                  ["auto", t("settings.cloudQualityAuto")],
                ]}
              />
            </Row>
            <Row name={t("settings.instantLiveTyping")} hint={t("settings.instantLiveTypingHint")}>
              <Toggle checked={c.instant_live_typing} onChange={(v) => set("instant_live_typing", v)} />
            </Row>
            <Row name={t("settings.dachFormat")} hint={t("settings.dachFormatHint")}>
              <Toggle checked={c.dach_format_enabled} onChange={(v) => set("dach_format_enabled", v)} />
            </Row>
            <Row name={t("settings.aiCleanup")}>
              <Toggle checked={c.cleanup_enabled} onChange={(v) => set("cleanup_enabled", v)} />
            </Row>
            <Row name={t("settings.cleanupStyle")}>
              <Sel
                value={c.cleanup_style}
                onChange={(v) => set("cleanup_style", v)}
                options={[
                  ["prompt", t("settings.cleanupStylePrompt")],
                  ["email", t("settings.cleanupStyleEmail")],
                  ["slack", t("settings.cleanupStyleSlack")],
                  ["formal", t("settings.cleanupStyleFormal")],
                ]}
              />
            </Row>
            <Row
              name={t("settings.autoMode")}
              hint={t("settings.autoModeHint")}
            >
              <Toggle checked={c.cleanup_auto_mode} onChange={(v) => set("cleanup_auto_mode", v)} />
            </Row>
            {c.cleanup_auto_mode && (
              <div
                className="setting-row"
                style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}
              >
                <div className="meta">
                  <div className="name">{t("settings.customRules")}</div>
                  <div className="hint">
                    {t("settings.customRulesHint")}
                  </div>
                </div>
                {(ovr ?? []).map(([key, style], i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      style={{ flex: 1 }}
                      placeholder={t("settings.windowTitleContains")}
                      value={key}
                      onChange={(e) => {
                        const next = [...(ovr ?? [])];
                        next[i] = [e.target.value, style];
                        writeOvr(next);
                      }}
                    />
                    <Sel
                      value={style}
                      onChange={(v) => {
                        const next = [...(ovr ?? [])];
                        next[i] = [key, v];
                        writeOvr(next);
                      }}
                      options={[
                        ["prompt", t("settings.cleanupStylePrompt")],
                        ["email", t("settings.cleanupStyleEmail")],
                        ["slack", t("settings.cleanupStyleSlack")],
                        ["formal", t("settings.cleanupStyleFormal")],
                      ]}
                    />
                    <button
                      className="sub-tab"
                      onClick={() => writeOvr((ovr ?? []).filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  className="sub-tab"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => writeOvr([...(ovr ?? []), ["", "prompt"]])}
                >
                  {t("settings.addRule")}
                </button>
              </div>
            )}
          </>
        )}

        {tab === "overlay" && (
          <>
            <Row name={t("settings.showOrbOverlay")}>
              <Toggle checked={c.use_orb_overlay} onChange={(v) => set("use_orb_overlay", v)} />
            </Row>
            <Row name={t("settings.orbStyle")}>
              <Sel
                value={c.orb_overlay_style}
                onChange={(v) => set("orb_overlay_style", v)}
                options={[
                  ["ping", t("settings.orbStylePing")],
                  ["sphere", "Sphere"],
                  ["sonar", "Sonar"],
                  ["bars", "Bars"],
                  ["wave", "Wave"],
                  ["classic", "Classic"],
                ]}
              />
            </Row>
            <Row name={t("settings.orbPreset")} hint={t("settings.orbPresetHint")}>
              <Sel
                value={currentPreset}
                onChange={applyPreset}
                options={[
                  ...ORB_PRESETS.map((p): [string, string] => [p.key, p.label]),
                  ["custom", t("settings.orbPresetCustom")],
                ]}
              />
            </Row>
            <Row name={t("settings.orbColorIdle")} hint={t("settings.orbColorIdleHint")}>
              <ColorSwatch value={c.orb_color_idle} onChange={(v) => set("orb_color_idle", v)} />
            </Row>
            <Row name={t("settings.orbColorWorking")} hint={t("settings.orbColorWorkingHint")}>
              <ColorSwatch value={c.orb_color_working} onChange={(v) => set("orb_color_working", v)} />
            </Row>
            <Row name={t("settings.orbColorDone")} hint={t("settings.orbColorDoneHint")}>
              <ColorSwatch value={c.orb_color_done} onChange={(v) => set("orb_color_done", v)} />
            </Row>
            <Row name={t("settings.orbPosition")}>
              <Sel
                value={c.orb_position}
                onChange={(v) => set("orb_position", v)}
                options={[
                  ["bottom-center", t("settings.posBottomCenter")],
                  ["bottom-left", t("settings.posBottomLeft")],
                  ["bottom-right", t("settings.posBottomRight")],
                  ["top-center", t("settings.posTopCenter")],
                  ["top-left", t("settings.posTopLeft")],
                  ["top-right", t("settings.posTopRight")],
                ]}
              />
            </Row>
            <Row name={t("settings.orbSize")}>
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
            <Row name={t("settings.orbSpeed")} hint={t("settings.orbSpeedHint")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={c.orb_speed ?? 0.6}
                  onChange={(e) => set("orb_speed", parseFloat(e.target.value))}
                />
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 34, fontSize: "0.8rem", opacity: 0.8 }}>
                  {(c.orb_speed ?? 0.6).toFixed(1)}×
                </span>
              </div>
            </Row>
            <Row name={t("settings.idleMode")} hint={t("settings.idleModeHint")}>
              <Sel
                value={c.orb_idle_mode === "dim" || c.orb_idle_mode === "hide" ? c.orb_idle_mode : "normal"}
                onChange={(v) => set("orb_idle_mode", v)}
                options={[
                  ["normal", t("settings.idleNormal")],
                  ["dim", t("settings.idleDim")],
                  ["hide", t("settings.idleHide")],
                ]}
              />
            </Row>
            <Row name={t("settings.idleAnimation")} hint={t("settings.idleAnimationHint")}>
              <Toggle checked={c.orb_idle_pulse} onChange={(v) => set("orb_idle_pulse", v)} />
            </Row>
          </>
        )}

        {tab === "account" && (
          <>
            <Row
              name={t("settings.account")}
              hint={c.account_email || t("settings.accountHint")}
            >
              {c.account_email ? (
                <button className="sub-tab" onClick={doLogout}>
                  {t("settings.signOut")}
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <button className="sub-tab" onClick={doLogin} disabled={busy}>
                    {busy ? t("settings.browserOpened") : t("settings.signIn")}
                  </button>
                  {loginErr && (
                    <span style={{ color: "#f87171", fontSize: "0.78rem", maxWidth: 240, textAlign: "right" }}>
                      {loginErr}
                    </span>
                  )}
                </div>
              )}
            </Row>
            <Row name={t("settings.plan")} hint={c.account_email ? t("settings.planActive") : t("settings.planNotSignedIn")}>
              <span
                style={{
                  textTransform: "uppercase",
                  fontWeight: 800,
                  fontSize: "0.72rem",
                  color: "#22d3ee",
                  background: "rgba(34,211,238,0.12)",
                  border: "1px solid rgba(34,211,238,0.35)",
                  borderRadius: 999,
                  padding: "3px 12px",
                }}
              >
                {c.plan || "free"}
              </span>
            </Row>
            <Row name={t("settings.manageAccount")} hint={t("settings.manageAccountHint")}>
              <button
                className="sub-tab"
                onClick={() => openExternal(`https://auth.subunit.ai/account?lang=${c.ui_language || "de"}`)}
              >
                {t("settings.openAccount")}
              </button>
            </Row>
            <Row name={t("settings.saveToSynapse")} hint={t("settings.saveToSynapseHint")}>
              <Toggle checked={c.synapse_save_enabled} onChange={(v) => set("synapse_save_enabled", v)} />
            </Row>
            <Row name={t("settings.saveHistory")}>
              <Toggle checked={c.history_enabled} onChange={(v) => set("history_enabled", v)} />
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
          {t("settings.autoSaveNote")}
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
          {showSaved ? t("common.saved") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
