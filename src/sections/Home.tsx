import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { MicIcon } from "../components/icons";
import { RecordPanel } from "../components/RecordPanel";
import {
  accountStats,
  historyList,
  onHistoryChanged,
  patchForUiMode,
  uiModeOf,
  type AccountStats,
  type HistoryEntry,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

const EMPTY_STATS: AccountStats = {
  transcriptions: 0,
  audio_seconds: 0,
  words: 0,
  chars: 0,
  time_saved_seconds: 0,
};

/** Compact human duration for the "time saved" card: seconds → min under an
 * hour, else one-decimal hours (de-style comma applied by the caller's locale). */
function fmtSaved(seconds: number): { value: string; unitKey: string } {
  if (seconds < 3600) return { value: String(Math.round(seconds / 60)), unitKey: "home.unitMin" };
  return { value: (seconds / 3600).toFixed(1), unitKey: "home.unitHour" };
}

export function Home({
  onStartMeeting,
  onOpenAccount,
}: {
  onStartMeeting?: () => void;
  onOpenAccount?: () => void;
}) {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  // Recent dictations (SQLite store) + real per-account stats, refreshed live
  // whenever a dictation lands (the backend emits echo://history-changed).
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<AccountStats>(EMPTY_STATS);
  useEffect(() => {
    const refresh = () => {
      historyList("", 5).then(setRecent).catch(() => {});
      accountStats().then(setStats).catch(() => {});
    };
    refresh();
    const un = onHistoryChanged(refresh);
    return () => {
      un.then((f) => f());
    };
  }, []);
  if (!config) return null;

  const saved = fmtSaved(stats.time_saved_seconds);

  // Time-NEUTRAL greeting, coupled to the account name. We deliberately avoid any
  // time-of-day phrasing ("Guten Morgen") — it just greets by nickname (falls back
  // to the full name). No name yet → the generic title + a gentle "add name" nudge.
  const who = config.nickname?.trim() || config.display_name?.trim() || "";

  return (
    <div>
      <h1 className="section-title">
        {who ? t("home.greeting", { name: who }) : t("home.title")}
      </h1>
      {who ? (
        <p className="section-sub">
          {config.recording_mode === "hold" ? t("home.modeHold") : t("home.modeToggle")}
        </p>
      ) : (
        <p className="section-sub">
          <button className="linklike" onClick={onOpenAccount}>
            {t("home.addName")}
          </button>{" "}
          · {config.recording_mode === "hold" ? t("home.modeHold") : t("home.modeToggle")}
        </p>
      )}

      <RecordPanel />

      <BigModeSwitch value={uiModeOf(config)} onChange={(m) => patch(patchForUiMode(m))} />

      <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          className="sub-tab"
          onClick={onStartMeeting}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <MicIcon />
          {t("home.startMeeting")}
        </button>
      </div>

      <div className="stat-grid" style={{ marginTop: 24 }}>
        <div className="card stat-card">
          <div className="label">{t("home.statTranscriptions")}</div>
          <div className="value">{stats.transcriptions.toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statWords")}</div>
          <div className="value">{stats.words.toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statAudioMin")}</div>
          <div className="value">{Math.round(stats.audio_seconds / 60).toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statTimeSaved")}</div>
          <div className="value">
            {saved.value}
            <span style={{ fontSize: 13, opacity: 0.6 }}> {t(saved.unitKey)}</span>
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 12px" }}>{t("home.recentHeading")}</h2>
      {recent.length === 0 ? (
        <div className="empty">{t("home.emptyHistory")}</div>
      ) : (
        recent.map((e) => (
          <div key={e.id} className="history-item">
            <div className="text">{e.text}</div>
            <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="tier-badge">{e.quality_mode || "local"}</span>
              {e.ts != null && (
                <span style={{ fontSize: 11, opacity: 0.6 }}>
                  {new Date(Number(e.ts) * 1000).toLocaleString("de-DE")}
                </span>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
