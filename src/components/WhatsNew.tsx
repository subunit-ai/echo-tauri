import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { appVersion } from "../lib/ipc";
import {
  cmpVersion,
  entriesSince,
  latestVersion,
  localizeEntry,
  LAST_SEEN_KEY,
  type ChangelogEntry,
  type LocalizedEntry,
} from "../lib/changelog";
import { CHANGELOG } from "../lib/changelog";
import { ChangelogList } from "./Changelog";

const SEEN_KEY = LAST_SEEN_KEY;

/**
 * One-shot "What's new" popup, shown the first time the app runs on a newer
 * version than last acknowledged. The last-seen version lives in localStorage
 * (persists in the webview, no backend/config change needed).
 *
 * A GENUINE fresh install is pre-seeded at onboarding completion (Intro), so it
 * skips this popup. If there is no key here, it means an EXISTING user just
 * updated INTO the first version that carries this feature → we welcome them
 * with what's new in the version they landed on (this is the case TJ hit: the
 * feature-introducing update showed nothing).
 *
 * `onSeeAll` navigates to the full changelog (Help section).
 */
export function WhatsNew({ onSeeAll }: { onSeeAll: () => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LocalizedEntry[] | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Real app version via IPC; fall back to the newest documented version so
      // the popup still works if the IPC is momentarily unavailable.
      const current = await appVersion().catch(() => latestVersion());
      if (cancelled) return;
      const seen = localStorage.getItem(SEEN_KEY);
      // Acknowledge now so it never re-nags, even if they don't click.
      localStorage.setItem(SEEN_KEY, current);

      // No key = existing user updating INTO the feature (fresh installs are
      // pre-seeded at onboarding) → show what's new in the version they landed
      // on (the newest documented entry at or below the running version).
      let fresh: ChangelogEntry[];
      if (!seen) {
        const entry = CHANGELOG.find((e) => cmpVersion(e.version, current) <= 0);
        fresh = entry ? [entry] : [];
      } else {
        if (cmpVersion(seen, current) >= 0) return; // already up to date
        fresh = entriesSince(seen, current);
      }
      if (fresh.length === 0) return; // nothing documented for this jump

      setVersion(current);
      setEntries(fresh.map((e) => localizeEntry(e, i18n.language)));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entries) return null;

  // Header shows the version the user just landed on (prefer the documented
  // entry that matches, else the raw app version).
  const headVersion =
    CHANGELOG.find((e) => e.version === version)?.version ?? entries[0]?.version ?? version;

  const seeAll = () => {
    setEntries(null);
    onSeeAll();
  };

  return (
    <div className="confirm-backdrop" onClick={() => setEntries(null)}>
      <div className="wn-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="wn-head">
          <span className="wn-badge">v{headVersion}</span>
          <div className="wn-heading">
            <div className="wn-eyebrow">{t("whatsnew.eyebrow")}</div>
            <h3 className="wn-title">{t("whatsnew.title")}</h3>
          </div>
          <button className="wn-close" onClick={() => setEntries(null)} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="wn-body">
          <ChangelogList entries={entries} />
        </div>
        <div className="wn-actions">
          <button className="wn-btn ghost" onClick={seeAll}>
            {t("whatsnew.seeAll")}
          </button>
          <button className="wn-btn primary" onClick={() => setEntries(null)}>
            {t("whatsnew.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
