// Cloud-Meeting — LANDING (native Echo "Liquid Glass" port of meet-ui/screens/Landing.tsx).
// Presentation only: the logic layer (store) is reused verbatim via @meet/store. Host CTA
// → m.hostEntry() (SSO-gated), Join CTA → m.goJoin(). Guest mode hides the host card and
// offers SSO login (container-supplied onLogin). No emoji: the DSGVO trust glyph is a
// stroke ShieldCheck, the "?" is a text badge toggling a glass info bar.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";
import { StrokeIcon, SHIELD_CHECK_PATHS, MIC_PATHS } from "../../components/icons";

export function CloudLanding({ guest = false, onLogin }: { guest?: boolean; onLogin?: () => void }) {
  const { t } = useTranslation();
  const m = useMeeting();
  const [tipOpen, setTipOpen] = useState(false); // ?-Tooltip: Klick-Toggle (TJ 2026-06-12)

  return (
    <div className="mc-wrap">
      <div className="mc-hero">
        {/* DSGVO trust eyebrow — ShieldCheck stroke SVG statt PNG; "?" toggelt die Erklärung. */}
        <div className="mc-eyebrow">
          <StrokeIcon paths={SHIELD_CHECK_PATHS} size={15} />
          {t("meet.cloudlanding.dsgvo", "100 % DSGVO-konform")}
          <span
            className="mc-thelp"
            role="button"
            aria-expanded={tipOpen}
            aria-label={t("meet.cloudlanding.dsgvoHelpLabel", "Was bedeutet DSGVO-konform?")}
            onClick={() => setTipOpen((o) => !o)}
            style={{ position: "static", marginLeft: 2 }}
          >
            ?
          </span>
        </div>
        {tipOpen && (
          <div className="mc-infobar" role="tooltip" style={{ maxWidth: 460, margin: "0 auto 16px", textAlign: "left" }}>
            {t(
              "meet.cloudlanding.dsgvoTip",
              "Alle Meetings werden ausschließlich auf unseren Servern in Deutschland verarbeitet — DSGVO-konform. Keine Weitergabe an Dritte, keine US-Cloud. Audio und Transkript werden nach der Auswertung automatisch gelöscht. Höchste Datensicherheit ist unser Standard.",
            )}
          </div>
        )}
        <h1 className="section-title">{t("meet.cloudlanding.title", "Meeting aufnehmen")}</h1>
        <p className="section-sub">
          {t("meet.cloudlanding.sub", "Starte ein Meeting oder tritt einem bei — mit sauberer Sprecher-Trennung.")}
        </p>
      </div>

      <div className="mc-choices">
        {!guest && (
          <button className="mc-choice" onClick={() => m.hostEntry()}>
            <span className="mc-choice-ic">
              <StrokeIcon paths={MIC_PATHS} size={22} strokeWidth={1.9} />
            </span>
            <span className="mc-choice-tx">
              <div className="mc-choice-tt">{t("meet.cloudlanding.hostTt", "Meeting starten")}</div>
              <div className="mc-choice-ds">
                {t("meet.cloudlanding.hostDs", "Aufnehmen & automatisch protokollieren lassen")}
              </div>
            </span>
            <span className="mc-choice-chev">
              <StrokeIcon paths={["M9 6l6 6-6 6"]} size={19} strokeWidth={2.2} />
            </span>
          </button>
        )}

        <button className="mc-choice mc-alt" onClick={() => m.goJoin()}>
          <span className="mc-choice-ic">
            <StrokeIcon
              paths={["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", "M10 17l5-5-5-5", "M15 12H3"]}
              size={22}
              strokeWidth={1.9}
            />
          </span>
          <span className="mc-choice-tx">
            <div className="mc-choice-tt">{t("meet.cloudlanding.joinTt", "Meeting beitreten")}</div>
            <div className="mc-choice-ds">{t("meet.cloudlanding.joinDs", "Mit Code oder Link dabei sein")}</div>
          </span>
          <span className="mc-choice-chev">
            <StrokeIcon paths={["M9 6l6 6-6 6"]} size={19} strokeWidth={2.2} />
          </span>
        </button>

        {guest && (
          <button className="sub-tab" onClick={onLogin}>
            {t("meet.cloudlanding.login", "Mit Account anmelden — eigene Meetings starten")}
          </button>
        )}
      </div>
    </div>
  );
}
