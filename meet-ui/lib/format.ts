// Pure formatting/util helpers — 1:1 ports of the vanilla escapeHtml / _prettyName /
// fmtDur / _normKey / _fmtDate. Kept framework-agnostic so both the markdown renderers
// and the screens share one source of truth.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ESC[c]);
}

const ESC_ATTR: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function escAttr(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ESC_ATTR[c]);
}

/** "max.mustermann@x" / "max_mustermann" → "Max Mustermann". */
export function prettyName(n: unknown): string {
  let s = String(n == null ? "" : n).trim();
  if (!s) return "Sprecher";
  if (s.includes("@")) s = s.split("@")[0];
  const parts = s.split(/[._\-\s]+/).filter(Boolean);
  if (!parts.length) return s;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

export function fmtDur(secs: number): string {
  let s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

export function normKey(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/\[@[^\]]*\]/g, "")
    .replace(/\(f[äa]llig[^)]*\)/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, "");
}

export function fmtDate(ts: number | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleString("de-DE", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
