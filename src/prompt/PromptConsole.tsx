import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { getConfig, setConfig } from "../lib/ipc";
import { setLanguage } from "../i18n";

/**
 * The Prompt Console — a floating Liquid-Glass window for drafting and
 * engineering prompts anywhere on the desktop (own Tauri window "prompt",
 * native vibrancy behind this view).
 *
 * Iron rule: NOTHING is ever lost. Every edit auto-saves (debounced) to
 * prompts.json via the `prompts_save` IPC; hiding the window only hides it;
 * deleting a non-empty draft archives it into the library instead of
 * destroying it; dictated transcripts ("Konsole als Ziel") ride a Rust-side
 * pending queue that survives the webview's first boot.
 */

interface Draft {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
}

interface PromptData {
  version: 1;
  activeId: string;
  drafts: Draft[];
  library: Draft[];
}

/** Clean stroke icons — no emojis in the console chrome (design rule). */
function Ico({ paths, filled = false, size = 13 }: { paths: string[]; filled?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

const ICONS = {
  mic: ["M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z", "M19 11a7 7 0 0 1-14 0", "M12 18v4"],
  pin: ["M9 3h6l-.7 6.2 3.2 3.3H6.5l3.2-3.3L9 3z", "M12 12.5V21"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  bolt: ["M13 2L4.5 13.5H10l-1 8.5L19.5 10H13l1-8z"],
  lib: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"],
  drop: ["M12 2.7s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M21 21l-4.8-4.8"],
};

/** Glass intensity levels — cycled from the header droplet. The CSS multiplies
 *  every shell/chip tint alpha by --pc-glass, so "clear" is genuinely more
 *  see-through, not just dimmer. */
const GLASS_LEVELS = ["clear", "regular", "rich"] as const;
type GlassLevel = (typeof GLASS_LEVELS)[number];
const GLASS_MUL: Record<GlassLevel, number> = { clear: 0.45, regular: 0.9, rich: 1.5 };
const asGlass = (v: string): GlassLevel =>
  (GLASS_LEVELS as readonly string[]).includes(v) ? (v as GlassLevel) : "clear";

const newDraft = (text = ""): Draft => ({
  id: crypto.randomUUID(),
  title: "",
  text,
  updatedAt: Date.now(),
});

const emptyData = (): PromptData => {
  const d = newDraft();
  return { version: 1, activeId: d.id, drafts: [d], library: [] };
};

function parseData(raw: string): PromptData {
  try {
    const p = JSON.parse(raw) as PromptData;
    if (!Array.isArray(p.drafts) || p.drafts.length === 0) return emptyData();
    if (!Array.isArray(p.library)) p.library = [];
    if (!p.drafts.some((d) => d.id === p.activeId)) p.activeId = p.drafts[0].id;
    return { ...p, version: 1 };
  } catch {
    return raw.trim() ? { ...emptyData(), drafts: [newDraft(raw)] } : emptyData();
  }
}

/** Tab label: explicit title > first words of the text > untitled. */
const tabLabel = (d: Draft, untitled: string) =>
  d.title.trim() || d.text.trim().slice(0, 16).trim() || untitled;

// ---- Prompt-Coach: autonomous context elicitation. ----
// Heuristic checks for the building blocks of a strong prompt (goal, role,
// context, format, audience, examples, constraints). Every unmet block turns
// into a QUESTION the console asks the user, plus a one-click template that
// scaffolds the missing piece — actively coaxing good context out of the user
// so the downstream AI can deliver. Local + instant (no network); an
// AI-powered refine on top is the planned next stage.
const COACH_KEYS = ["goal", "role", "context", "format", "audience", "examples", "constraints"] as const;
type CoachKey = (typeof COACH_KEYS)[number];

function analyzePrompt(text: string): Record<CoachKey, boolean> {
  const t = text.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  return {
    goal: text.trim().length >= 25,
    role: has(/\b(du bist|you are|act as|agiere als|verhalte dich wie|als (erfahrene?r? )?(experte|expertin|profi)|rolle\s*:|role\s*:)/),
    context: has(/(kontext|hintergrund|context|background|situation|ausgangslage|gegeben)/) || text.trim().length >= 400,
    format:
      has(/(format|liste|tabelle|json|markdown|stichpunkt|bullet|gliederung|absatz|abschnitt|paragraph|table|list|outline)/) ||
      has(/(wörter|words|zeichen|characters|sätze|sentences|länge|length|seiten|pages)/),
    audience: has(/(zielgruppe|audience|leser|reader|für (anfänger|einsteiger|experten|kunden|kinder|laien|entwickler|beginners|experts|customers|developers))/),
    examples: has(/(z\.\s?b\.|beispiel|example|e\.\s?g\.|wie folgt|etwa so|zum beispiel|for instance)/),
    constraints: has(/(vermeide|avoid|verzichte|keinesfalls|auf keinen fall|don'?t|max\.|maximal|höchstens|mindestens|at (most|least)|\bstil\b|\bton\b|tonalität|\btone\b|grenzen|einschränkung)/),
  };
}

export function PromptConsole() {
  const { t } = useTranslation();
  const [data, setData] = useState<PromptData | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [asTarget, setAsTarget] = useState(false);
  const [glass, setGlass] = useState<GlassLevel>("clear");
  const [copied, setCopied] = useState(false);
  const [libQuery, setLibQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  /** Latest copy/insert actions for the global shortcut handler (the keydown
   *  listener is mounted once, so it can't close over fresh state). */
  const actions = useRef<{ insert: () => void; copy: () => void } | null>(null);

  // ---- Persistence: debounce every change; flush on blur/hide. ----
  const latest = useRef<PromptData | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  latest.current = data;

  const flushNow = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    if (dirty.current && latest.current) {
      dirty.current = false;
      invoke("prompts_save", { data: JSON.stringify(latest.current) }).catch(() => {
        dirty.current = true; // retry on the next change/flush
      });
    }
  };

  const update = (fn: (d: PromptData) => PromptData) => {
    setData((d) => {
      if (!d) return d;
      const next = fn(d);
      dirty.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flushNow, 400);
      return next;
    });
  };

  // ---- "Konsole als Ziel": drain the Rust-side transcript queue. ----
  const drainPending = () =>
    invoke<string[]>("prompt_take_pending")
      .then((pending) => {
        if (!pending.length) return;
        update((d) => ({
          ...d,
          drafts: d.drafts.map((dr) =>
            dr.id === d.activeId
              ? {
                  ...dr,
                  text: (dr.text.trim() ? dr.text.replace(/\s+$/, "") + "\n\n" : "") + pending.join("\n\n"),
                  updatedAt: Date.now(),
                }
              : dr,
          ),
        }));
        setFlash(true);
        window.setTimeout(() => setFlash(false), 900);
      })
      .catch(() => {});

  useEffect(() => {
    invoke<string>("prompts_load")
      .then((raw) => setData(parseData(raw)))
      .catch(() => setData(emptyData()));
    getConfig()
      .then((c) => {
        setLanguage(c.ui_language || "de");
        setAsTarget(!!c.prompt_console_as_target);
        setGlass(asGlass(c.prompt_console_glass));
      })
      .catch(() => {});

    const unTranscript = listen("echo://prompt-transcript", drainPending);
    drainPending(); // anything queued while this webview was booting

    // ESC hides (never destroys) the console; flush the draft first.
    // ⌘/Ctrl+Enter inserts into the app behind, ⌘/Ctrl+K copies.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        flushNow();
        invoke("prompt_console_toggle").catch(() => {});
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "Enter") {
          e.preventDefault();
          actions.current?.insert();
        } else if (e.key.toLowerCase() === "k") {
          e.preventDefault();
          actions.current?.copy();
        }
      }
    };
    const onBlurOrHide = () => flushNow();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlurOrHide);
    document.addEventListener("visibilitychange", onBlurOrHide);
    return () => {
      unTranscript.then((f) => f());
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlurOrHide);
      document.removeEventListener("visibilitychange", onBlurOrHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;
  const active = data.drafts.find((d) => d.id === data.activeId) ?? data.drafts[0];
  const chars = active.text.length;
  const words = active.text.trim() ? active.text.trim().split(/\s+/).length : 0;
  const tokens = Math.ceil(chars / 4);
  const checks = analyzePrompt(active.text);
  const metCount = COACH_KEYS.filter((k) => checks[k]).length;
  const score = Math.round((metCount / COACH_KEYS.length) * 100);
  const q = libQuery.trim().toLowerCase();
  const libFiltered = q
    ? data.library.filter((e) => (e.title + " " + e.text).toLowerCase().includes(q))
    : data.library;

  // ---- Actions ----
  const setText = (text: string) =>
    update((d) => ({
      ...d,
      drafts: d.drafts.map((dr) => (dr.id === d.activeId ? { ...dr, text, updatedAt: Date.now() } : dr)),
    }));

  const addTab = () =>
    update((d) => {
      const dr = newDraft();
      return { ...d, activeId: dr.id, drafts: [...d.drafts, dr] };
    });

  /** Close a tab. A non-empty draft is ARCHIVED into the library (never lost). */
  const closeTab = (id: string) =>
    update((d) => {
      const dr = d.drafts.find((x) => x.id === id);
      const drafts = d.drafts.filter((x) => x.id !== id);
      const library =
        dr && dr.text.trim() ? [{ ...dr, title: tabLabel(dr, t("prompt.tabUntitled")), updatedAt: Date.now() }, ...d.library] : d.library;
      if (drafts.length === 0) drafts.push(newDraft());
      const activeId = d.activeId === id ? drafts[drafts.length - 1].id : d.activeId;
      return { ...d, activeId, drafts, library };
    });

  const rename = (id: string, title: string) =>
    update((d) => ({
      ...d,
      drafts: d.drafts.map((dr) => (dr.id === id ? { ...dr, title } : dr)),
    }));

  const copy = () => {
    if (!active.text) return;
    invoke("copy_text", { text: active.text })
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  const insert = () => {
    if (!active.text.trim()) return;
    flushNow();
    invoke("prompt_insert", { text: active.text }).catch(() => {});
  };

  actions.current = { insert, copy };

  const copyEntry = (text: string) => invoke("copy_text", { text }).catch(() => {});

  const saveToLibrary = () => {
    if (!active.text.trim()) return;
    update((d) => ({
      ...d,
      library: [
        { ...active, id: crypto.randomUUID(), title: tabLabel(active, t("prompt.tabUntitled")), updatedAt: Date.now() },
        ...d.library,
      ],
    }));
  };

  const loadFromLibrary = (entry: Draft) =>
    update((d) => {
      const dr = { ...entry, id: crypto.randomUUID(), updatedAt: Date.now() };
      return { ...d, activeId: dr.id, drafts: [...d.drafts, dr] };
    });

  const deleteFromLibrary = (id: string) =>
    update((d) => ({ ...d, library: d.library.filter((e) => e.id !== id) }));

  /** Coach "+": scaffold the missing building block at the end of the draft. */
  const addCoachTemplate = (key: CoachKey) => {
    const base = active.text.replace(/\s+$/, "");
    setText((base ? base + "\n\n" : "") + t(`prompt.coach.tpl.${key}`));
    editorRef.current?.focus();
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    getCurrentWindow().setAlwaysOnTop(next).catch(() => {});
  };

  /** Cycle the glass intensity: clear → regular → rich. Persisted in config. */
  const cycleGlass = () => {
    const next = GLASS_LEVELS[(GLASS_LEVELS.indexOf(glass) + 1) % GLASS_LEVELS.length];
    setGlass(next);
    getConfig()
      .then((c) => setConfig({ ...c, prompt_console_glass: next }))
      .catch(() => {});
  };

  const toggleTarget = () => {
    const next = !asTarget;
    setAsTarget(next);
    getConfig()
      .then((c) => setConfig({ ...c, prompt_console_as_target: next }))
      .catch(() => setAsTarget(!next));
  };

  const hide = () => {
    flushNow();
    invoke("prompt_console_toggle").catch(() => {});
  };

  return (
    <div className="pc-shell" data-glass={glass} style={{ "--pc-glass": GLASS_MUL[glass] } as CSSProperties}>
      <header className="pc-head" data-tauri-drag-region>
        <span className="pc-glyph" data-tauri-drag-region>✦</span>
        <span className="pc-title" data-tauri-drag-region>{t("prompt.title")}</span>
        <div className="pc-head-actions">
          <button className="pc-icon" title={t("prompt.glass", { level: t(`prompt.glassLevel.${glass}`) })} onClick={cycleGlass}>
            <Ico paths={ICONS.drop} />
          </button>
          <button
            className={`pc-icon ${asTarget ? "on" : ""}`}
            title={t("prompt.targetHint")}
            onClick={toggleTarget}
          >
            <Ico paths={ICONS.mic} />
          </button>
          <button className={`pc-icon ${pinned ? "on" : ""}`} title={t("prompt.pin")} onClick={togglePin}>
            <Ico paths={ICONS.pin} />
          </button>
          <button className="pc-icon" title={t("prompt.close")} onClick={hide}>
            <Ico paths={ICONS.x} size={12} />
          </button>
        </div>
      </header>

      <div className="pc-tabs">
        {data.drafts.map((dr) => (
          <div
            key={dr.id}
            className={`pc-tab ${dr.id === data.activeId ? "active" : ""}`}
            onClick={() => update((d) => ({ ...d, activeId: dr.id }))}
            onDoubleClick={() => setRenaming(dr.id)}
            title={t("prompt.tabHint")}
          >
            {renaming === dr.id ? (
              <input
                className="pc-rename"
                autoFocus
                defaultValue={dr.title}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  rename(dr.id, e.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <>
                <span className="pc-tab-label">{tabLabel(dr, t("prompt.tabUntitled"))}</span>
                {data.drafts.length > 0 && (
                  <span
                    className="pc-tab-x"
                    title={dr.text.trim() ? t("prompt.tabArchive") : t("prompt.tabClose")}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(dr.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </>
            )}
          </div>
        ))}
        <button className="pc-tab-add" title={t("prompt.newTab")} onClick={addTab}>
          +
        </button>
      </div>

      <div className="pc-body">
        <textarea
          ref={editorRef}
          className={`pc-editor ${flash ? "pc-flash" : ""}`}
          value={active.text}
          placeholder={t("prompt.placeholder")}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        {coachOpen && (
          <div className="pc-coach">
            <div className="pc-coach-head">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Ico paths={ICONS.bolt} filled size={12} /> {t("prompt.coach.title")}
              </span>
              <div className="pc-score">
                <div className="pc-score-fill" style={{ width: `${score}%` }} />
              </div>
              <span className="pc-score-num">{score}%</span>
            </div>
            <div className="pc-coach-list">
              {score === 100 && <div className="pc-coach-all">✓ {t("prompt.coach.allGood")}</div>}
              {/* All 7 building blocks, ALWAYS in the same order — rows change
                  state in place instead of jumping between sections while the
                  user types. */}
              {COACH_KEYS.map((k) => (
                <div key={k} className={`pc-coach-row ${checks[k] ? "met" : ""}`}>
                  <div className="pc-coach-top">
                    <span className="pc-coach-name">{t(`prompt.coach.name.${k}`)}</span>
                    {checks[k] ? (
                      <span className="pc-coach-ok">
                        <span className="pc-check">✓</span> {t(`prompt.coach.ok.${k}`)}
                      </span>
                    ) : (
                      <button className="pc-btn" onClick={() => addCoachTemplate(k)}>
                        {t("prompt.coach.add")}
                      </button>
                    )}
                  </div>
                  {!checks[k] && <div className="pc-coach-q">{t(`prompt.coach.q.${k}`)}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {libOpen && (
          <div className="pc-lib">
            <div className="pc-lib-head">
              <span>{t("prompt.library")}</span>
              <div className="pc-lib-search">
                <Ico paths={ICONS.search} size={11} />
                <input
                  value={libQuery}
                  placeholder={t("prompt.librarySearch")}
                  spellCheck={false}
                  onChange={(e) => setLibQuery(e.target.value)}
                />
              </div>
              <button className="pc-btn" onClick={saveToLibrary} disabled={!active.text.trim()}>
                {t("prompt.saveToLibrary")}
              </button>
            </div>
            <div className="pc-lib-list">
              {data.library.length === 0 && <div className="pc-lib-empty">{t("prompt.libraryEmpty")}</div>}
              {data.library.length > 0 && libFiltered.length === 0 && (
                <div className="pc-lib-empty">{t("prompt.libraryNoMatch")}</div>
              )}
              {libFiltered.map((e) => (
                <div key={e.id} className="pc-lib-row" onClick={() => loadFromLibrary(e)} title={e.text.slice(0, 400)}>
                  <div className="pc-lib-meta">
                    <span className="pc-lib-title">{e.title || t("prompt.tabUntitled")}</span>
                    <span className="pc-lib-sub">
                      {e.text.length} · {new Date(e.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    className="pc-icon"
                    title={t("prompt.libraryCopy")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      copyEntry(e.text);
                    }}
                  >
                    <Ico paths={ICONS.copy} size={12} />
                  </button>
                  <button
                    className="pc-icon"
                    title={t("prompt.libraryDelete")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      deleteFromLibrary(e.id);
                    }}
                  >
                    <Ico paths={ICONS.trash} size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="pc-foot">
        <span className="pc-count">
          {chars} · {words} {t("prompt.words")} · ~{tokens} {t("prompt.tokens")}
        </span>
        <div className="pc-foot-actions">
          <button
            className={`pc-btn ${coachOpen ? "on" : ""}`}
            title={t("prompt.coach.title")}
            onClick={() => {
              setCoachOpen(!coachOpen);
              setLibOpen(false);
            }}
          >
            <span className="pc-dots">
              {COACH_KEYS.map((k) => (
                <i key={k} className={checks[k] ? "on" : ""} />
              ))}
            </span>
            {score}%
          </button>
          <button
            className={`pc-btn ${libOpen ? "on" : ""}`}
            title={t("prompt.library")}
            onClick={() => {
              setLibOpen(!libOpen);
              setCoachOpen(false);
            }}
          >
            <Ico paths={ICONS.lib} size={12} />
          </button>
          <button className="pc-btn" onClick={copy} disabled={!active.text} title={t("prompt.copyHint")}>
            {copied ? t("prompt.copied") : t("prompt.copy")}
          </button>
          <button className="pc-btn primary" onClick={insert} disabled={!active.text.trim()} title={t("prompt.insertHint")}>
            {t("prompt.insert")}
          </button>
        </div>
      </footer>
    </div>
  );
}
