// Echo's curated help knowledge base — the SINGLE source of truth for both the
// searchable FAQ UI (Help section) and the grounding context handed to the
// "Echo fragen" assistant (so it answers from our own facts, not invention).
//
// Content is bilingual (de/en) inline rather than spread across the 30 i18n
// locale files: only de/en are curated for prose, the assistant can answer in
// any language regardless, and keeping Q+A together makes editing one source.
// Add an entry = add facts the assistant can ground on. Keep answers factual
// and short; the troubleshooting category mirrors the real field issues.

export type FaqCategory =
  | "gettingStarted"
  | "dictation"
  | "meetings"
  | "vocabulary"
  | "troubleshooting"
  | "privacy";

export const FAQ_CATEGORIES: FaqCategory[] = [
  "gettingStarted",
  "dictation",
  "meetings",
  "vocabulary",
  "troubleshooting",
  "privacy",
];

export interface FaqEntry {
  id: string;
  category: FaqCategory;
  q: { de: string; en: string };
  a: { de: string; en: string };
}

export const FAQ: FaqEntry[] = [
  // ── Getting started ─────────────────────────────────────────────
  {
    id: "what-is-echo",
    category: "gettingStarted",
    q: {
      de: "Was ist Echo und wie funktioniert das Diktieren?",
      en: "What is Echo and how does dictation work?",
    },
    a: {
      de: "Echo ist eine Diktier- und Meeting-App. Zum Diktieren hältst du das Tastenkürzel, sprichst und lässt es los — der erkannte Text wird automatisch in das Programm eingefügt, in dem dein Cursor steht (Editor, Browser, Chat). Es läuft im Hintergrund über das Orb-Overlay.",
      en: "Echo is a dictation and meeting app. To dictate, hold the hotkey, speak, then release — the recognized text is pasted automatically into whatever app your cursor is in (editor, browser, chat). It runs in the background via the orb overlay.",
    },
  },
  {
    id: "default-hotkey",
    category: "gettingStarted",
    q: {
      de: "Welches Tastenkürzel nutze ich zum Diktieren und kann ich es ändern?",
      en: "What hotkey do I use to dictate, and can I change it?",
    },
    a: {
      de: "Das Diktier-Kürzel siehst und änderst du in den Einstellungen unter „Tastenkürzel“. Du hältst es gedrückt während du sprichst und lässt es zum Einfügen los. Es gibt zusätzlich Kürzel, um den Orb ein-/auszublenden und den Modus zu wechseln.",
      en: "You can see and change the dictation hotkey in Settings under “Hotkeys”. Hold it while speaking and release to paste. There are also shortcuts to show/hide the orb and switch mode.",
    },
  },
  {
    id: "the-orb",
    category: "gettingStarted",
    q: {
      de: "Was ist der Orb und wie blende ich ihn aus?",
      en: "What is the orb and how do I hide it?",
    },
    a: {
      de: "Der Orb ist das schwebende Overlay, das den Status anzeigt (Ruhe, Aufnahme, Verarbeitung). Du kannst ihn in den Einstellungen ausblenden („nur bei Aufnahme zeigen“ oder ganz versteckt). Wenn er versteckt ist, ist er auch nicht klickbar — er erscheint nur über das Tastenkürzel.",
      en: "The orb is the floating overlay that shows status (idle, recording, processing). You can hide it in Settings (“show only while recording” or fully hidden). When hidden it is also non-clickable — it only appears via the hotkey.",
    },
  },
  // ── Dictation ───────────────────────────────────────────────────
  {
    id: "cleanup",
    category: "dictation",
    q: {
      de: "Was macht das automatische Cleanup mit meinem Text?",
      en: "What does automatic cleanup do to my text?",
    },
    a: {
      de: "Cleanup poliert den Rohtext: Füllwörter raus, Zeichensetzung, saubere Sätze. Es gibt verschiedene Stile (z. B. natürlich, knapp, E-Mail). „Roh“ schaltet es aus. Im Auto-Modus wählt Echo den Stil passend zum aktiven Fenster.",
      en: "Cleanup polishes the raw text: removes filler words, fixes punctuation, tidies sentences. There are several styles (e.g. natural, concise, email). “Raw” turns it off. In Auto-Mode, Echo picks the style based on the active window.",
    },
  },
  {
    id: "auto-mode",
    category: "dictation",
    q: {
      de: "Wie funktioniert der Auto-Modus für die Fenster-Erkennung?",
      en: "How does Auto-Mode window detection work?",
    },
    a: {
      de: "Im Auto-Modus erkennt Echo das aktive Programm (z. B. Terminal, ChatGPT, E-Mail-Client) und wählt automatisch den passenden Cleanup-Stil — etwa „Prompt“ wenn du in einem Terminal oder Chat-Tool bist. Du kannst den Stil jederzeit fest vorgeben.",
      en: "In Auto-Mode, Echo detects the active app (e.g. terminal, ChatGPT, email client) and automatically picks the matching cleanup style — for instance “prompt” when you're in a terminal or chat tool. You can always pin a fixed style.",
    },
  },
  {
    id: "languages",
    category: "dictation",
    q: {
      de: "In welchen Sprachen kann ich diktieren?",
      en: "Which languages can I dictate in?",
    },
    a: {
      de: "Echo unterstützt rund 99 Sprachen. Du kannst eine feste Sprache wählen oder „Automatisch“, dann erkennt Echo die gesprochene Sprache selbst. Die Diktier-Sprache ist unabhängig von der App-Oberflächensprache.",
      en: "Echo supports about 99 languages. You can pick a fixed language or “Automatic”, in which case Echo detects the spoken language itself. The dictation language is independent of the app's UI language.",
    },
  },
  {
    id: "streaming-modes",
    category: "dictation",
    q: {
      de: "Was ist der Unterschied zwischen Live-Typing und Final-Modus?",
      en: "What's the difference between live typing and final mode?",
    },
    a: {
      de: "Im Final-Modus wird der fertige Text beim Loslassen eingefügt. Im Live-Modus tippt Echo schon während du sprichst wortweise mit. Aktiviere immer nur eine Tipp-Variante — Echo erzwingt das automatisch, damit sich nichts doppelt einfügt.",
      en: "In final mode the finished text is pasted on release. In live mode Echo types along word by word as you speak. Only one typing variant should be active — Echo enforces this automatically so nothing gets pasted twice.",
    },
  },
  // ── Meetings ────────────────────────────────────────────────────
  {
    id: "meetings-basics",
    category: "meetings",
    q: {
      de: "Wie nehme ich ein Meeting auf und transkribiere es?",
      en: "How do I record and transcribe a meeting?",
    },
    a: {
      de: "Über „Live-Meeting“ startest du die Aufnahme direkt. Echo nimmt dein Mikrofon und den System-Ton (die Gegenseite eines Teams-/Zoom-/Meet-Calls) auf und erstellt ein Transkript mit Sprecher-Trennung. Aufgenommene Meetings findest du unter „Meetings“.",
      en: "Use “Live meeting” to start recording directly. Echo captures your mic and the system audio (the other side of a Teams/Zoom/Meet call) and produces a transcript with speaker separation. Recorded meetings appear under “Meetings”.",
    },
  },
  {
    id: "speaker-separation",
    category: "meetings",
    q: {
      de: "Wie trennt Echo verschiedene Sprecher?",
      en: "How does Echo separate different speakers?",
    },
    a: {
      de: "Echo nutzt Stimmabdrücke (Voiceprints), um Sprecher auseinanderzuhalten — auch bei einem gemeinsamen Mikrofon (z. B. Konferenz-Pod). Über einen kurzen Check-In lassen sich Teilnehmer Namen zuordnen.",
      en: "Echo uses voiceprints to tell speakers apart — even on a single shared mic (e.g. a conference pod). A short check-in lets you map participants to names.",
    },
  },
  // ── Vocabulary ──────────────────────────────────────────────────
  {
    id: "auto-vocab",
    category: "vocabulary",
    q: {
      de: "Wie lernt Echo Fachbegriffe und Namen automatisch?",
      en: "How does Echo learn jargon and names automatically?",
    },
    a: {
      de: "Echo erkennt, wenn ein Begriff wiederholt falsch geschrieben ankommt (mehrere ähnliche Varianten), und schlägt die richtige Schreibweise vor — bzw. fügt sie bei hoher Sicherheit selbst hinzu. Du musst nichts manuell pflegen; normale Alltagswörter werden bewusst ignoriert.",
      en: "Echo notices when a term keeps coming through misspelled (several similar variants) and suggests the correct spelling — or adds it itself when confident. You don't have to maintain it manually; ordinary everyday words are deliberately ignored.",
    },
  },
  {
    id: "manual-vocab",
    category: "vocabulary",
    q: {
      de: "Kann ich Vokabeln auch selbst hinzufügen?",
      en: "Can I add vocabulary entries myself?",
    },
    a: {
      de: "Ja. Unter „Vocabulary“ legst du eigene Einträge an: „klingt wie“ → „schreib als“, optional mit Aliassen und Kategorie. Das ist nützlich für Eigennamen, Produkte oder Fachbegriffe, die Echo nicht von selbst kennt.",
      en: "Yes. Under “Vocabulary” you add your own entries: “sounds like” → “write as”, optionally with aliases and a category. Useful for proper names, products, or jargon Echo can't know on its own.",
    },
  },
  // ── Troubleshooting ─────────────────────────────────────────────
  {
    id: "no-paste-macos",
    category: "troubleshooting",
    q: {
      de: "Der Text wird erkannt, aber nicht eingefügt (macOS).",
      en: "Text is recognized but not pasted (macOS).",
    },
    a: {
      de: "Das liegt fast immer an der fehlenden Bedienungshilfen-Berechtigung. Öffne Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen und aktiviere Echo. Der Text liegt in der Zwischenablage — du kannst ihn solange mit Cmd+V einfügen.",
      en: "This is almost always the missing Accessibility permission. Open System Settings → Privacy & Security → Accessibility and enable Echo. The text is on your clipboard meanwhile — you can paste it with Cmd+V.",
    },
  },
  {
    id: "no-paste-windows",
    category: "troubleshooting",
    q: {
      de: "Auf Windows friert die App ein oder fügt nicht richtig ein.",
      en: "On Windows the app freezes or doesn't paste correctly.",
    },
    a: {
      de: "Stelle sicher, dass du die neueste Version hast (Echo aktualisiert sich automatisch; Stand siehst du unten in der Diagnose). Schließe und öffne Echo einmal neu. Bleibt es bestehen, hilf uns mit der Diagnose: Button „Diagnose kopieren“ unten und schick sie dem Support — das beschleunigt die Lösung enorm.",
      en: "Make sure you're on the latest version (Echo auto-updates; you can see the version in Diagnostics below). Close and reopen Echo once. If it persists, help us with diagnostics: use “Copy diagnostics” below and send it to support — it speeds up the fix a lot.",
    },
  },
  {
    id: "no-record",
    category: "troubleshooting",
    q: {
      de: "Echo nimmt nichts auf / das Mikrofon reagiert nicht.",
      en: "Echo records nothing / the mic doesn't respond.",
    },
    a: {
      de: "Prüfe die Mikrofon-Berechtigung des Systems und wähle in den Einstellungen das richtige Eingabegerät. Der Mikrofon-Pegel in den Einstellungen zeigt dir, ob Echo Ton bekommt. Auf macOS muss Echo unter Datenschutz → Mikrofon freigegeben sein.",
      en: "Check the system microphone permission and select the correct input device in Settings. The mic level meter in Settings shows whether Echo is getting audio. On macOS, Echo must be allowed under Privacy → Microphone.",
    },
  },
  {
    id: "garbled-text",
    category: "troubleshooting",
    q: {
      de: "Das Transkript ist durcheinander / Buchstaben sind verschachtelt.",
      en: "The transcript is jumbled / letters are interleaved.",
    },
    a: {
      de: "Das passiert, wenn zwei Tipp-Modi gleichzeitig aktiv waren. Aktuelle Versionen verhindern das automatisch. Stelle sicher, dass du die neueste Version hast und nur einen Tipp-Modus (Live oder Final) aktiv ist.",
      en: "This happened when two typing modes were active at once. Current versions prevent it automatically. Make sure you're on the latest version and only one typing mode (live or final) is active.",
    },
  },
  {
    id: "update",
    category: "troubleshooting",
    q: {
      de: "Wie aktualisiere ich Echo?",
      en: "How do I update Echo?",
    },
    a: {
      de: "Echo prüft beim Start automatisch auf Updates und installiert sie. Deine aktuelle Version steht unten im Diagnose-Block. Wenn ein Update bereitsteht, wirst du benachrichtigt.",
      en: "Echo checks for updates automatically at startup and installs them. Your current version is shown in the Diagnostics block below. You'll be notified when an update is available.",
    },
  },
  // ── Privacy ─────────────────────────────────────────────────────
  {
    id: "where-data",
    category: "privacy",
    q: {
      de: "Wo werden meine Aufnahmen und Transkripte gespeichert?",
      en: "Where are my recordings and transcripts stored?",
    },
    a: {
      de: "Verlauf und Meetings liegen lokal in einer Datenbank auf deinem Gerät. Für die Cloud-Transkription wird Audio zur Verarbeitung an unseren Server gesendet; mit dem lokalen Modus läuft die Erkennung komplett offline auf deinem Gerät.",
      en: "History and meetings are stored locally in a database on your device. For cloud transcription, audio is sent to our server for processing; with local mode, recognition runs fully offline on your device.",
    },
  },
  {
    id: "offline",
    category: "privacy",
    q: {
      de: "Kann ich Echo komplett offline nutzen?",
      en: "Can I use Echo fully offline?",
    },
    a: {
      de: "Ja, im lokalen Modus läuft die Transkription auf deinem Gerät (lädt ein Modell herunter). Cloud-Funktionen wie das KI-Cleanup und dieser Hilfe-Assistent brauchen eine Verbindung.",
      en: "Yes, in local mode transcription runs on your device (downloads a model). Cloud features like AI cleanup and this help assistant need a connection.",
    },
  },
];

type Lang = "de" | "en";
const lang = (l: string): Lang => (l.startsWith("de") ? "de" : "en");

/** Localized FAQ entries for the current UI language (de/en, en fallback). */
export function localizedFaq(uiLang: string): { id: string; category: FaqCategory; q: string; a: string }[] {
  const l = lang(uiLang);
  return FAQ.map((e) => ({ id: e.id, category: e.category, q: e.q[l], a: e.a[l] }));
}

/** Flatten the whole FAQ into the grounding context handed to the assistant. */
export function faqKnowledge(uiLang: string): string {
  const l = lang(uiLang);
  return FAQ.map((e) => `Q: ${e.q[l]}\nA: ${e.a[l]}`).join("\n\n");
}
