// Result renderers — 1:1 ports of the vanilla renderDeepDive / renderTranscript /
// _ddInline / _trLine / _spkAssignUI. They emit HTML strings (consumed via
// dangerouslySetInnerHTML in the Results screen) so the output is byte-identical to the
// live site — same classes, same structure → same look, zero drift.
import { escapeHtml, escAttr, normKey, prettyName } from "./format";

const DDH: Record<string, string> = {
  ZUSAMMENFASSUNG: "📄",
  THEMEN: "🗂️",
  ENTSCHEIDUNGEN: "✅",
  AUFGABEN: "📋",
  "BEZUG ZU FRÜHEREM": "🧠",
};
const DDA: Record<string, string> = {
  ZUSAMMENFASSUNG: "sum",
  THEMEN: "themen",
  ENTSCHEIDUNGEN: "entsch",
  AUFGABEN: "aufg",
  "BEZUG ZU FRÜHEREM": "bezug",
};
const SPK_COLORS = ["#0a93b2", "#7c5cf0", "#16a34a", "#d97706", "#db2777", "#2563eb", "#ea580c"];

export function ddInline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[@([^\]]+)\]/g, '<span class="dd-owner">@$1</span>');
}

export function renderDeepDive(md: string | undefined): string {
  if (!md || !md.trim()) return '<p class="dd-empty">Keine Zusammenfassung erstellt.</p>';
  const lines = md.replace(/\r/g, "").split("\n");
  let out = "";
  let listOpen = false;
  let sectOpen = false;
  const closeL = () => {
    if (listOpen) {
      out += "</ul>";
      listOpen = false;
    }
  };
  const closeS = () => {
    closeL();
    if (sectOpen) {
      out += "</div>";
      sectOpen = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const up = line.replace(/[:：]\s*$/, "").toUpperCase();
    if (DDH[up] !== undefined && line.length < 42) {
      closeS();
      out +=
        '<div class="dd-sect ' +
        (DDA[up] || "sum") +
        '"><div class="dd-h"><span class="dd-hi">' +
        DDH[up] +
        "</span>" +
        escapeHtml(up.charAt(0) + up.slice(1).toLowerCase()) +
        "</div>";
      sectOpen = true;
      continue;
    }
    if (line[0] === "▸" || line.startsWith("###")) {
      closeL();
      const t = line.replace(/^[▸#\s]+/, "");
      out += '<div class="dd-topic" data-k="' + normKey(t) + '">' + ddInline(t) + "</div>";
      continue;
    }
    if (line[0] === "•" || line[0] === "-" || /^\*\s/.test(line) || /^\*\*/.test(line)) {
      if (!listOpen) {
        out += '<ul class="dd-list">';
        listOpen = true;
      }
      const t = line.replace(/^[•\-]\s+/, "").replace(/^\*\s+/, "");
      out += '<li data-k="' + normKey(t) + '">' + ddInline(t) + "</li>";
      continue;
    }
    closeL();
    out += '<p class="dd-p">' + ddInline(line) + "</p>";
  }
  closeS();
  return out || '<p class="dd-empty">—</p>';
}

function trLine(s: string): string {
  const v = String(s || "").trim();
  if (!v) return "";
  const m = v.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
  if (m) return '<p class="tr-l"><span class="tr-ts">' + m[1] + "</span><span>" + escapeHtml(m[2]) + "</span></p>";
  return '<p class="tr-l"><span class="tr-ts"></span><span>' + escapeHtml(v) + "</span></p>";
}

export interface TranscriptOpts {
  spkMap?: Record<string, string>;
  spkPool?: string[];
  deviceMode?: string;
}

function spkAssignUI(speakers: string[], opts: TranscriptOpts): string {
  const { spkMap = {}, spkPool = [], deviceMode } = opts;
  if (deviceMode !== "single" || !spkPool.length || !speakers.length) return "";
  let h = '<div class="spkassign"><div class="spkassign-h">🎙️ Sprecher zuordnen</div><div class="spkassign-grid">';
  for (const sp of speakers) {
    let optsHtml = '<option value="">' + escapeHtml(sp) + "</option>";
    for (const nm of spkPool) {
      optsHtml +=
        '<option value="' + escAttr(nm) + '"' + (spkMap[sp] === nm ? " selected" : "") + ">" + escapeHtml(nm) + "</option>";
    }
    h +=
      '<div class="spkassign-row"><span class="spkassign-orig">' +
      escapeHtml(sp) +
      '</span><select data-orig="' +
      escAttr(sp) +
      '">' +
      optsHtml +
      "</select></div>";
  }
  return h + "</div></div>";
}

export function renderTranscript(md: string | undefined, opts: TranscriptOpts = {}): string {
  if (!md || !md.trim()) return '<p class="dd-empty">Kein Transkript.</p>';
  const { spkMap = {} } = opts;
  const spkDisplay = (name: string) => spkMap[name] || name;
  const lines = md.replace(/\r/g, "").split("\n");
  const colors: Record<string, string> = {};
  let ci = 0;
  const colorFor = (n: string) => {
    if (!(n in colors)) {
      colors[n] = SPK_COLORS[ci % SPK_COLORS.length];
      ci++;
    }
    return colors[n];
  };
  const speakers: string[] = [];
  let out = "";
  let open = false;
  const close = () => {
    if (open) {
      out += "</div></div>";
      open = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const mh = line.match(/^\*\*\s*(.+?)\s*:?\s*\*\*\s*(.*)$/);
    if (mh) {
      const name = prettyName(mh[1]);
      const col = colorFor(name);
      if (!speakers.includes(name)) speakers.push(name);
      close();
      out +=
        '<div class="tr-turn" style="--spk:' +
        col +
        '"><div class="tr-spk"><span class="tr-dot"></span>' +
        escapeHtml(spkDisplay(name)) +
        '</div><div class="tr-lines">';
      open = true;
      if (mh[2]) out += trLine(mh[2]);
      continue;
    }
    if (open) out += trLine(line);
    else out += '<p class="tr-plain">' + escapeHtml(line.replace(/^#+\s*/, "")) + "</p>";
  }
  close();
  if (!out) return '<p class="dd-empty">Kein Transkript.</p>';
  return spkAssignUI(speakers, opts) + out;
}

/** Apply a speaker-name map to a result/transcript markdown (host renamed speakers). */
export function applySpeakerMap(md: string, spkMap: Record<string, string>): string {
  if (!md || !Object.keys(spkMap).length) return md;
  return md.replace(/^\*\*\s*(.+?)\s*:\s*\*\*\s*$/gm, (m, nm) => {
    const d = spkMap[prettyName(nm)];
    return d ? "**" + d + ":**" : m;
  });
}
