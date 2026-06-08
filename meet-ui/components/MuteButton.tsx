import { useI18n } from "../lib/i18n";

/** Mic mute toggle — 1:1 port of `.mutebtn` (mic-on/mic-off swap via the `.muted` class). */
export function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button className={"mutebtn" + (muted ? " muted" : "")} onClick={onToggle}>
      <svg className="mic-on" viewBox="0 0 24 24">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      <svg className="mic-off" viewBox="0 0 24 24">
        <line x1="2" x2="22" y1="2" y2="22" />
        <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
        <path d="M5 10v2a7 7 0 0 0 12 5" />
        <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      <span className="mb-lb">{muted ? "Stummgeschaltet" : t("Mikro an")}</span>
    </button>
  );
}
