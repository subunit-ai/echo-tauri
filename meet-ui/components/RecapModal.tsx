/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";

const LANGOPTS: [string, string][] = [
  ["orig", "Original-Sprache"],
  ["de", "Deutsch"],
  ["en", "Englisch"],
  ["es", "Spanisch"],
  ["fr", "Französisch"],
  ["it", "Italienisch"],
];

interface Row {
  token: string;
  name: string;
  isHost: boolean;
  checked: boolean;
  mail: string;
  lang: string;
}

/**
 * Recap recipient panel — 1:1 port of openRecapPanel/doSendRecap (`#recap-ov`). Pick
 * recipients + per-person protocol language, then send via the store's sendRecapTo
 * (which translates the needed languages first).
 */
export function RecapModal({
  participants,
  onClose,
  onSend,
}: {
  participants: any[];
  onClose: () => void;
  onSend: (recipients: { token: string; email: string; lang: string }[]) => Promise<{ ok: boolean; sent?: number; error?: string }>;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    participants.map((p) => {
      const isHost = p.source === "host";
      const ul = (p.ui_lang || "").toLowerCase();
      const lang = LANGOPTS.some((o) => o[0] === ul) ? ul : "orig";
      return { token: p.token || "", name: p.name || "—", isHost, checked: !!(p.email || isHost), mail: p.email || "", lang };
    }),
  );
  const [err, setErr] = useState("");
  const [sending, setSending] = useState("");

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const send = async () => {
    const recipients: { token: string; email: string; lang: string }[] = [];
    let bad = "";
    for (const r of rows) {
      if (!r.checked) continue;
      const mail = (r.mail || "").trim();
      if (!mail || !mail.includes("@")) {
        bad = bad || r.name;
        continue;
      }
      recipients.push({ token: r.token, email: mail, lang: r.lang });
    }
    if (bad) {
      setErr('Für „' + bad + '" fehlt eine gültige E-Mail (oder Häkchen entfernen).');
      return;
    }
    if (!recipients.length) {
      setErr("Mindestens einen Empfänger mit E-Mail auswählen.");
      return;
    }
    setErr("");
    setSending("Sende…");
    const res = await onSend(recipients);
    if (res.ok) onClose();
    else {
      setSending("");
      setErr(res.error || "Senden fehlgeschlagen.");
    }
  };

  return (
    <div id="recap-ov" className="recap-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="recap-card">
        <h3 className="recap-h">Protokoll senden an…</h3>
        <p className="recap-sub">Wähle die Empfänger. Fehlt eine E-Mail, kannst du sie hier eintragen.</p>
        <div className="recap-list" id="recap-list">
          {!rows.length && <div className="recap-empty">Keine freigegebenen Teilnehmer zum Senden.</div>}
          {rows.map((r, i) => (
            <div className="recap-row" key={r.token || i}>
              <label className="recap-tog">
                <input type="checkbox" checked={r.checked} onChange={(e) => patch(i, { checked: e.target.checked })} />
                <span className="recap-slider"></span>
              </label>
              <div className="recap-who">
                <div className="recap-nm">
                  {r.name}
                  {r.isHost && <span className="recap-badge"> Host</span>}
                </div>
                <input className="recap-mail" type="email" placeholder="E-Mail eintragen…" value={r.mail} onChange={(e) => patch(i, { mail: e.target.value })} />
                <select className="recap-lang" value={r.lang} onChange={(e) => patch(i, { lang: e.target.value })}>
                  {LANGOPTS.map(([v, tx]) => (
                    <option key={v} value={v}>
                      {"Protokoll: " + tx}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
        <div className="recap-err" id="recap-err">
          {err}
        </div>
        <div className="recap-actions">
          <button className="btn btn-primary" id="recap-send" disabled={!!sending} onClick={send}>
            {sending || "Senden"}
          </button>
          <button className="btn btn-ghost" id="recap-cancel" onClick={onClose}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
