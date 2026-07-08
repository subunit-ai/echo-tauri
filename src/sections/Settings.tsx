import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "../components/Avatar";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { HotkeyCapture } from "../components/HotkeyCapture";
import { ModelManager } from "../components/ModelManager";
import { StreamingSwitch } from "../components/StreamingSwitch";
import { Toggle } from "../components/Toggle";
import { useSessionExpired } from "../components/SessionBanner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ChangelogModal } from "../components/Changelog";
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
  listOrbProfiles,
  saveOrbProfile,
  applyOrbProfile,
  renameOrbProfile,
  deleteOrbProfile,
  duplicateOrbProfile,
  type Config,
  type OrbProfile,
  type EngineState,
} from "../lib/ipc";
import { OrbCanvas } from "../overlay/OrbCanvas";
import type { OrbVisual } from "../overlay/orbRender";
import { listen } from "@tauri-apps/api/event";
import { LANGUAGES } from "../lib/languages";
import { SOUND_PRESETS, playSound } from "../lib/sounds";
import { SUPPORTED_LANGUAGES, setLanguage } from "../i18n";
import { useConfig } from "../state/ConfigContext";

export type SettingsTab = "allgemein" | "dictation" | "transcription" | "overlay" | "account";
type Tab = SettingsTab;
const TABS: { key: Tab; labelKey: string }[] = [
  { key: "allgemein", labelKey: "settings.tabGeneral" },
  { key: "dictation", labelKey: "settings.tabDictation" },
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

/** A titled section within a settings tab — the uppercase divider header that
 *  clusters related rows (the IA fix: no tab used to have any grouping). */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-group">
      <div className="set-group-h">{title}</div>
      {children}
    </div>
  );
}

/** A single-line text setting. Buffers locally and commits on blur / Enter so we
 *  don't write config to disk on every keystroke (and the cursor never jumps).
 *  Re-syncs if the underlying value changes from elsewhere (e.g. JWT auto-seed). */
function TextRow({
  name,
  hint,
  value,
  placeholder,
  maxLength,
  onCommit,
}: {
  name: string;
  hint?: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onCommit: (v: string) => void;
}) {
  const [buf, setBuf] = useState(value);
  const focused = useRef(false);
  // Adopt external changes only while not being edited (avoids clobbering typing).
  useEffect(() => {
    if (!focused.current) setBuf(value);
  }, [value]);
  const commit = () => {
    const v = buf.trim();
    // Normalise the visible buffer too, so a whitespace-only edit (which won't
    // patch, since the trimmed value is unchanged) doesn't leave stale spaces on
    // screen — the input is controlled by `buf`, not `value`.
    if (v !== buf) setBuf(v);
    if (v !== value) onCommit(v);
  };
  return (
    <Row name={name} hint={hint}>
      <input
        type="text"
        className="text-setting"
        value={buf}
        placeholder={placeholder}
        maxLength={maxLength}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </Row>
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

/** Every orb style in display order — the SINGLE source for both the picker
 *  dropdown and the configurator's ‹ › arrow-cycle (keep them in sync). The
 *  "ping" label is localised at the call site; the rest are proper names.
 *  The ★ block up front are the premium styles: complex, layered looks driven
 *  by the REAL voice spectrum (mic_features), not just the scalar level. */
const ORB_STYLES: [string, string][] = [
  ["pill", "★ Pille (Standard)"],
  ["nebula", "★ Nebula"],
  ["ferro", "★ Ferrofluid"],
  ["scope", "★ Oscilloscope"],
  ["prism", "★ Prisma"],
  ["spectra", "★ Spectra"],
  ["ping", "Ping"],
  ["ping2", "Ping V2"],
  ["sphere", "Sphere"],
  ["sonar", "Sonar"],
  ["sonar2", "Sonar V2 (Radar)"],
  ["bars", "Bars"],
  ["bars2", "Bars V2 (EQ)"],
  ["bars3", "Bars V3 (Hybrid)"],
  ["duobars", "Duo Bars V1"],
  ["duobars2", "Duo Bars V2"],
  ["duobars3", "Duo Bars V3 (Hybrid)"],
  ["wave", "Wave"],
  ["wave2", "Wave V2"],
  ["ribbon", "Ribbon (Liquid)"],
  ["classic", "Classic"],
  ["halo", "Halo"],
  ["orbit", "Orbit"],
  ["helix", "Helix (DNA)"],
  ["nova", "Nova"],
  ["droplet", "Droplet (Liquid)"],
  ["constellation", "Constellation"],
  ["aurora", "Aurora"],
  ["spectrum", "Spectrum"],
];

/** The cleanup styles in canonical order — the SINGLE source for both the
 *  Settings picker and the per-window Auto-Mode override picker (keep them in
 *  sync, and in sync with the orb satellite + the cycle order in commands.rs).
 *  Values must match the server-side cleanup style keys (cleanup.py PROMPTS). */
const CLEANUP_STYLE_OPTIONS = (t: (k: string) => string): [string, string][] => [
  ["prompt", t("settings.cleanupStylePrompt")],
  ["email", t("settings.cleanupStyleEmail")],
  ["slack", t("settings.cleanupStyleSlack")],
  ["formal", t("settings.cleanupStyleFormal")],
  ["tidy", t("settings.cleanupStyleTidy")],
  ["notes", t("settings.cleanupStyleNotes")],
  ["letter", t("settings.cleanupStyleLetter")],
  ["social", t("settings.cleanupStyleSocial")],
];

/** Phase-1 manager for saved Orb profiles (the FULL look — colours, style,
 *  speed, reactivity — per account, cloud-synced). The richer live "orb
 *  configurator" (big preview, effect/voice pickers) builds on these same
 *  commands later; this is the durable foundation. */
function OrbProfiles({ cloudSynced }: { cloudSynced: boolean }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<OrbProfile[]>([]);
  const [busy, setBusy] = useState(false);
  // In-app editing — the Tauri webview has no window.prompt/confirm (they no-op),
  // so naming/confirming happens with real inputs right in the panel.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const reload = () => listOrbProfiles().then(setProfiles).catch(() => {});
  useEffect(() => {
    reload();
    const un = listen("echo://profiles-changed", () => reload());
    return () => {
      un.then((f) => f());
    };
  }, []);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    setNewName(t("settings.orbProfileDefaultName"));
    setCreating(true);
  };
  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
  };
  const commitCreate = () => {
    const name = newName.trim();
    if (name) guard(() => saveOrbProfile(name));
    cancelCreate();
  };
  const startRename = (p: OrbProfile) => {
    setEditingId(p.id);
    setEditName(p.name);
  };
  const commitRename = (p: OrbProfile) => {
    const name = editName.trim();
    if (name && name !== p.name) guard(() => renameOrbProfile(p.id, name));
    setEditingId(null);
    setEditName("");
  };
  const duplicate = (p: OrbProfile) =>
    guard(() =>
      duplicateOrbProfile(
        p.id,
        `${p.name || t("settings.orbProfileUnnamed")} ${t("settings.orbProfileCopySuffix")}`,
      ),
    );
  const doDelete = (p: OrbProfile) => {
    guard(() => deleteOrbProfile(p.id));
    setConfirmId(null);
  };

  return (
    <div className="orb-profiles">
      <div className="op-head">
        <div>
          <div className="op-title">{t("settings.orbProfiles")}</div>
          <div className="op-sub">
            {cloudSynced ? t("settings.orbProfilesSynced") : t("settings.orbProfilesLocalOnly")}
          </div>
        </div>
        {!creating && (
          <button className="op-save" disabled={busy} onClick={startCreate}>
            ＋ {t("settings.orbProfileSaveCurrent")}
          </button>
        )}
      </div>

      {creating && (
        <div className="op-edit">
          <input
            className="op-input"
            autoFocus
            value={newName}
            placeholder={t("settings.orbProfileDefaultName")}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreate();
              else if (e.key === "Escape") cancelCreate();
            }}
          />
          <button disabled={busy || !newName.trim()} onClick={commitCreate}>
            {t("settings.orbProfileSave")}
          </button>
          <button onClick={cancelCreate}>{t("settings.orbProfileCancel")}</button>
        </div>
      )}

      {profiles.length === 0 && !creating ? (
        <div className="op-empty">{t("settings.orbProfilesEmpty")}</div>
      ) : (
        <div className="op-list">
          {profiles.map((p) =>
            editingId === p.id ? (
              <div className="op-item" key={p.id}>
                <input
                  className="op-input"
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(p);
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                />
                <div className="op-actions">
                  <button disabled={busy} onClick={() => commitRename(p)}>
                    {t("settings.orbProfileSave")}
                  </button>
                  <button onClick={() => setEditingId(null)}>{t("settings.orbProfileCancel")}</button>
                </div>
              </div>
            ) : confirmId === p.id ? (
              <div className="op-item" key={p.id}>
                <span className="op-name">
                  {t("settings.orbProfileDeleteConfirm", { name: p.name || t("settings.orbProfileUnnamed") })}
                </span>
                <div className="op-actions">
                  <button className="op-danger" disabled={busy} onClick={() => doDelete(p)}>
                    {t("settings.orbProfileDelete")}
                  </button>
                  <button onClick={() => setConfirmId(null)}>{t("settings.orbProfileCancel")}</button>
                </div>
              </div>
            ) : (
              <div className="op-item" key={p.id}>
                <span className="op-name">{p.name || t("settings.orbProfileUnnamed")}</span>
                <div className="op-actions">
                  <button disabled={busy} onClick={() => guard(() => applyOrbProfile(p.id))}>
                    {t("settings.orbProfileApply")}
                  </button>
                  <button disabled={busy} title={t("settings.orbProfileRename")} onClick={() => startRename(p)}>
                    ✎
                  </button>
                  <button disabled={busy} title={t("settings.orbProfileDuplicate")} onClick={() => duplicate(p)}>
                    ⧉
                  </button>
                  <button disabled={busy} title={t("settings.orbProfileDelete")} onClick={() => setConfirmId(p.id)}>
                    🗑
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** The live Orb configurator preview. Renders the orb EXACTLY like the floating
 *  overlay (shared `drawOrb`), centred and hugging the orb's real size, reacting
 *  live to every setting below it. ‹ › arrows step through every orb style right
 *  here. A "Demo-Stimme" run drives a synthetic speaking envelope so the voice
 *  reaction is visible in-app, and the state legend (idle / active / done /
 *  error) lights up in sync with whatever the demo is currently playing. */
function OrbConfigurator({ c, onStyle }: { c: Config; onStyle: (s: string) => void }) {
  const { t } = useTranslation();
  const [demo, setDemo] = useState(true);
  const [previewState, setPreviewState] = useState<EngineState>("idle");
  const [demoPhase, setDemoPhase] = useState<EngineState>("idle");

  const visual: OrbVisual = {
    style: c.orb_overlay_style,
    colors: {
      idle: c.orb_color_idle,
      working: c.orb_color_working,
      done: c.orb_color_done,
      error: c.orb_color_error,
    },
    // The preview ALWAYS shows a living orb: idle-"hide" would render nothing
    // and idle-still would freeze to a dot — correct for the real overlay, but
    // in the configurator it read as "broken / shows nothing" (TJ). Hide/dim/
    // still remain overlay-only behaviours; here we preview the LOOK.
    idlePulse: true,
    idleMode: "normal",
    speed: c.orb_speed ?? 0.6,
  };
  // The size slider visibly scales the preview too (clamped to the stage).
  const sizeFactor = c.orb_overlay_size ?? 1;
  const px = Math.round(Math.max(120, Math.min(300, 170 * sizeFactor)));
  // Fixed stage floor so cycling styles / nudging the size slider doesn't
  // reflow the whole settings page under the cursor (it read as "wobbling").
  const stageMin = Math.max(240, px + 32);

  // ‹ › cycle through every style live in the preview (applies immediately).
  const styleIdx = Math.max(0, ORB_STYLES.findIndex(([k]) => k === c.orb_overlay_style));
  const styleLabel = ORB_STYLES[styleIdx]?.[1] ?? c.orb_overlay_style;
  const cycleStyle = (dir: number) =>
    onStyle(ORB_STYLES[(styleIdx + dir + ORB_STYLES.length) % ORB_STYLES.length][0]);

  const STATES: { key: EngineState; labelKey: string }[] = [
    { key: "idle", labelKey: "settings.orbStateIdle" },
    { key: "recording", labelKey: "settings.orbStateActive" },
    { key: "done", labelKey: "settings.orbStateDone" },
    { key: "error", labelKey: "settings.orbStateError" },
  ];
  // Which legend entry is lit: during the demo it follows the live phase
  // (transcribing counts as "active"); otherwise the manually-picked state.
  const liveKey: EngineState = demo
    ? demoPhase === "transcribing"
      ? "recording"
      : demoPhase
    : previewState;

  return (
    <div className="orb-config">
      <div className="oc-head">
        <div className="oc-title">{t("settings.orbConfigurator")}</div>
        <div className="oc-sub">{t("settings.orbConfiguratorHint")}</div>
      </div>
      <div className="oc-stage" style={{ minHeight: stageMin }}>
        <button className="oc-arrow" onClick={() => cycleStyle(-1)} aria-label={t("settings.orbStylePrev")} title={styleLabel}>
          ‹
        </button>
        <OrbCanvas visual={visual} state={previewState} demo={demo} onPhase={setDemoPhase} size={px} />
        <button className="oc-arrow" onClick={() => cycleStyle(1)} aria-label={t("settings.orbStyleNext")} title={styleLabel}>
          ›
        </button>
      </div>
      <div className="oc-style-name">{styleLabel}</div>
      <div className="oc-controls">
        <button className={`oc-demo ${demo ? "active" : ""}`} onClick={() => setDemo((d) => !d)}>
          {demo ? `■ ${t("settings.orbDemoStop")}` : `▶ ${t("settings.orbDemoPlay")}`}
        </button>
        <div className="oc-states">
          {STATES.map((s) => (
            <button
              key={s.key}
              className={liveKey === s.key ? "active" : ""}
              onClick={() => {
                // Clicking a state inspects it — stop the demo and pin that look.
                setDemo(false);
                setPreviewState(s.key);
              }}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Settings({ tab: tabProp, onTab }: { tab?: SettingsTab; onTab?: (t: SettingsTab) => void } = {}) {
  const { t } = useTranslation();
  const { config, patch, reload, save, savedTick } = useConfig();
  // Tab state is CONTROLLED when the parent passes tab/onTab (so the sidebar's
  // account card can deep-link into the Account tab); otherwise it self-manages.
  const [localTab, setLocalTab] = useState<Tab>("allgemein");
  const tab = tabProp ?? localTab;
  const setTab = onTab ?? setLocalTab;
  const [devices, setDevices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const sessionExpired = useSessionExpired();
  const [updateMsg, setUpdateMsg] = useState("");
  const [foundUpdate, setFoundUpdate] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [ver, setVer] = useState("");
  const [showChangelog, setShowChangelog] = useState(false);
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
        {tab === "allgemein" && (
          <>
            <Group title={t("settings.secAppearance")}>
              <Row name={t("settings.theme")}>
                <Sel
                  value={c.ui_theme}
                  onChange={(v) => set("ui_theme", v)}
                  options={[
                    ["light", t("settings.themeLight")],
                    ["liquid", t("settings.themeLiquid")],
                    ["dark", t("settings.themeDark")],
                    ["black", t("settings.themeBlack")],
                  ]}
                />
              </Row>
              <Row name={t("settings.glassStrength")} hint={t("settings.glassStrengthHint")}>
                <Sel
                  value={String(c.glass_strength ?? 2)}
                  onChange={(v) => set("glass_strength", parseInt(v, 10))}
                  options={[
                    ["0", t("settings.glassOff")],
                    ["1", t("settings.glassSubtle")],
                    ["2", t("settings.glassStandard")],
                    ["3", t("settings.glassStrong")],
                  ]}
                />
              </Row>
              <Row name={t("settings.uiScale")} hint={t("settings.uiScaleHint")}>
                <Sel
                  value={String(Math.round((c.ui_scale ?? 1) * 100))}
                  onChange={(v) => set("ui_scale", parseInt(v, 10) / 100)}
                  options={[
                    ["100", "100 %"],
                    ["90", "90 %"],
                    ["80", "80 %"],
                    ["70", "70 %"],
                    ["60", "60 %"],
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
            </Group>

            <Group title={t("settings.secStartup")}>
              <Row name={t("settings.autostart")} hint={t("settings.autostartHint")}>
                <Toggle checked={c.autostart_enabled} onChange={toggleAutostart} />
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
            </Group>

            <Group title={t("settings.secAbout")}>
              <Row name={t("settings.version")} hint={ver ? t("settings.versionHint", { version: ver }) : ""}>
                <span style={{ fontWeight: 700 }}>{ver ? `v${ver}` : "…"}</span>
              </Row>
              <Row name={t("settings.changelog")} hint={t("settings.changelogHint")}>
                <button className="sub-tab" onClick={() => setShowChangelog(true)}>
                  {t("settings.changelogBtn")}
                </button>
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
              <Row name={t("settings.replayIntro")} hint={t("settings.replayIntroHint")}>
                <button className="sub-tab" onClick={() => patch({ has_seen_onboarding: false })}>
                  {t("settings.replayIntroBtn")}
                </button>
              </Row>
            </Group>
          </>
        )}

        {tab === "dictation" && (
          <>
            <Group title={t("settings.secInput")}>
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
              <Row name={t("settings.microphone")}>
                <Sel
                  value={c.mic_device_name || ""}
                  onChange={(v) => set("mic_device_name", v)}
                  options={[["", t("settings.micSystemDefault")], ...devices.map((d): [string, string] => [d, d])]}
                />
              </Row>
            </Group>

            <Group title={t("settings.secOutput")}>
              <Row name={t("settings.autoPaste")} hint={t("settings.autoPasteHint")}>
                <Toggle checked={c.autopaste} onChange={(v) => set("autopaste", v)} />
              </Row>
              <Row name={t("settings.targetLock")} hint={t("settings.targetLockHint")}>
                <Toggle checked={c.target_lock} onChange={(v) => set("target_lock", v)} />
              </Row>
              <Row name={t("settings.promptHotkey")} hint={t("settings.promptHotkeyHint")}>
                <HotkeyCapture value={c.prompt_console_hotkey} onChange={(v) => set("prompt_console_hotkey", v)} />
              </Row>
              <Row name={t("settings.promptAsTarget")} hint={t("settings.promptAsTargetHint")}>
                <Toggle checked={c.prompt_console_as_target} onChange={(v) => set("prompt_console_as_target", v)} />
              </Row>
              <Row name={t("settings.promptFallback")} hint={t("settings.promptFallbackHint")}>
                <Toggle checked={c.prompt_fallback_enabled} onChange={(v) => set("prompt_fallback_enabled", v)} />
              </Row>
            </Group>

            <Group title={t("settings.secFeedback")}>
              <Row name={t("settings.showBubble")} hint={t("settings.showBubbleHint")}>
                <Toggle checked={c.show_bubble} onChange={(v) => set("show_bubble", v)} />
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
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={c.sound_volume}
                    onChange={(e) => set("sound_volume", parseFloat(e.target.value))}
                  />
                  <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 34, fontSize: "0.8rem", opacity: 0.8 }}>
                    {Math.round((c.sound_volume ?? 0) * 100)}%
                  </span>
                </div>
              </Row>
            </Group>
          </>
        )}

        {tab === "transcription" && (
          <>
            <Group title={t("settings.secEngine")}>
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
              <Row name={t("settings.cloudQuality")} hint={t("settings.cloudQualityHint")}>
                <Sel
                  value={c.cloud_quality_mode}
                  onChange={(v) => set("cloud_quality_mode", v)}
                  options={[
                    ["quality", t("settings.cloudQualityQuality")],
                    ["highest", t("settings.cloudQualityHighest")],
                  ]}
                />
              </Row>
            </Group>

            <Group title={t("settings.secLangSpeaker")}>
              <Row name={t("settings.transcriptionLanguage")} hint={t("settings.transcriptionLanguageHint")}>
                <Sel value={c.language} onChange={(v) => set("language", v)} options={LANGUAGES} />
              </Row>
              <Row name={t("settings.diarization")} hint={t("settings.diarizationHint")}>
                <Toggle checked={c.diarization_enabled} onChange={(v) => set("diarization_enabled", v)} />
              </Row>
            </Group>

            <Group title={t("settings.secLiveTyping")}>
              <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
                <div className="meta">
                  <div className="name">{t("settings.streaming")}</div>
                  <div className="hint">{t("settings.streamingHint")}</div>
                </div>
                <StreamingSwitch
                  value={c.streaming_mode}
                  onChange={(m) => {
                    set("streaming_mode", m);
                    // Streaming-live already types live → clear the redundant
                    // instant-live-typing so the two can't both be active.
                    if (m === "live") set("instant_live_typing", false);
                  }}
                  disabled={uiModeOf(c) === "local"}
                />
                {c.streaming_mode === "live" && c.recording_mode === "hold" && (
                  <div className="hint" style={{ color: "var(--warn, #f59e0b)" }}>
                    {t("settings.streamingLiveTapNote")}
                  </div>
                )}
              </div>
              <Row
                name={t("settings.instantLiveTyping")}
                hint={
                  c.streaming_mode === "live"
                    ? t("settings.instantLiveTypingLiveNote")
                    : t("settings.instantLiveTypingHint")
                }
              >
                <Toggle
                  checked={c.streaming_mode === "live" ? false : c.instant_live_typing}
                  disabled={c.streaming_mode === "live"}
                  onChange={(v) => set("instant_live_typing", v)}
                />
              </Row>
            </Group>

            <Group title={t("settings.secCleanup")}>
            <Row name={t("settings.dachFormat")} hint={t("settings.dachFormatHint")}>
              <Toggle checked={c.dach_format_enabled} onChange={(v) => set("dach_format_enabled", v)} />
            </Row>
            <Row name={t("settings.deCommas")} hint={t("settings.deCommasHint")}>
              <Toggle checked={c.de_comma_enabled} onChange={(v) => set("de_comma_enabled", v)} />
            </Row>
            <Row name={t("settings.fillerRemoval")} hint={t("settings.fillerRemovalHint")}>
              <Toggle checked={c.filler_removal_enabled} onChange={(v) => set("filler_removal_enabled", v)} />
            </Row>
            <Row name={t("settings.aiCleanup")} hint={t("settings.aiCleanupHint")}>
              <Toggle checked={c.cleanup_enabled} onChange={(v) => set("cleanup_enabled", v)} />
            </Row>
            <Row name={t("settings.cleanupStyle")}>
              <Sel
                value={c.cleanup_style}
                onChange={(v) => set("cleanup_style", v)}
                options={CLEANUP_STYLE_OPTIONS(t)}
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
                      options={CLEANUP_STYLE_OPTIONS(t)}
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
            </Group>
          </>
        )}

        {tab === "overlay" && (
          <>
            <OrbConfigurator c={c} onStyle={(v) => set("orb_overlay_style", v)} />
            <Row name={t("settings.showOrbOverlay")}>
              <Toggle checked={c.use_orb_overlay} onChange={(v) => set("use_orb_overlay", v)} />
            </Row>
            <Row name={t("settings.orbStyle")}>
              <Sel
                value={c.orb_overlay_style}
                onChange={(v) => set("orb_overlay_style", v)}
                options={ORB_STYLES.map(
                  ([k, label]): [string, string] => [
                    k,
                    k === "ping" ? t("settings.orbStylePing") : label,
                  ],
                )}
              />
            </Row>
            <Row name={t("settings.orbPreset")} hint={t("settings.orbPresetHint")}>
              <Sel
                value={currentPreset}
                onChange={applyPreset}
                options={[
                  ...ORB_PRESETS.map((p): [string, string] => [p.key, t(`settings.orbPresets.${p.key}`)]),
                  ["custom", t("settings.orbPresetCustom")],
                ]}
              />
            </Row>
            <OrbProfiles cloudSynced={!!c.account_email} />
            <Row name={t("settings.orbColorIdle")} hint={t("settings.orbColorIdleHint")}>
              <ColorSwatch value={c.orb_color_idle} onChange={(v) => set("orb_color_idle", v)} />
            </Row>
            <Row name={t("settings.orbColorWorking")} hint={t("settings.orbColorWorkingHint")}>
              <ColorSwatch value={c.orb_color_working} onChange={(v) => set("orb_color_working", v)} />
            </Row>
            <Row name={t("settings.orbColorDone")} hint={t("settings.orbColorDoneHint")}>
              <ColorSwatch value={c.orb_color_done} onChange={(v) => set("orb_color_done", v)} />
            </Row>
            <Row name={t("settings.orbColorError")} hint={t("settings.orbColorErrorHint")}>
              <ColorSwatch value={c.orb_color_error} onChange={(v) => set("orb_color_error", v)} />
            </Row>
            <Row name={t("settings.orbPosition")}>
              {/* After a drag the saved value is "center-<x>-<y>" (legacy:
                  "custom-<x>-<y>"), which matches no named option — without a
                  visible "custom" entry the select rendered blank/first-option
                  and re-picking an anchor felt like it did nothing. Show the
                  truth, and make every named pick fire. */}
              <Sel
                value={/^(custom|center)-/.test(c.orb_position) ? "custom" : c.orb_position}
                onChange={(v) => {
                  if (v !== "custom") set("orb_position", v);
                }}
                options={[
                  ...(/^(custom|center)-/.test(c.orb_position)
                    ? [["custom", t("settings.posCustom")] as [string, string]]
                    : []),
                  ["bottom-center", t("settings.posBottomCenter")],
                  ["bottom-left", t("settings.posBottomLeft")],
                  ["bottom-right", t("settings.posBottomRight")],
                  ["top-center", t("settings.posTopCenter")],
                  ["top-left", t("settings.posTopLeft")],
                  ["top-right", t("settings.posTopRight")],
                ]}
              />
            </Row>
            <Row name={t("settings.orbSize")} hint={t("settings.orbSizeHint")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.05}
                  value={c.orb_overlay_size ?? 1}
                  onChange={(e) => set("orb_overlay_size", parseFloat(e.target.value))}
                />
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 42, fontSize: "0.8rem", opacity: 0.8 }}>
                  {(c.orb_overlay_size ?? 1).toFixed(2)}×
                </span>
              </div>
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
            <Row name={t("settings.orbTrigger")} hint={t("settings.orbTriggerHint")}>
              <Sel
                value={c.orb_trigger === "hover" ? "hover" : "click"}
                onChange={(v) => set("orb_trigger", v)}
                options={[
                  ["click", t("settings.orbTriggerClick")],
                  ["hover", t("settings.orbTriggerHover")],
                ]}
              />
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
            <Group title={t("settings.secProfile")}>
              <div className="profile-head">
                <Avatar name={c.nickname || c.display_name || c.account_email} size={56} />
                <div className="profile-id">
                  <div className="profile-name">
                    {c.nickname || c.display_name || t("account.guest")}
                  </div>
                  {c.account_email && <div className="profile-mail">{c.account_email}</div>}
                </div>
              </div>
              <TextRow
                name={t("settings.displayName")}
                hint={t("settings.displayNameHint")}
                value={c.display_name}
                placeholder={t("settings.displayNamePlaceholder")}
                maxLength={60}
                onCommit={(v) => set("display_name", v)}
              />
              <TextRow
                name={t("settings.nickname")}
                hint={t("settings.nicknameHint")}
                value={c.nickname}
                placeholder={t("settings.nicknamePlaceholder")}
                maxLength={30}
                onCommit={(v) => set("nickname", v)}
              />
            </Group>
            <Group title={t("settings.secAccount")}>
            <Row
              name={t("settings.account")}
              hint={
                sessionExpired && c.account_email
                  ? `${c.account_email} — ${t("session.expiredShort")}`
                  : c.account_email || t("settings.accountHint")
              }
            >
              {sessionExpired && c.account_email ? (
                <button className="sub-tab" onClick={doLogin} disabled={busy}>
                  {busy ? t("settings.browserOpened") : t("session.signInAgain")}
                </button>
              ) : c.account_email ? (
                <button className="sub-tab" onClick={() => setConfirmLogout(true)}>
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
            <Row name={t("settings.plan")} hint={c.account_email && !sessionExpired ? t("settings.planActive") : t("settings.planNotSignedIn")}>
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
            </Group>

            <Group title={t("settings.secData")}>
            <Row name={t("settings.saveToSynapse")} hint={t("settings.saveToSynapseHint")}>
              <Toggle checked={c.synapse_save_enabled} onChange={(v) => set("synapse_save_enabled", v)} />
            </Row>
            <Row name={t("settings.saveHistory")}>
              <Toggle checked={c.history_enabled} onChange={(v) => set("history_enabled", v)} />
            </Row>
            </Group>
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
      <ConfirmDialog
        open={confirmLogout}
        title={t("settings.signOutConfirmTitle")}
        message={t("settings.signOutConfirmMessage")}
        confirmLabel={t("settings.signOut")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => {
          setConfirmLogout(false);
          void doLogout();
        }}
        onCancel={() => setConfirmLogout(false)}
      />
      <ChangelogModal open={showChangelog} onClose={() => setShowChangelog(false)} />
    </div>
  );
}
