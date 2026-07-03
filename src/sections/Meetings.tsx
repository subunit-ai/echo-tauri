import { useTranslation } from "react-i18next";
import { MeetLocal } from "./MeetLocal";
import { MeetLive } from "./MeetLive";

/** The Meeting hub — ONE tab, two modes:
 *   • "Offline-Meeting" — the fully local, on-device Pro flow (audio never leaves
 *     the machine): recording, voice check-in, transcription, speaker separation.
 *   • "Live-Meeting" — the native cloud meet, embedded directly.
 *  Past recordings now live in the normal History (Verlauf), so there is no
 *  separate archive here anymore. The tab is controlled from App so "Meeting
 *  starten" on Home can land straight on the live mode. */
export function Meetings({
  tab,
  onTab,
}: {
  tab: "offline" | "live";
  onTab: (t: "offline" | "live") => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="meetings-root">
      <h1 className="section-title">{t("meetings.title")}</h1>

      {/* Segment-Umschalter: Offline-Meeting (Pro) | Live-Meeting */}
      <div className="sub-tabs">
        <button
          className={`sub-tab ${tab === "offline" ? "active" : ""}`}
          onClick={() => onTab("offline")}
        >
          {t("meetings.tabOffline")} <span className="tier-badge">Pro</span>
        </button>
        <button
          className={`sub-tab ${tab === "live" ? "active" : ""}`}
          onClick={() => onTab("live")}
        >
          {t("meetings.tabLive")}
        </button>
      </div>

      {tab === "offline" && <MeetLocal embedded onClose={() => onTab("offline")} />}

      {tab === "live" && (
        <div className="meet-live-host">
          <MeetLive />
        </div>
      )}
    </div>
  );
}
