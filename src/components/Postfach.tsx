import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { appVersion, installUpdate, onUpdateAvailable, onUpdateProgress } from "../lib/ipc";
import {
  CHANGELOG,
  cmpVersion,
  latestVersion,
  localizeEntry,
} from "../lib/changelog";
import { ChangelogModal } from "./Changelog";

// Tracks the newest version the user has acknowledged in the inbox (separate
// from the WhatsNew popup's key) — drives the "new version" unread dot.
const POSTFACH_SEEN_KEY = "echo:postfachSeen";

/**
 * Top-right notifications inbox ("Postfach"). A bell with an unread dot opens a
 * glass panel. v1 surfaces two local sources — an available app update (folds in
 * the old header update pill: same events + one-click install) and "what's new"
 * in the current version (opens the full changelog). Built to grow: sync alerts,
 * team invites, shared meetings slot in as more notification kinds later.
 */
export function Postfach() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [current, setCurrent] = useState(latestVersion());

  // Update state (mirrors HeaderUpdate: background check → event → install).
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pct, setPct] = useState(0);
  const [updateErr, setUpdateErr] = useState("");

  // "What's new" unread until the user opens the inbox on this version.
  const [wnUnread, setWnUnread] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    appVersion()
      .then((v) => {
        setCurrent(v);
        const seen = localStorage.getItem(POSTFACH_SEEN_KEY);
        setWnUnread(!seen || cmpVersion(seen, v) < 0);
      })
      .catch(() => {});
    const un = onUpdateAvailable((v) => setUpdateVersion(v));
    const unp = onUpdateProgress((p) => setPct(p));
    return () => {
      un.then((f) => f());
      unp.then((f) => f());
    };
  }, []);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasUpdate = !!updateVersion;
  const unread = (hasUpdate && !installing) || wnUnread;

  const toggle = () => {
    const willOpen = !open;
    setOpen(willOpen);
    // Acknowledge the "new version" notice when the inbox is opened.
    if (willOpen && wnUnread) {
      localStorage.setItem(POSTFACH_SEEN_KEY, current);
      setWnUnread(false);
    }
  };

  const doInstall = async () => {
    setInstalling(true);
    setUpdateErr("");
    try {
      const did = await installUpdate(); // on success the app relaunches (never resolves)
      if (!did) setUpdateVersion(null);
    } catch (e) {
      setUpdateErr(String(e));
      setInstalling(false);
    }
  };

  // Changelog entry for the running version (newest documented at or below it).
  const entry = CHANGELOG.find((e) => cmpVersion(e.version, current) <= 0);
  const localized = entry ? localizeEntry(entry, i18n.language) : null;

  const updateLabel = installing
    ? pct > 0
      ? t("update.installingPct", { pct: Math.round(pct) })
      : t("update.installing")
    : updateErr
      ? t("update.failed")
      : t("update.updateNow");

  return (
    <div className="postfach" ref={ref}>
      <button
        className={`pf-bell ${unread ? "has-unread" : ""} ${open ? "is-open" : ""}`}
        onClick={toggle}
        title={t("postfach.title")}
        aria-label={t("postfach.title")}
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread && <span className="pf-dot" aria-hidden />}
      </button>

      {open && (
        <div className="pf-panel" role="dialog" aria-label={t("postfach.title")}>
          <div className="pf-head">{t("postfach.title")}</div>
          <div className="pf-body">
            {hasUpdate && (
              <div className="pf-item pf-update">
                <span className="pf-kind pf-kind--update" aria-hidden />
                <div className="pf-item-main">
                  <div className="pf-item-title">{t("postfach.updateTitle", { version: updateVersion })}</div>
                  <div className="pf-item-sub">{t("postfach.updateSub")}</div>
                  <button
                    className={`pf-cta ${updateErr ? "err" : ""}`}
                    onClick={installing ? undefined : doInstall}
                    disabled={installing}
                  >
                    {installing && pct > 0 && (
                      <span className="pf-cta-fill" style={{ width: `${Math.max(6, pct)}%` }} />
                    )}
                    <span className="pf-cta-label">{updateLabel}</span>
                  </button>
                </div>
              </div>
            )}

            {localized && (
              <button
                className="pf-item pf-link"
                onClick={() => {
                  setShowChangelog(true);
                  setOpen(false);
                }}
              >
                <span className="pf-kind pf-kind--news" aria-hidden />
                <div className="pf-item-main">
                  <div className="pf-item-title">{t("postfach.whatsNew", { version: current })}</div>
                  <div className="pf-item-sub">{localized.title}</div>
                </div>
                <span className="pf-chevron" aria-hidden>›</span>
              </button>
            )}
          </div>
        </div>
      )}

      <ChangelogModal open={showChangelog} onClose={() => setShowChangelog(false)} />
    </div>
  );
}
