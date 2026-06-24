import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { getConfig, setConfig } from "../lib/ipc";
import { setLanguage } from "../i18n";

/**
 * The Prompt Terminal — a floating Liquid-Glass window for drafting and
 * engineering prompts anywhere on the desktop (own Tauri window "prompt",
 * native vibrancy behind this view). Terminal-grade tab UX: drag-reorder,
 * pin (protect from close), duplicate, ⌘1–9 / ⌘T / ⌘W / ⌃Tab, plus a
 * command palette (⌘P).
 *
 * Iron rule: NOTHING is ever lost. Every edit auto-saves (debounced) to
 * prompts.json via the `prompts_save` IPC; hiding the window only hides it;
 * deleting a non-empty draft archives it into the library instead of
 * destroying it; dictated transcripts ("Terminal als Ziel") ride a Rust-side
 * pending queue that survives the webview's first boot.
 */

interface Draft {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  /** Pinned tabs sort to the front, show a pin marker, and are protected from
   *  one-click / ⌘W close (unpin first). */
  pinned?: boolean;
}

interface PromptData {
  version: 1;
  activeId: string;
  drafts: Draft[];
  library: Draft[];
}

/** Clean stroke icons — no emojis in the terminal chrome (design rule). */
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
  dup: ["M9 9h10v10H9z", "M5 15H4V5h10v1"],
  cmd: ["M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"],
  spark: ["M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3z"],
  eraser: ["M8 20H21", "M5.5 17.5L3 15a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L11.5 17.5H7z"],
  spell: ["M3 16l3-9 3 9", "M3.9 13h4.2", "M13 15l3 3 5-6"],
  check: ["M4 12.5l5 5L20 6.5"],
  micOn: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M19 11a7 7 0 0 1-14 0", "M12 18v3"],
  stop: ["M7 7h10v10H7z"],
};

/** Glass intensity levels — cycled from the header droplet. The CSS multiplies
 *  every shell/chip tint alpha by --pc-glass, so "clear" is genuinely more
 *  see-through, not just dimmer. */
const GLASS_LEVELS = ["clear", "regular", "rich"] as const;
type GlassLevel = (typeof GLASS_LEVELS)[number];
const GLASS_MUL: Record<GlassLevel, number> = { clear: 0.25, regular: 0.7, rich: 1.4 };
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
// into a QUESTION the terminal asks the user, plus a one-click template that
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

interface PalCmd {
  id: string;
  label: string;
  run: () => void;
}

// ---- Word-level diff for the AI-Coach "Refine" before/after view. ----
// Tokenize keeping whitespace so reconstruction is lossless, then LCS-diff the
// token streams. A heavy rewrite stays readable: kept words render plain,
// removed words struck through, added words highlighted.
type DiffSeg = { type: "same" | "add" | "del"; text: string };
const DIFF_TOKEN_CAP = 1200; // beyond this, skip the O(n·m) DP (see refine view)

const tokenizeDiff = (s: string) => s.split(/(\s+)/).filter((x) => x.length > 0);

function wordDiff(a: string, b: string): DiffSeg[] {
  const A = tokenizeDiff(a);
  const B = tokenizeDiff(b);
  // dp[i][j] = LCS length of A[i:] and B[j:].
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) push("same", A[i++]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < A.length) push("del", A[i++]);
  while (j < B.length) push("add", B[j++]);
  return out;
}

export function PromptConsole() {
  const { t } = useTranslation();
  const [data, setData] = useState<PromptData | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [onTop, setOnTop] = useState(true);
  const [asTarget, setAsTarget] = useState(false);
  const [glass, setGlass] = useState<GlassLevel>("clear");
  const [copied, setCopied] = useState(false);
  const [libQuery, setLibQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  // AI-Coach "Refine": rewrite the draft into a structured prompt, show a
  // before/after diff, accept or discard. `refineReq` guards against a stale
  // in-flight result landing after the user cancelled / started a new one.
  const [refining, setRefining] = useState(false);
  const [refineBase, setRefineBase] = useState("");
  const [refineResult, setRefineResult] = useState<string | null>(null);
  const [refineErr, setRefineErr] = useState<string | null>(null);
  const [refineView, setRefineView] = useState<"diff" | "result">("diff");
  const refineReq = useRef(0);
  // "Korrigieren": one-click tidy pass over the whole text (typos/punctuation),
  // applied directly with an undo (see `toast`). Loading flag drives the button.
  const [correcting, setCorrecting] = useState(false);
  // Bottom toast: undo for clear/correct (and brief status messages). Honors
  // the iron "nothing is lost" rule — destructive-ish actions snapshot the old
  // text into `toast.undo` so one click restores it.
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  // Autocorrect: native OS spellcheck + autocorrection on the editor. Off by
  // default (prompts often hold code/paths the OS would mangle); persisted in
  // localStorage so it's a self-contained per-device editor preference.
  const [autocorrect, setAutocorrect] = useState(() => {
    try {
      return localStorage.getItem("pc-autocorrect") === "1";
    } catch {
      return false;
    }
  });
  // Terminal-grade tab chrome: right-click context menu + command palette.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dragId = useRef<string | null>(null);

  /** Latest action set for the global shortcut handler (the keydown listener is
   *  mounted once, so it can't close over fresh state — we reassign this every
   *  render). */
  const actions = useRef<{
    paletteOpen: boolean;
    insert: () => void;
    copy: () => void;
    newTab: () => void;
    closeActive: () => void;
    duplicate: () => void;
    clear: () => void;
    jumpTo: (i: number) => void;
    cycle: (dir: number) => void;
    togglePalette: () => void;
    escape: () => void;
  } | null>(null);

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

  // ---- "Terminal als Ziel": drain the Rust-side transcript queue. ----
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

    // Global keyboard map (terminal muscle memory). The palette owns its own
    // keys while open; everything routes through the `actions` ref so it sees
    // fresh state.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        actions.current?.escape();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        actions.current?.togglePalette();
        return;
      }
      if (actions.current?.paletteOpen) return; // palette drives the rest
      if (e.key === "Enter") {
        e.preventDefault();
        actions.current?.insert();
      } else if (k === "k") {
        e.preventDefault();
        actions.current?.copy();
      } else if (k === "t") {
        e.preventDefault();
        actions.current?.newTab();
      } else if (k === "w") {
        e.preventDefault();
        actions.current?.closeActive();
      } else if (k === "d") {
        e.preventDefault();
        actions.current?.duplicate();
      } else if (k === "l") {
        e.preventDefault();
        actions.current?.clear();
      } else if (e.key === "Tab") {
        e.preventDefault();
        actions.current?.cycle(e.shiftKey ? -1 : 1);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        actions.current?.jumpTo(parseInt(e.key, 10) - 1);
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

  // ---- Draft / tab actions ----
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
        dr && dr.text.trim()
          ? [{ ...dr, pinned: false, title: tabLabel(dr, t("prompt.tabUntitled")), updatedAt: Date.now() }, ...d.library]
          : d.library;
      if (drafts.length === 0) drafts.push(newDraft());
      const activeId = d.activeId === id ? drafts[drafts.length - 1].id : d.activeId;
      return { ...d, activeId, drafts, library };
    });

  /** ⌘W / footer close — protects pinned tabs (unpin first). */
  const closeActive = () => {
    const cur = data.drafts.find((x) => x.id === data.activeId);
    if (cur?.pinned) return;
    closeTab(data.activeId);
  };

  const rename = (id: string, title: string) =>
    update((d) => ({
      ...d,
      drafts: d.drafts.map((dr) => (dr.id === id ? { ...dr, title } : dr)),
    }));

  /** Duplicate a tab right after the source, and focus the copy. */
  const duplicateTab = (id: string) =>
    update((d) => {
      const src = d.drafts.find((x) => x.id === id);
      if (!src) return d;
      const dr: Draft = { ...src, id: crypto.randomUUID(), pinned: false, updatedAt: Date.now() };
      const idx = d.drafts.findIndex((x) => x.id === id);
      const drafts = [...d.drafts];
      drafts.splice(idx + 1, 0, dr);
      return { ...d, activeId: dr.id, drafts };
    });

  /** Toggle pin. Pinning moves the tab to the front (browser-style). */
  const togglePinTab = (id: string) =>
    update((d) => {
      const drafts = d.drafts.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x));
      const target = drafts.find((x) => x.id === id);
      if (target?.pinned) {
        return { ...d, drafts: [target, ...drafts.filter((x) => x.id !== id)] };
      }
      return { ...d, drafts };
    });

  /** Drag-reorder: drop `fromId` at the position of `toId`. */
  const reorderTab = (fromId: string, toId: string) =>
    update((d) => {
      if (fromId === toId) return d;
      const drafts = [...d.drafts];
      const from = drafts.findIndex((x) => x.id === fromId);
      const to = drafts.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0) return d;
      const [moved] = drafts.splice(from, 1);
      drafts.splice(to, 0, moved);
      return { ...d, drafts };
    });

  const jumpTo = (i: number) => {
    const dr = data.drafts[i];
    if (dr) update((d) => ({ ...d, activeId: dr.id }));
  };

  const cycle = (dir: number) => {
    const i = data.drafts.findIndex((x) => x.id === data.activeId);
    if (i < 0) return;
    const n = (i + dir + data.drafts.length) % data.drafts.length;
    update((d) => ({ ...d, activeId: data.drafts[n].id }));
  };

  // ---- Clipboard / insert / library ----
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

  const copyEntry = (text: string) => invoke("copy_text", { text }).catch(() => {});

  const saveToLibrary = () => {
    if (!active.text.trim()) return;
    update((d) => ({
      ...d,
      library: [
        { ...active, id: crypto.randomUUID(), pinned: false, title: tabLabel(active, t("prompt.tabUntitled")), updatedAt: Date.now() },
        ...d.library,
      ],
    }));
  };

  const loadFromLibrary = (entry: Draft) =>
    update((d) => {
      const dr = { ...entry, id: crypto.randomUUID(), pinned: false, updatedAt: Date.now() };
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

  // ---- Window / view toggles ----
  const togglePin = () => {
    const next = !onTop;
    setOnTop(next);
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

  const toggleAutocorrect = () => {
    setAutocorrect((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("pc-autocorrect", next ? "1" : "0");
      } catch {
        /* private mode / blocked storage — pref just won't persist */
      }
      return next;
    });
  };

  const openCoach = () => {
    setCoachOpen(true);
    setLibOpen(false);
  };
  const openLibrary = () => {
    setLibOpen(true);
    setCoachOpen(false);
  };

  // ---- Bottom toast (undo for clear/correct + brief status) ----
  const showToast = (text: string, undo?: () => void) => {
    setToast({ text, undo });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setToast(null), 8000);
  };

  // ---- AI-Coach: Refine via /v1/cleanup style "prompt" ----
  const runRefine = () => {
    const base = active.text;
    if (!base.trim() || refining) return;
    const id = ++refineReq.current;
    flushNow();
    setRefineErr(null);
    setRefineResult(null);
    setRefineView("diff");
    setRefining(true);
    invoke<string>("prompt_cleanup", { text: base, style: "prompt" })
      .then((res) => {
        if (id !== refineReq.current) return; // cancelled / superseded
        setRefining(false);
        if (!res || !res.trim() || res.trim() === base.trim()) {
          setRefineErr(t("prompt.refine.noChange"));
          return;
        }
        setRefineBase(base);
        setRefineResult(res);
      })
      .catch(() => {
        if (id !== refineReq.current) return;
        setRefining(false);
        setRefineErr(t("prompt.refine.failed"));
      });
  };

  const cancelRefine = () => {
    refineReq.current++; // ignore any in-flight result
    setRefining(false);
    setRefineResult(null);
  };

  const acceptRefine = () => {
    if (refineResult) setText(refineResult);
    refineReq.current++;
    setRefineResult(null);
    setRefining(false);
    editorRef.current?.focus();
  };

  // ---- "Leeren": wipe the active tab, with an undo snapshot (never lost). ----
  const clearActive = () => {
    const base = active.text;
    if (!base) return; // already empty
    setText("");
    editorRef.current?.focus();
    showToast(t("prompt.clear.undo"), () => {
      setText(base);
      setToast(null);
      editorRef.current?.focus();
    });
  };

  // ---- "Korrigieren": one-click tidy pass over the whole text, with undo. ----
  const runCorrect = () => {
    const base = active.text;
    if (!base.trim() || correcting) return;
    flushNow();
    setCorrecting(true);
    invoke<string>("prompt_cleanup", { text: base, style: "tidy" })
      .then((res) => {
        setCorrecting(false);
        if (!res || !res.trim() || res.trim() === base.trim()) {
          showToast(t("prompt.correct.noChange"));
          return;
        }
        setText(res);
        showToast(t("prompt.correct.done"), () => {
          setText(base);
          setToast(null);
          editorRef.current?.focus();
        });
      })
      .catch(() => {
        setCorrecting(false);
        showToast(t("prompt.correct.failed"));
      });
  };

  const hide = () => {
    flushNow();
    invoke("prompt_console_toggle").catch(() => {});
  };

  // ---- Command palette (⌘P) ----
  const palItems: PalCmd[] = [
    { id: "new", label: t("prompt.cmd.newTab"), run: addTab },
    { id: "close", label: t("prompt.cmd.closeTab"), run: closeActive },
    { id: "dup", label: t("prompt.cmd.duplicate"), run: () => duplicateTab(data.activeId) },
    { id: "pin", label: t(active.pinned ? "prompt.cmd.unpin" : "prompt.cmd.pin"), run: () => togglePinTab(data.activeId) },
    { id: "copy", label: t("prompt.cmd.copy"), run: copy },
    { id: "insert", label: t("prompt.cmd.insert"), run: insert },
    { id: "save", label: t("prompt.cmd.saveToLibrary"), run: saveToLibrary },
    { id: "refine", label: t("prompt.cmd.refine"), run: runRefine },
    { id: "correct", label: t("prompt.cmd.correct"), run: runCorrect },
    { id: "clear", label: t("prompt.cmd.clear"), run: clearActive },
    { id: "autocorrect", label: t("prompt.cmd.autocorrect"), run: toggleAutocorrect },
    { id: "coach", label: t("prompt.cmd.coach"), run: openCoach },
    { id: "lib", label: t("prompt.cmd.library"), run: openLibrary },
    { id: "glass", label: t("prompt.cmd.glass"), run: cycleGlass },
    { id: "target", label: t("prompt.cmd.target"), run: toggleTarget },
    ...data.drafts.map((dr) => ({
      id: "tab:" + dr.id,
      label: `${t("prompt.cmd.tabPrefix")} ${tabLabel(dr, t("prompt.tabUntitled"))}`,
      run: () => update((d) => ({ ...d, activeId: dr.id })),
    })),
    ...data.library.map((e) => ({
      id: "lib:" + e.id,
      label: `${t("prompt.cmd.libPrefix")} ${e.title || tabLabel(e, t("prompt.tabUntitled"))}`,
      run: () => loadFromLibrary(e),
    })),
  ];
  const pq = paletteQuery.trim().toLowerCase();
  const palFiltered = pq ? palItems.filter((c) => c.label.toLowerCase().includes(pq)) : palItems;
  const palIdx = Math.min(paletteIdx, Math.max(0, palFiltered.length - 1));

  const openPalette = () => {
    setPaletteQuery("");
    setPaletteIdx(0);
    setPaletteOpen(true);
  };
  const runPal = (c: PalCmd) => {
    setPaletteOpen(false);
    c.run();
  };

  actions.current = {
    paletteOpen,
    insert,
    copy,
    newTab: addTab,
    closeActive,
    duplicate: () => duplicateTab(data.activeId),
    clear: clearActive,
    jumpTo,
    cycle,
    togglePalette: () => (paletteOpen ? setPaletteOpen(false) : openPalette()),
    escape: () => {
      if (paletteOpen) return setPaletteOpen(false);
      if (refining || refineResult) return cancelRefine();
      if (menu) return setMenu(null);
      if (renaming) return setRenaming(null);
      hide();
    },
  };

  const menuDraft = menu ? data.drafts.find((x) => x.id === menu.id) : null;
  const diffSegs =
    refineResult && refineBase.length + refineResult.length < DIFF_TOKEN_CAP * 12
      ? wordDiff(refineBase, refineResult)
      : null;

  return (
    <div className="pc-shell" data-glass={glass} style={{ "--pc-glass": GLASS_MUL[glass] } as CSSProperties}>
      <header className="pc-head" data-tauri-drag-region>
        <span className="pc-glyph" data-tauri-drag-region>✦</span>
        <span className="pc-title" data-tauri-drag-region>{t("prompt.title")}</span>
        <div className="pc-head-actions">
          <button className="pc-icon" title={t("prompt.paletteHint")} onClick={openPalette}>
            <Ico paths={ICONS.search} />
          </button>
          <button
            className={`pc-icon ${autocorrect ? "on" : ""}`}
            title={t("prompt.autocorrect", { state: t(autocorrect ? "common.on" : "common.off") })}
            onClick={toggleAutocorrect}
          >
            <Ico paths={ICONS.spell} />
          </button>
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
          <button className={`pc-icon ${onTop ? "on" : ""}`} title={t("prompt.pin")} onClick={togglePin}>
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
            className={`pc-tab ${dr.id === data.activeId ? "active" : ""} ${dr.pinned ? "pinned" : ""} ${
              dragOverId === dr.id ? "drop-target" : ""
            }`}
            draggable={renaming !== dr.id}
            onClick={() => update((d) => ({ ...d, activeId: dr.id }))}
            onDoubleClick={() => setRenaming(dr.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: dr.id, x: e.clientX, y: e.clientY });
            }}
            onDragStart={() => (dragId.current = dr.id)}
            onDragOver={(e) => {
              if (dragId.current && dragId.current !== dr.id) {
                e.preventDefault();
                if (dragOverId !== dr.id) setDragOverId(dr.id);
              }
            }}
            onDragLeave={() => setDragOverId((id) => (id === dr.id ? null : id))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.current) reorderTab(dragId.current, dr.id);
              dragId.current = null;
              setDragOverId(null);
            }}
            onDragEnd={() => {
              dragId.current = null;
              setDragOverId(null);
            }}
            title={t("prompt.tabHint")}
          >
            {dr.pinned && (
              <span className="pc-tab-pin" title={t("prompt.menu.unpin")}>
                <Ico paths={ICONS.pin} filled size={10} />
              </span>
            )}
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
                {!dr.pinned && (
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
          spellCheck={autocorrect}
          autoCorrect={autocorrect ? "on" : "off"}
          autoCapitalize="off"
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
            <div className="pc-refine-bar">
              <div className="pc-refine-row">
                <button
                  className="pc-btn refine"
                  onClick={runCorrect}
                  disabled={correcting || refining || !active.text.trim()}
                  title={t("prompt.correct.hint")}
                >
                  <Ico paths={ICONS.check} size={13} />
                  {correcting ? t("prompt.correct.loading") : t("prompt.correct.button")}
                </button>
                <button
                  className="pc-btn primary refine"
                  onClick={runRefine}
                  disabled={refining || correcting || !active.text.trim()}
                  title={t("prompt.refine.hint")}
                >
                  <Ico paths={ICONS.spark} filled size={12} />
                  {refining ? t("prompt.refine.loading") : t("prompt.refine.button")}
                </button>
              </div>
              {refineErr && <span className="pc-refine-err">{refineErr}</span>}
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
        {(refining || refineResult) && (
          <div className="pc-refine">
            <div className="pc-refine-head">
              <span className="pc-refine-title">
                <Ico paths={ICONS.spark} filled size={12} /> {t("prompt.refine.title")}
              </span>
              {refineResult && diffSegs && (
                <div className="pc-seg">
                  <button
                    className={refineView === "diff" ? "on" : ""}
                    onClick={() => setRefineView("diff")}
                  >
                    {t("prompt.refine.viewDiff")}
                  </button>
                  <button
                    className={refineView === "result" ? "on" : ""}
                    onClick={() => setRefineView("result")}
                  >
                    {t("prompt.refine.viewResult")}
                  </button>
                </div>
              )}
            </div>
            <div className="pc-refine-body">
              {refining ? (
                <div className="pc-refine-loading">
                  <span className="pc-spinner" />
                  {t("prompt.refine.loading")}
                </div>
              ) : refineView === "diff" && diffSegs ? (
                <div className="pc-diff">
                  {diffSegs.map((s, i) => (
                    <span key={i} className={`pc-d-${s.type}`}>
                      {s.text}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="pc-diff">{refineResult}</div>
              )}
            </div>
            {refineResult && (
              <div className="pc-refine-foot">
                <button className="pc-btn" onClick={cancelRefine}>
                  {t("prompt.refine.reject")}
                </button>
                <button className="pc-btn primary" onClick={acceptRefine}>
                  {t("prompt.refine.accept")}
                </button>
              </div>
            )}
          </div>
        )}
        {toast && (
          <div className="pc-undo">
            <span className="pc-undo-text">{toast.text}</span>
            {toast.undo && (
              <button className="pc-undo-btn" onClick={toast.undo}>
                {t("prompt.clear.undoAction")}
              </button>
            )}
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
            onClick={() => (coachOpen ? setCoachOpen(false) : openCoach())}
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
            onClick={() => (libOpen ? setLibOpen(false) : openLibrary())}
          >
            <Ico paths={ICONS.lib} size={12} />
          </button>
          <button className="pc-btn" onClick={clearActive} disabled={!active.text} title={t("prompt.clear.hint")}>
            <Ico paths={ICONS.eraser} size={13} />
          </button>
          <button className="pc-btn" onClick={copy} disabled={!active.text} title={t("prompt.copyHint")}>
            {copied ? t("prompt.copied") : t("prompt.copy")}
          </button>
          <button className="pc-btn primary" onClick={insert} disabled={!active.text.trim()} title={t("prompt.insertHint")}>
            {t("prompt.insert")}
          </button>
        </div>
      </footer>

      {/* Tab context menu (right-click) */}
      {menu && menuDraft && (
        <>
          <div
            className="pc-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="pc-menu" style={{ top: menu.y, left: Math.min(menu.x, window.innerWidth - 168) }}>
            <button onClick={() => { setRenaming(menu.id); setMenu(null); }}>{t("prompt.menu.rename")}</button>
            <button onClick={() => { duplicateTab(menu.id); setMenu(null); }}>{t("prompt.menu.duplicate")}</button>
            <button onClick={() => { togglePinTab(menu.id); setMenu(null); }}>
              {t(menuDraft.pinned ? "prompt.menu.unpin" : "prompt.menu.pin")}
            </button>
            <button
              className="danger"
              onClick={() => { closeTab(menu.id); setMenu(null); }}
            >
              {menuDraft.text.trim() ? t("prompt.menu.archive") : t("prompt.menu.close")}
            </button>
          </div>
        </>
      )}

      {/* Command palette (⌘P) */}
      {paletteOpen && (
        <>
          <div className="pc-backdrop" onClick={() => setPaletteOpen(false)} />
          <div className="pc-palette">
            <div className="pc-palette-input">
              <Ico paths={ICONS.cmd} size={13} />
              <input
                autoFocus
                value={paletteQuery}
                placeholder={t("prompt.palette.placeholder")}
                spellCheck={false}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setPaletteIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPaletteIdx((i) => Math.min(i + 1, palFiltered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPaletteIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const c = palFiltered[palIdx];
                    if (c) runPal(c);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setPaletteOpen(false);
                  }
                  e.stopPropagation();
                }}
              />
            </div>
            <div className="pc-palette-list">
              {palFiltered.length === 0 && <div className="pc-palette-empty">{t("prompt.palette.empty")}</div>}
              {palFiltered.map((c, i) => (
                <div
                  key={c.id}
                  className={`pc-palette-row ${i === palIdx ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIdx(i)}
                  onClick={() => runPal(c)}
                >
                  {c.label}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
