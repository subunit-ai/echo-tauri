// Cloud-Meeting — Warteraum (native Echo-Port von meet-ui/screens/Waiting.tsx).
// Presentation-only: die Logik kommt verbatim aus dem geteilten Store (@meet/store).
// Spinner + m.waitSub + Abbrechen (m.leave). Kein Emoji (Enterprise-UI).
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";

/** WARTERAUM — nativer Port von `#s-waiting`. Host muss den Gast freigeben. */
export function CloudWaiting() {
  const { t } = useTranslation();
  const m = useMeeting();
  return (
    <div className="mc-wrap">
      <div className="card" style={{ maxWidth: 520, textAlign: "center" }}>
        <h1 className="section-title" style={{ textAlign: "center" }}>
          {t("meet.cloudwaiting.title", "Im Warteraum")}
        </h1>
        <p className="section-sub" style={{ textAlign: "center" }}>
          {m.waitSub}
        </p>
        <div className="mc-spinner" />
        <div className="mc-hint mc-center">
          {t("meet.cloudwaiting.hint", "Sobald der Host dich freigibt, bist du dabei.")}
        </div>
        <button className="sub-tab" onClick={m.leave}>
          {t("meet.cloudwaiting.cancel", "Abbrechen")}
        </button>
      </div>
    </div>
  );
}
