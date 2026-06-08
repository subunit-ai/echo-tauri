import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

/** WAITING ROOM — 1:1 port of `#s-waiting`. Host must admit the guest. */
export function Waiting() {
  const { t } = useI18n();
  const m = useMeeting();
  return (
    <div className="wrap card center" id="s-waiting">
      <h1 className="ptitle" style={{ textAlign: "center" }}>
        {t("Im Warteraum")}
      </h1>
      <p className="psub" id="wait-sub">
        {m.waitSub}
      </p>
      <div className="spinner"></div>
      <div className="hint center">{t("Sobald der Host dich freigibt, bist du dabei.")}</div>
      <button className="btn btn-ghost" onClick={m.leave}>
        {t("Abbrechen")}
      </button>
    </div>
  );
}
