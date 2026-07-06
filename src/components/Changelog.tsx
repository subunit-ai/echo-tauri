import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  localizedChangelog,
  type ChangeKind,
  type LocalizedEntry,
} from "../lib/changelog";

/** Format an ISO yyyy-mm-dd as a localized long date, built in LOCAL time so the
 *  day never shifts across time zones (new Date("2026-07-06") is UTC midnight). */
function formatDate(iso: string, lang: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" }).format(
      new Date(y, m - 1, d),
    );
  } catch {
    return iso;
  }
}

function KindTag({ kind }: { kind: ChangeKind }) {
  const { t } = useTranslation();
  return (
    <span className={`cl-tag cl-tag--${kind}`}>
      <span className="cl-tag-dot" aria-hidden />
      {t(`changelog.kind.${kind}`)}
    </span>
  );
}

/** One version block: version badge + date + title + the list of changes. */
function EntryBlock({ entry, latest }: { entry: LocalizedEntry; latest?: boolean }) {
  const lang = i18n.language;
  return (
    <div className={`cl-entry ${latest ? "is-latest" : ""}`}>
      <div className="cl-entry-head">
        <span className="cl-version">v{entry.version}</span>
        <span className="cl-date">{formatDate(entry.date, lang)}</span>
      </div>
      <div className="cl-entry-title">{entry.title}</div>
      <ul className="cl-changes">
        {entry.changes.map((c, i) => (
          <li key={i} className="cl-change">
            <KindTag kind={c.kind} />
            <span className="cl-change-text">{c.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The reusable changelog list. Pass explicit `entries` (e.g. only the new ones
 *  for the "What's new" popup) or omit to render the full localized log. */
export function ChangelogList({ entries }: { entries?: LocalizedEntry[] }) {
  const list = entries ?? localizedChangelog(i18n.language);
  return (
    <div className="cl-list">
      {list.map((e, i) => (
        <EntryBlock key={e.version} entry={e} latest={i === 0 && !entries} />
      ))}
    </div>
  );
}

/** Full changelog in a modal — opened from Settings → About. Esc / backdrop closes. */
export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="cl-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cl-modal-head">
          <h3 className="cl-modal-title">{t("changelog.title")}</h3>
          <button className="cl-modal-close" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="cl-modal-body">
          <ChangelogList />
        </div>
      </div>
    </div>
  );
}
