// Single source of truth for Echo's user-facing changelog. Feeds BOTH the
// in-app changelog view (Help + Settings→About) AND the "What's new" popup that
// appears once after an update. Keep entries newest-first and customer-facing
// (benefits, not internals) — bilingual de/en; every other UI language falls
// back to en (same convention as faq.ts).
//
// RELEASE DISCIPLINE: every tagged release adds a new entry at the TOP whose
// `version` matches package.json / tauri.conf.json. The popup keys off this.

export type ChangeKind = "feature" | "improvement" | "fix";

export interface ChangeItem {
  kind: ChangeKind;
  de: string;
  en: string;
}

export interface ChangelogEntry {
  /** e.g. "0.5.76" — must match the shipped app version. */
  version: string;
  /** ISO date yyyy-mm-dd. */
  date: string;
  title: { de: string; en: string };
  changes: ChangeItem[];
}

// localStorage key holding the last version the user acknowledged (shared by
// WhatsNew + the onboarding pre-seed so a fresh install skips the popup).
export const LAST_SEEN_KEY = "echo:lastSeenVersion";

// Newest first. Trim to meaningful, user-noticeable changes — not every patch.
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.85",
    date: "2026-07-07",
    title: { de: "Euro, Prozent & Einheiten automatisch als Symbol", en: "Euro, percent & units as symbols automatically" },
    changes: [
      {
        kind: "improvement",
        de: "Die DACH-Formatierung ist jetzt standardmäßig an: „50 Euro“ → „50 €“, „fünfzig Prozent“ → „50 %“, „zehn Kilometer“ → „10 km“ (auch km/cm/mm/kg/g/l), dazu „z.B.“ → „z. B.“ und deutsche Anführungszeichen. Deterministisch, ohne zusätzliche Latenz. Mehrdeutiges bleibt unangetastet. Abschaltbar unter Einstellungen → Cleanup → „DACH-Formatierung“.",
        en: "DACH formatting is now on by default: „50 Euro“ → „50 €“, „fifty percent“ → „50 %“, „ten kilometers“ → „10 km“ (also km/cm/mm/kg/g/l), plus „z.B.“ → „z. B.“ and German quotation marks. Deterministic, no added latency. Ambiguous cases are left alone. Turn it off under Settings → Cleanup → „DACH formatting“.",
      },
    ],
  },
  {
    version: "0.5.84",
    date: "2026-07-07",
    title: { de: "Füllwörter fliegen automatisch raus", en: "Filler words are removed automatically" },
    changes: [
      {
        kind: "improvement",
        de: "„äh“, „ähm“, „hmm“ und ähnliche Verzögerungslaute werden jetzt standardmäßig aus deinem Diktat entfernt — deterministisch und ohne zusätzliche Latenz, auch ohne KI-Cleanup. Echte Wörter bleiben unberührt. Abschaltbar unter Einstellungen → Cleanup → „Füllwörter entfernen“.",
        en: "„äh“, „ähm“, „hmm“ and similar hesitation sounds are now removed from your dictation by default — deterministic and with no added latency, even without AI cleanup. Real words stay untouched. Turn it off under Settings → Cleanup → „Remove filler words“.",
      },
    ],
  },
  {
    version: "0.5.83",
    date: "2026-07-06",
    title: { de: "Meetings passen jetzt aufs Fenster — kein Scrollen", en: "Meetings now fit the window — no scrolling" },
    changes: [
      {
        kind: "improvement",
        de: "Der Meeting-Bereich ist auf ein ruhiges 2-Spalten-Layout umgestellt: Beitritts-Code, QR und Teilnehmer stehen nebeneinander und passen ohne Scrollen ins Fenster — statisch bedienbar wie die übrigen Menüpunkte.",
        en: "The meeting area now uses a calm two-column layout: join code, QR and participants sit side by side and fit the window without scrolling — as static and tidy as the other menu items.",
      },
      {
        kind: "fix",
        de: "Das Postfach oben rechts öffnet sich jetzt zuverlässig VOR dem Inhalt statt dahinter zu verschwinden.",
        en: "The notification inbox (top right) now reliably opens in front of the content instead of disappearing behind it.",
      },
    ],
  },
  {
    version: "0.5.82",
    date: "2026-07-06",
    title: { de: "Notiz-Ordner synchronisieren jetzt auch", en: "Note folders now sync too" },
    changes: [
      {
        kind: "improvement",
        de: "Deine Notiz-Ordner (mit Symbol und Farbe) synchronisieren jetzt als eigene Objekte über alle Geräte — auch leere Ordner erscheinen auf iPhone und PC.",
        en: "Your note folders (with icon and colour) now sync as first-class objects across every device — even empty folders show up on both iPhone and PC.",
      },
    ],
  },
  {
    version: "0.5.81",
    date: "2026-07-06",
    title: { de: "Postfach — Benachrichtigungen oben rechts", en: "Inbox — notifications, top-right" },
    changes: [
      {
        kind: "feature",
        de: "Neu: ein Postfach oben rechts (die Glocke). Es bündelt verfügbare Updates und „Was ist neu“ an einer Stelle — mit einem Punkt, sobald es etwas Neues gibt.",
        en: "New: an inbox top-right (the bell). It gathers available updates and “what’s new” in one place — with a dot whenever something’s new.",
      },
    ],
  },
  {
    version: "0.5.80",
    date: "2026-07-06",
    title: { de: "Meetings neu — nativ & aufgeräumt", en: "Meetings, rebuilt — native & tidy" },
    changes: [
      {
        kind: "improvement",
        de: "Der Meeting-Bereich wurde komplett neu gebaut und fügt sich jetzt nahtlos in Echo ein — dasselbe ruhige Glas-Design wie im Rest der App statt der bisherigen aufgesetzten Ansicht.",
        en: "The meeting area has been rebuilt from the ground up and now blends seamlessly into Echo — the same calm glass design as the rest of the app instead of the previous bolted-on look.",
      },
      {
        kind: "feature",
        de: "Cloud-Meeting und lokales Meeting liegen jetzt auf einer Seite mit einem Umschalter — Beitritts-Code, QR, Teilnehmer, Timer und Stimm-Check-In alle im gewohnten Look.",
        en: "Cloud meeting and local meeting now share one page with a single switch — join code, QR, participants, timer and voice check-in all in the familiar look.",
      },
    ],
  },
  {
    version: "0.5.79",
    date: "2026-07-06",
    title: { de: "Notizen — synchron mit deinem iPhone", en: "Notes — in sync with your iPhone" },
    changes: [
      {
        kind: "feature",
        de: "Neu: der Bereich „Notizen“ in der Seitenleiste. Sprich Notizen ein oder tippe sie, ordne sie in Ordner/Projekte (z. B. „Prompts“) und kopiere jeden Text mit einem Klick.",
        en: "New: a “Notes” section in the sidebar. Speak notes or type them, sort them into folders/projects (e.g. “Prompts”), and copy any note's text with a single click.",
      },
      {
        kind: "feature",
        de: "Deine Notizen sind dauerhaft mit der Echo-iPhone-App synchron: Was du unterwegs aufs iPhone sprichst, liegt hier am PC bereit — und umgekehrt.",
        en: "Your notes stay permanently in sync with the Echo iPhone app: what you dictate on your phone while out is ready here on your PC — and vice-versa.",
      },
    ],
  },
  {
    version: "0.5.78",
    date: "2026-07-06",
    title: { de: "Aufgeräumtes Konto & Änderungsprotokoll", en: "Tidied account & changelog" },
    changes: [
      {
        kind: "improvement",
        de: "Die Konto-Karte unten links zeigt jetzt deinen Plan (z. B. „Pro“) statt der abgeschnittenen E-Mail.",
        en: "The account card (bottom-left) now shows your plan (e.g. “Pro”) instead of the truncated email.",
      },
      {
        kind: "improvement",
        de: "Das Änderungsprotokoll liegt jetzt gebündelt an einer Stelle: „Einstellungen → Über Echo“.",
        en: "The changelog now lives in one place: Settings → About.",
      },
    ],
  },
  {
    version: "0.5.77",
    date: "2026-07-06",
    title: { de: "„Was ist neu“ erscheint zuverlässig", en: "“What’s new” shows reliably" },
    changes: [
      {
        kind: "fix",
        de: "Der „Was ist neu“-Hinweis erscheint jetzt zuverlässig nach einem Update — auch wenn du von einer älteren Version kommst.",
        en: "The “What’s new” note now appears reliably after an update — including when you come from an older version.",
      },
    ],
  },
  {
    version: "0.5.76",
    date: "2026-07-06",
    title: { de: "Änderungsprotokoll & „Was ist neu“", en: "Changelog & “What’s new”" },
    changes: [
      {
        kind: "feature",
        de: "Neu: ein Änderungsprotokoll direkt in der App — sieh jederzeit unter „Einstellungen → Über Echo“, was in jeder Version dazugekommen ist.",
        en: "New: an in-app changelog — see what arrived in every version any time under Settings → About.",
      },
      {
        kind: "feature",
        de: "Nach einem Update begrüßt dich ein kurzer Hinweis mit der neuen Versionsnummer und den wichtigsten Neuerungen.",
        en: "After an update a short note greets you with the new version number and the key highlights.",
      },
    ],
  },
  {
    version: "0.5.75",
    date: "2026-07-06",
    title: { de: "Liquid-Glass-Slider in der Seitenleiste", en: "Liquid-glass slider in the sidebar" },
    changes: [
      {
        kind: "feature",
        de: "Die Auswahl in der Seitenleiste ist jetzt eine echte Glas-Pille, die du greifen, halten und ziehen kannst — sie rastet sanft auf dem nächsten Eintrag ein.",
        en: "The sidebar selection is now a real glass pill you can grab, hold and drag — it snaps gently onto the nearest item.",
      },
      {
        kind: "improvement",
        de: "Der Inhalt unter dem Glas wird leicht vergrößert (echte Refraktion) — dasselbe Liquid-Glass-Gefühl wie in SCAI.",
        en: "Content under the glass is magnified slightly (real refraction) — the same liquid-glass feel as in SCAI.",
      },
    ],
  },
  {
    version: "0.5.74",
    date: "2026-07-06",
    title: { de: "Vokabular als Tabs + Füllwörter raus", en: "Vocabulary tabs + filler-word removal" },
    changes: [
      {
        kind: "feature",
        de: "Die Vokabular-Seite ist jetzt in zwei Tabs geteilt: dein Wörterbuch und die Vorschläge.",
        en: "The vocabulary page is now split into two tabs: your dictionary and the suggestions.",
      },
      {
        kind: "feature",
        de: "Füllwörter wie „äh“ und „ähm“ lassen sich ohne jede Verzögerung aus dem Diktat entfernen.",
        en: "Filler words like “uh” and “um” can be stripped from dictation with zero added latency.",
      },
    ],
  },
  {
    version: "0.5.73",
    date: "2026-07-05",
    title: { de: "Vokabular auch ohne KI-Aufbereitung", en: "Vocabulary without AI cleanup" },
    changes: [
      {
        kind: "improvement",
        de: "Dein Vokabular wirkt jetzt auch, wenn die KI-Aufbereitung aus ist — mit einem eigenen An/Aus-Schalter.",
        en: "Your vocabulary now applies even with AI cleanup off — with its own on/off switch.",
      },
    ],
  },
  {
    version: "0.5.72",
    date: "2026-07-05",
    title: { de: "Saubereres Diktat", en: "Cleaner dictation" },
    changes: [
      {
        kind: "fix",
        de: "Überflüssige Komma-Häufungen, die die Spracherkennung manchmal einstreute, werden jetzt entfernt.",
        en: "The stray comma clutter the recognizer sometimes inserted is now removed.",
      },
    ],
  },
  {
    version: "0.5.50",
    date: "2026-06-28",
    title: { de: "Hilfe-Center + „Echo fragen“", en: "Help center + “Ask Echo”" },
    changes: [
      {
        kind: "feature",
        de: "Ein komplettes Hilfe-Center in der App: durchsuchbare Fragen & Antworten und ein Assistent, der dir direkt weiterhilft.",
        en: "A full in-app help center: a searchable FAQ and an assistant that answers on the spot.",
      },
    ],
  },
  {
    version: "0.5.26",
    date: "2026-06-15",
    title: { de: "Zuverlässigerer Orb", en: "More reliable orb" },
    changes: [
      {
        kind: "fix",
        de: "Der Orb reagiert jetzt verlässlich beim Rüberfahren, die Menüs verdecken das Symbol nicht mehr, und Klicks dahinter gehen wieder durch.",
        en: "The orb now reacts reliably on hover, its menus no longer cover the icon, and clicks behind it go through again.",
      },
    ],
  },
  {
    version: "0.5.23",
    date: "2026-06-14",
    title: { de: "Sofort-Ton beim Aufnehmen", en: "Instant recording sound" },
    changes: [
      {
        kind: "improvement",
        de: "Der Aufnahme-Ton kommt jetzt sofort beim Start statt mit spürbarer Verzögerung.",
        en: "The recording sound now plays instantly on start instead of with a noticeable delay.",
      },
    ],
  },
  {
    version: "0.5.9",
    date: "2026-06-13",
    title: { de: "Live-Diktat", en: "Live dictation" },
    changes: [
      {
        kind: "feature",
        de: "Dein Text kann jetzt schon während des Sprechens erscheinen — mit Fallback, das nie ein Wort verliert.",
        en: "Your text can now appear while you speak — with a fallback that never drops a word.",
      },
    ],
  },
  {
    version: "0.5.8",
    date: "2026-06-13",
    title: { de: "Orb-Konfigurator mit Live-Vorschau", en: "Orb configurator with live preview" },
    changes: [
      {
        kind: "feature",
        de: "Gestalte deinen Orb mit einer großen Live-Vorschau, die sofort auf jede Einstellung reagiert.",
        en: "Design your orb with a large live preview that reacts instantly to every setting.",
      },
    ],
  },
  {
    version: "0.5.5",
    date: "2026-06-13",
    title: { de: "Orb-Profile", en: "Orb profiles" },
    changes: [
      {
        kind: "feature",
        de: "Speichere komplette Orb-Looks als Profile — geräteübergreifend mit deinem Konto synchronisiert.",
        en: "Save complete orb looks as profiles — synced across your devices with your account.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-06-12",
    title: { de: "Verlauf, Auto-Modus & Kino-Intro", en: "History, auto mode & cinematic intro" },
    changes: [
      {
        kind: "feature",
        de: "Durchsuchbarer Verlauf für Diktate und Meetings, ein automatischer Modus, der sich der aktiven App anpasst, und eine neue Einführung.",
        en: "Searchable history for dictations and meetings, an automatic mode that adapts to the active app, and a new intro.",
      },
    ],
  },
];

/** Compare two dotted numeric versions. Returns -1 / 0 / 1 (a<b / a==b / a>b). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest documented version (top of the list). */
export function latestVersion(): string {
  return CHANGELOG[0]?.version ?? "0.0.0";
}

/**
 * Entries the user hasn't acknowledged yet: version in (seen, current].
 * `seen` null → nothing is "new" (caller decides fresh-install behaviour).
 */
export function entriesSince(seen: string | null, current: string): ChangelogEntry[] {
  if (!seen) return [];
  return CHANGELOG.filter(
    (e) => cmpVersion(seen, e.version) < 0 && cmpVersion(e.version, current) <= 0,
  );
}

export interface LocalizedChange {
  kind: ChangeKind;
  text: string;
}
export interface LocalizedEntry {
  version: string;
  date: string;
  title: string;
  changes: LocalizedChange[];
}

const pick = (lang: string) => (lang || "en").toLowerCase().startsWith("de");

export function localizeEntry(e: ChangelogEntry, lang: string): LocalizedEntry {
  const de = pick(lang);
  return {
    version: e.version,
    date: e.date,
    title: de ? e.title.de : e.title.en,
    changes: e.changes.map((c) => ({ kind: c.kind, text: de ? c.de : c.en })),
  };
}

export function localizedChangelog(lang: string): LocalizedEntry[] {
  return CHANGELOG.map((e) => localizeEntry(e, lang));
}
