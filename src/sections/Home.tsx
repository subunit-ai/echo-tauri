import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { MicIcon } from "../components/icons";
import { RecordPanel } from "../components/RecordPanel";
import {
  historyCount,
  historyList,
  onHistoryChanged,
  patchForUiMode,
  uiModeOf,
  type HistoryEntry,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

export function Home({ onStartMeeting }: { onStartMeeting?: () => void }) {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  // Recent dictations + count from the SQLite store, refreshed live.
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => {
      historyList("", 5).then(setRecent).catch(() => {});
      historyCount().then(setCount).catch(() => {});
    };
    refresh();
    const un = onHistoryChanged(refresh);
    return () => {
      un.then((f) => f());
    };
  }, []);
  if (!config) return null;

  return (
    <div>
      <h1 className="section-title">{t("home.title")}</h1>
      <p className="section-sub">
        {t("home.hotkeyLabel")}: <b>{config.hotkey}</b> ·{" "}
        {config.recording_mode === "hold" ? t("home.modeHold") : t("home.modeToggle")}
      </p>

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
          <div className="value">{config.total_transcriptions}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statInHistory")}</div>
          <div className="value">{count}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statAudioMin")}</div>
          <div className="value">{Math.round(config.total_audio_seconds / 60)}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{t("home.statTimeSaved")}</div>
          <div className="value">
            {Math.round((config.total_audio_seconds * 3) / 60)}
            <span style={{ fontSize: 13, opacity: 0.6 }}> {t("home.unitMin")}</span>
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
