import { useTranslation } from "react-i18next";
import { MeetLocal } from "./MeetLocal";
import { MeetCloud } from "./meet/MeetCloud";
import { StrokeIcon, CLOUD_PATHS } from "../components/icons";

// Laptop-Umriss (lucide "laptop") — Stroke-Icon fürs lokale Meeting, kein Emoji.
const LAPTOP_PATHS = [
  "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9",
  "M2 20h20a0 0 0 0 0 0 0l-1.28-2.55A1 1 0 0 0 19.83 17H4.17a1 1 0 0 0-.9.45L2 20Z",
];

/** The Meeting hub — ONE section, two native modes:
 *   • "Cloud-Meeting" — the native Echo Liquid-Glass cloud meet (MeetCloud). It
 *     consumes the shared, proven meet logic (store + lib) verbatim and renders
 *     only Echo's own screens. Replaces the old shadow-DOM/Adobe-video embed.
 *   • "Lokales Meeting" (Pro) — the fully on-device flow (audio never leaves the
 *     machine): recording, voice check-in, transcription, speaker separation.
 *  Past recordings live in the normal History (Verlauf); there is no separate
 *  archive here. The tab is controlled from App so "Meeting starten" on Home can
 *  land straight on the cloud host setup (autostart). */
export function Meetings({
  tab,
  onTab,
  autostart,
}: {
  tab: "cloud" | "local";
  onTab: (t: "cloud" | "local") => void;
  /** true wenn die Sektion via Home „Meeting starten" geöffnet wurde → Host-Setup. */
  autostart?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="meetings-root">
      <h1 className="section-title">{t("meetings.title")}</h1>

      {/* Segment-Umschalter: Cloud-Meeting | Lokales Meeting (Pro) */}
      <div className="sub-tabs">
        <button
          className={`sub-tab ${tab === "cloud" ? "active" : ""}`}
          onClick={() => onTab("cloud")}
        >
          <StrokeIcon paths={CLOUD_PATHS} size={15} /> {t("meetings.tabCloud", "Cloud-Meeting")}
        </button>
        <button
          className={`sub-tab ${tab === "local" ? "active" : ""}`}
          onClick={() => onTab("local")}
        >
          <StrokeIcon paths={LAPTOP_PATHS} size={15} /> {t("meetings.tabLocal", "Lokales Meeting")}{" "}
          <span className="tier-badge">Pro</span>
        </button>
      </div>

      {tab === "cloud" && <MeetCloud autostart={autostart ? "host" : undefined} />}

      {tab === "local" && <MeetLocal embedded onClose={() => onTab("local")} />}
    </div>
  );
}
