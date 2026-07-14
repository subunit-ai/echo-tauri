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
    version: "0.5.133",
    date: "2026-07-14",
    title: {
      de: "Wortschatz: alles lesbar, Füllwörter endlich gezählt",
      en: "Vocabulary: everything readable, fillers finally counted",
    },
    changes: [
      {
        kind: "feature",
        de: "Neu: Echo zählt jetzt mit, welche Füllwörter es für dich herausfiltert. Die Verzögerungslaute (ähm, äh, hmm) wurden immer schon still entfernt — jetzt siehst du im Wortschatz endlich, wie viele es waren, als Rangliste mit Zähler.",
        en: "New: Echo now counts the fillers it strips out for you. The hesitation sounds (um, uh, hmm) were always removed silently — now the Vocabulary tab finally shows how many there were, as a ranked list with tallies.",
      },
      {
        kind: "improvement",
        de: "Erfolge, Bestenliste und Füllwörter haben jetzt jeweils eine eigene, große Box — Wörter und Namen werden nicht mehr abgeschnitten.",
        en: "Achievements, leaderboard and filler words each get their own big box — words and names are no longer cut off.",
      },
      {
        kind: "improvement",
        de: "Alle Zählungen folgen jetzt einem einheitlichen Ranglisten-Raster statt Wortwolke, Balkendiagramm und drei Chip-Stilen durcheinander. Häufigste Wörter sind eine schlichte Top-10 mit Zähler.",
        en: "Every tally now follows one consistent ranked-list grid instead of a word cloud, a bar chart and three chip styles all at once. Most-used words are a plain top ten with counts.",
      },
      {
        kind: "improvement",
        de: "Verbesserungsvorschläge sind deutlich kompakter: eine Zeile pro Wort. Die Erklärung erscheint jetzt auf Zuruf — Wort antippen oder darauf zeigen — statt dauerhaft Platz zu belegen.",
        en: "Upgrade suggestions are far more compact: one line per word. The explanation now appears on demand — tap or hover a word — instead of permanently taking up space.",
      },
      {
        kind: "fix",
        de: "Verbesserungsvorschläge laden sofort statt manchmal gar nicht oder erst nach langer Wartezeit: Die Vorschläge erscheinen jetzt umgehend und werden im Hintergrund verfeinert, statt hinter einer Netzabfrage zu warten, die bei jedem einzelnen Diktat neu lief.",
        en: "Upgrade suggestions load instantly instead of sometimes never or only after a long wait: they now appear immediately and are refined in the background, rather than blocking on a network round trip that re-ran after every single dictation.",
      },
    ],
  },
  {
    version: "0.5.132",
    date: "2026-07-14",
    title: {
      de: "Die Pille zeigt deine Wörter — und leuchtet wie Siri",
      en: "The pill shows your words — and glows like Siri",
    },
    changes: [
      {
        kind: "feature",
        de: "Neuer Visualizer „Wörter“: Was du sprichst, fließt live als Text durch die Pille — wie ein Fließband.",
        en: "New “Words” visualizer: what you speak flows live through the pill as text — like a conveyor.",
      },
      {
        kind: "feature",
        de: "Drei neue Stile: Funken (Silben sprühen glühende Funken), Puls (Sonar-Ringe aus der Mitte) und Helix (Doppelwelle, die sich mit deiner Stimme öffnet).",
        en: "Three new styles: Sparks (syllables throw glowing embers), Pulse (sonar rings from the centre) and Helix (a double wave that opens with your voice).",
      },
      {
        kind: "improvement",
        de: "Siri-Beleuchtung neu: Der Rand der Pille leuchtet jetzt in wandernden Farben auf und strahlt nach innen — mit runden, morphenden Lichtern, die auf deine Stimme reagieren.",
        en: "Siri illumination redone: the pill’s rim now lights up in traveling colors and radiates inward — with round, morphing lights reacting to your voice.",
      },
    ],
  },
  {
    version: "0.5.131",
    date: "2026-07-14",
    title: {
      de: "Dein Stimmabdruck ist jetzt wirklich deiner",
      en: "Your voiceprint is now really yours",
    },
    changes: [
      {
        kind: "feature",
        de: "Der Stimmabdruck wird aus deiner echten Stimme gezeichnet statt aus deinem Konto: Der Abstand vom Zentrum ist die Tonhöhe, die Helligkeit eines Rings ist die Energie, die deine Stimme dort trägt — deine Klangfarbe, gemessen aus deinen eigenen Aufnahmen.",
        en: "Your voiceprint is now drawn from your actual voice instead of your account: distance from the centre is pitch, the brightness of a ring is the energy your voice carries there — your timbre, measured from your own recordings.",
      },
      {
        kind: "improvement",
        de: "Er wird schärfer, je mehr du diktierst: jede Aufnahme verfeinert die Klangfarbe. Solange noch keine vorliegt, zeichnet Echo den Abdruck aus deinem Stimmprofil — die Figur sagt dir jetzt selbst, woraus sie entstanden ist.",
        en: "It sharpens the more you dictate: every recording refines the timbre. Until there is one, Echo draws the print from your voice profile — and the figure now tells you what it was drawn from.",
      },
      {
        kind: "improvement",
        de: "Deine Stimmdaten bleiben dabei auf dem Server: gezeichnet wird nur aus zwei abgeleiteten, nicht rückrechenbaren Größen — dein Stimmvektor selbst wird nie ausgeliefert.",
        en: "Your voice data stays on the server: the drawing uses only two derived values that cannot be reversed — your voice vector itself is never handed out.",
      },
    ],
  },
  {
    version: "0.5.130",
    date: "2026-07-14",
    title: {
      de: "Dein Stimmabdruck — dichter, feiner, farbiger",
      en: "Your voiceprint — denser, finer, more colourful",
    },
    changes: [
      {
        kind: "improvement",
        de: "Der Stimmabdruck ist jetzt ein echter Abdruck statt eines löchrigen Rads: rund dreimal so viele Teile, lückenlos über die ganze Fläche — auch wenn er erst zu 70 % gefüllt ist.",
        en: "Your voiceprint now looks like a real print instead of a gappy wheel: about three times as many pieces, covering the whole face — even when it is only 70 % complete.",
      },
      {
        kind: "improvement",
        de: "Strichstärke, Helligkeit und Farbton folgen der Energie deiner Stimme: kräftige Obertöne werden dicke, leuchtende Bögen, leise Passagen feine Textur — jede Quelle (Kern, Meetings, Diktat) bekommt dabei ihre eigene Farbfamilie.",
        en: "Line weight, brightness and hue follow the energy of your voice: strong harmonics become thick, glowing arcs, quiet passages fine texture — and each source (core, meetings, dictation) gets its own colour family.",
      },
      {
        kind: "improvement",
        de: "Neue Teile setzen sich gleichmäßig über den ganzen Abdruck — er entwickelt sich wie ein Foto, statt einzelne Tortenstücke aufleuchten zu lassen.",
        en: "New pieces now land evenly across the whole print — it develops like a photograph instead of lighting up single pie slices.",
      },
    ],
  },
  {
    version: "0.5.129",
    date: "2026-07-13",
    title: {
      de: "Deine Pille, dein Look — eigener Einstellungs-Bereich",
      en: "Your pill, your look — its own settings section",
    },
    changes: [
      {
        kind: "feature",
        de: "Neuer Reiter „Pille“ in den Einstellungen: alles, was in der Pille passiert, an einem Ort — mit Live-Vorschau.",
        en: "New “Pill” tab in Settings: everything that happens inside the pill, in one place — with a live preview.",
      },
      {
        kind: "feature",
        de: "Vier neue Visualizer: Laufband (deine Sprache läuft durch), Zentrum (Ausschläge treiben aus der Mitte nach außen), Welle (leuchtender Wellenzug) und Matrix (Retro-Leuchtpunkte).",
        en: "Four new visualizers: Ticker (your speech streams through), Center (peaks drift outward from the middle), Wave (a glowing waveform) and Matrix (retro light dots).",
      },
      {
        kind: "feature",
        de: "Beleuchtung: Das Glas selbst leuchtet und reagiert auf deine Stimme — in der Statusfarbe oder als mehrfarbige Siri-Aurora.",
        en: "Illumination: the glass itself lights up and reacts to your voice — in the status color or as a multicolor Siri aurora.",
      },
      {
        kind: "improvement",
        de: "Alles optional: Ohne Änderung bleibt die Pille exakt wie gewohnt.",
        en: "Everything is optional: untouched, the pill stays exactly as you know it.",
      },
    ],
  },
  {
    version: "0.5.128",
    date: "2026-07-12",
    title: {
      de: "Dein Stimmabdruck als Spektral-Rosette",
      en: "Your voiceprint as a spectral rosette",
    },
    changes: [
      {
        kind: "feature",
        de: "Der Stimmabdruck zeigt jetzt deine Stimme statt eines Fingerabdrucks: eine Spektral-Rosette — dein Klangspektrum, im Kreis aufgewickelt. Winkel = Zeit, Radius = Tonhöhe, Bögen = Obertonenergie. Jedes Konto bekommt sein eigenes, unverwechselbares Muster, und wie bisher füllt sich das Bild Stück für Stück aus deinen drei Quellen (Einrichtung, Meetings, Diktate).",
        en: "Your voiceprint now shows your voice instead of a fingerprint: a spectral rosette — your sound spectrum wound into a circle. Angle = time, radius = pitch, arcs = harmonic energy. Every account gets its own distinctive pattern, and as before the picture fills in piece by piece from your three sources (setup, meetings, dictation).",
      },
      {
        kind: "feature",
        de: "Neues Lade-Erlebnis: Während der Aufnahme und der Auswertung siehst du eine schwingende Chladni-Platte — Sand, der sich zu Klangmustern ordnet und mit deiner Stimme mitwandert. Beim Auswerten morpht das Muster ruhig durch die Frequenzen, bis dein Abdruck fertig ist.",
        en: "New loading experience: during recording and analysis you see a vibrating Chladni plate — sand settling into sound patterns that shift with your voice. While analyzing, the pattern calmly morphs through the frequencies until your print is ready.",
      },
    ],
  },
  {
    version: "0.5.127",
    date: "2026-07-11",
    title: { de: "Vorschläge: nur noch echte Begriffe", en: "Suggestions: real terms only" },
    changes: [
      {
        kind: "fix",
        de: "Die Vorschlags-Liste zeigt jetzt ausschließlich geprüfte Begriffe (Namen, Marken, Fachwörter). Rohe Funde aus deinen Diktaten erscheinen nicht mehr — sie werden im Hintergrund geprüft und tauchen erst auf, wenn sie als echter Begriff bestätigt sind. Die bisher angesammelten Roh-Vorschläge und die alten »automatisch gelernt«-Einträge werden einmalig vollständig entfernt.",
        en: "The suggestion list now shows only vetted terms (names, brands, technical words). Raw finds from your dictations no longer appear — they are checked in the background and only surface once confirmed as a real term. Previously accumulated raw suggestions and the old \"auto-learned\" entries are removed once and for all.",
      },
    ],
  },
  {
    version: "0.5.126",
    date: "2026-07-11",
    title: { de: "Saubere Vorschläge, saubere Diktate", en: "Clean suggestions, clean dictations" },
    changes: [
      {
        kind: "fix",
        de: "Die Vokabular-Vorschläge schlagen keine gewöhnlichen Alltagswörter mehr vor: Kandidaten ohne eindeutige Einordnung (Name, Marke, Fachbegriff …) werden jetzt konsequent verworfen, und bereits angesammelte Trivial-Vorschläge werden einmalig aufgeräumt. Deine bestätigten Vokabeln bleiben unangetastet.",
        en: "Vocabulary suggestions no longer propose ordinary everyday words: candidates without a clear classification (name, brand, technical term …) are now rejected outright, and previously accumulated trivial suggestions are cleaned up once. Your confirmed vocabulary stays untouched.",
      },
      {
        kind: "fix",
        de: "Füllwörter (»ähm«, »äh« …) werden jetzt auch dann zuverlässig entfernt, wenn die Textveredelung aktiv ist — die deterministische Filterung läuft nun auf jedem Diktat-Weg über das Endergebnis.",
        en: "Filler words (\"uhm\", \"uh\" …) are now reliably removed even when text cleanup is active — the deterministic filter now runs on the final result on every dictation path.",
      },
    ],
  },
  {
    version: "0.5.125",
    date: "2026-07-10",
    title: { de: "Der Stimmabdruck ist jetzt ein echter Abdruck", en: "Your voiceprint now looks like a real print" },
    changes: [
      {
        kind: "improvement",
        de: "Statt eines gleichmäßigen Rings zeigt Einstellungen → Stimme jetzt einen echten Fingerabdruck, der sich wie ein Puzzle zusammensetzt: jedes Ridge-Fragment ist ein Stück, und seine Farbe verrät, woher es kam — Kern-Einrichtung, Meeting-Anker oder Diktat-Anker. So siehst du auf einen Blick nicht nur WIE VOLL dein Profil ist, sondern WORAUS es besteht.",
        en: "Instead of an even ring, Settings → Voice now shows a real fingerprint that assembles like a puzzle: every ridge fragment is a piece, and its colour tells you where it came from — core setup, meeting anchors or dictation anchors. You see at a glance not just HOW COMPLETE your profile is, but what it is MADE OF.",
      },
    ],
  },
  {
    version: "0.5.124",
    date: "2026-07-10",
    title: {
      de: "Präziseres Korrektur-Modell — jetzt Standard",
      en: "More accurate correction model — now the default",
    },
    changes: [
      {
        kind: "feature",
        de: "Der Diktat-Feinschliff heißt jetzt „Standard“, steht in der Auswahl ganz oben und ist ab Werk aktiv: standardmäßige deutsche Rechtschreibung und Zeichensetzung, korrigiert von unserem neuen, deutlich präziseren Modell — datenschutzfreundlich auf Servern in Deutschland.",
        en: "The dictation polish is now called “Standard”, sits at the top of the picker and is on by default: standard spelling and punctuation, corrected by our new, noticeably more accurate model — privacy-friendly on servers in Germany.",
      },
      {
        kind: "improvement",
        de: "Zahlen und Einheiten werden sauber gesetzt (5kg → 5 kg, 10€ → 10 €, 50km/h → 50 km/h) und weitere Komma-Regeln greifen automatisch (ohne/statt/außer … zu).",
        en: "Numbers and units are spaced correctly (5kg → 5 kg, 10€ → 10 €, 50km/h → 50 km/h) and additional comma rules apply automatically (German infinitive groups).",
      },
      {
        kind: "fix",
        de: "Links und Satzzeichen-Folgen (z. B. „!!!“) werden bei der Formatierung nicht mehr auseinandergerissen.",
        en: "Links and punctuation runs (e.g. “!!!”) are no longer broken apart during formatting.",
      },
    ],
  },
  {
    version: "0.5.123",
    date: "2026-07-10",
    title: { de: "Neuer, stabilerer Update-Kanal", en: "New, more reliable update channel" },
    changes: [
      {
        kind: "improvement",
        de: "Echo bezieht Updates ab jetzt über einen dedizierten Verteilkanal. Für dich ändert sich nichts — Updates kommen wie gewohnt automatisch, künftig nur noch zuverlässiger. Dieses Update einmal installieren, damit der Wechsel greift.",
        en: "Echo now receives updates through a dedicated distribution channel. Nothing changes for you — updates keep arriving automatically, just more reliably. Install this update once so the switch takes effect.",
      },
    ],
  },
  {
    version: "0.5.122",
    date: "2026-07-10",
    title: { de: "Dein Stimmabdruck — sichtbar, verwaltbar, lernend", en: "Your voiceprint — visible, manageable, learning" },
    changes: [
      {
        kind: "feature",
        de: "Neuer Bereich Einstellungen → Stimme: dein Stimmprofil als füllende Visualisierung mit Vervollständigungs-Grad, geführter Einrichtung (~60s Lesetext mit Live-Pegel) und Verwaltung — in Meetings entfällt danach das Zahl-Vorlesen.",
        en: "New Settings → Voice area: your voice profile as a filling visualisation with completion level, guided setup (~60s read-aloud with live meter) and management — meetings no longer need the number check-in.",
      },
      {
        kind: "feature",
        de: "Stimme laufend verbessern (Opt-in): eigene Diktate und Meetings präzisieren dein Profil automatisch; gelernte Anker sind sichtbar, zurücksetzbar und löschbar.",
        en: "Keep improving my voice (opt-in): your own dictations and meetings refine your profile automatically; learned anchors are visible, resettable and deletable.",
      },
      {
        kind: "fix",
        de: "Lokaler Meeting-Modus: aktualisierte Diarisierungs-Parameter (validierter Splitter-Fix).",
        en: "Local meeting mode: updated diarisation parameters (validated splitter fix).",
      },
    ],
  },
  {
    version: "0.5.121",
    date: "2026-07-10",
    title: { de: "Titelleiste sitzt sauber (ohne Milchglas)", en: "Title bar sits clean (frost off)" },
    changes: [
      {
        kind: "fix",
        de: "Mit ausgeschaltetem iOS-Milchglas hatte die Titelleiste kleine Aussparungen an den oberen Ecken, schmiegte sich nicht sauber an, und die Ampel saß etwas zu hoch. Das Fenster bekommt jetzt eine durchgehende, deckende Unterlage mit runden Ecken — die Leiste sitzt bündig, die Ampel liegt auf einer Linie mit den Tabs. Dunkel wie hell.",
        en: "With the iOS frost turned off the title bar had small notches at the top corners, didn't sit flush, and the traffic lights were a touch too high. The window now has a single opaque rounded backing — the strip sits flush and the traffic lights line up with the tabs. Dark and light alike.",
      },
    ],
  },
  {
    version: "0.5.120",
    date: "2026-07-10",
    title: { de: "Tabs nicht mehr durchsichtig (ohne Milchglas)", en: "Tabs no longer transparent (frost off)" },
    changes: [
      {
        kind: "fix",
        de: "Mit ausgeschaltetem iOS-Milchglas waren die Tabs oben durchsichtig — man sah den Schreibtisch durch die Titelleiste (dunkel wie hell). Ohne Milchglas wird das Fenster jetzt komplett deckend, sodass die Tab-Leiste sauber gefüllt ist.",
        en: "With the iOS frost turned off, the top tabs were see-through — the desktop showed through the title bar (dark and light alike). With frost off the window is now fully opaque, so the tab strip is cleanly filled.",
      },
    ],
  },
  {
    version: "0.5.119",
    date: "2026-07-09",
    title: { de: "Lange Diktate brechen nicht mehr ab", en: "Long dictations no longer cut out" },
    changes: [
      {
        kind: "fix",
        de: "Beim Einfügen eines Transkripts meldet Echo dem System kurz, dass alle Sondertasten losgelassen sind. Hältst du die Aufnahmetaste, während noch eingefügt wird, hat Echo das für dein Loslassen gehalten und die laufende Aufnahme mitten im Satz beendet. Jetzt zählt der echte Zustand der Taste — die Aufnahme läuft, solange du sie gedrückt hältst.",
        en: "While pasting a transcript, Echo briefly tells the system that all modifier keys are up. If you held the record key while a paste was still running, Echo mistook that for you letting go and ended the take mid-sentence. It now checks the key's real hardware state — recording continues for as long as you hold it.",
      },
    ],
  },
  {
    version: "0.5.118",
    date: "2026-07-09",
    title: { de: "Terminal-Glas wieder neutral", en: "Terminal glass back to neutral" },
    changes: [
      {
        kind: "fix",
        de: "Beim Öffnen und Schließen hatte das Terminal-Glas zuletzt einen Farbstich (bei einer cyanfarbenen Pille wirkte es grünlich). Das Glas ist jetzt wieder komplett neutral — schlichtes dunkles bzw. helles Milchglas, ohne Einfärbung.",
        en: "On open and close the terminal glass had picked up a color cast (with a cyan pill it looked greenish). The glass is now fully neutral again — plain dark or light frost, no tint.",
      },
    ],
  },
  {
    version: "0.5.117",
    date: "2026-07-09",
    title: { de: "Helles Prompt-Terminal", en: "Light prompt terminal" },
    changes: [
      {
        kind: "feature",
        de: "Das Prompt-Terminal gibt es jetzt auch in Hell: ein sauberes, helles Milchglas mit dunklem, gut lesbarem Text — im gleichen Farbton wie deine Pille. Umschaltbar in den Einstellungen unter „Erscheinungsbild“ (Dunkel/Hell). Am schönsten in Kombination mit ausgeschaltetem iOS-Milchglas.",
        en: "The prompt terminal now comes in light too: a clean, light frosted glass with dark, highly legible text — in the same color tone as your pill. Switch it in settings under \u201cAppearance\u201d (Dark/Light). Looks best paired with the iOS frost glass turned off.",
      },
    ],
  },
  {
    version: "0.5.116",
    date: "2026-07-09",
    title: {
      de: "Vokabular: zuletzt hinzugefügte Begriffe oben",
      en: "Vocabulary: most recently added terms on top",
    },
    changes: [
      {
        kind: "improvement",
        de: "Das Wörterbuch zeigt neue Begriffe jetzt oben statt ganz unten — du siehst sofort, was du zuletzt hinzugefügt hast, ohne zu scrollen. Auch ein neuer Eintrag erscheint direkt an erster Stelle. An der Erkennung ändert sich nichts.",
        en: "The dictionary now lists new terms at the top instead of the very bottom — you immediately see what you added last, without scrolling. A newly added entry also appears in first place. Recognition behaviour is unchanged.",
      },
    ],
  },
  {
    version: "0.5.115",
    date: "2026-07-09",
    title: { de: "Terminal im Pillen-Ton, Milchglas-Schalter + zügigerer Genie", en: "Terminal in the pill's tone, frost toggle + a quicker genie" },
    changes: [
      {
        kind: "feature",
        de: "Das Prompt-Terminal kommt jetzt im gleichen Farbton aus der Pille wie die Pille selbst: Sein Glas übernimmt die Akzentfarbe der Pille, mit einem sanften Leuchten an der Austrittsstelle — der Übergang aus der Pille wirkt wie ein Guss.",
        en: "The prompt terminal now emerges from the pill in the pill's own color: its glass takes on the pill's accent, with a soft glow at the point it pours out — the emergence reads as one piece.",
      },
      {
        kind: "feature",
        de: "Neuer Schalter „iOS-Milchglas“: Aus lassen, und das Terminal bleibt durchgehend im flachen, an die Pille angepassten Glas — ohne den weichen Wechsel auf das echte Milchglas. Die Genie-Animation bleibt in beiden Fällen erhalten.",
        en: "New “iOS frost glass” toggle: leave it off and the terminal stays in the flat, pill-matched glass throughout — without the soft switch to the real frost. The genie animation stays in both cases.",
      },
      {
        kind: "improvement",
        de: "Der Genie-Flug rein und raus ist einen Tick zügiger — gleiche geschmeidige Kurve, nur etwas flotter.",
        en: "The genie flight in and out is a touch quicker — same silky curve, just a bit snappier.",
      },
    ],
  },
  {
    version: "0.5.114",
    date: "2026-07-09",
    title: { de: "Sauberes Wörterbuch: verfälschende Auto-Wörter raus, Vorschläge nur noch für echte Namen", en: "A clean dictionary: corrupting auto-words gone, suggestions for real names only" },
    changes: [
      {
        kind: "fix",
        de: "Automatisch „gelernte“ Wörter, die sauberen Text verfälschen konnten (etwa „Frage“ → „Fragen“), werden aus dem Wörterbuch entfernt. Dein Wörterbuch enthält jetzt nur noch echte Eigennamen.",
        en: "Automatically “learned” words that could corrupt clean text (e.g. “Frage” → “Fragen”) are removed from the dictionary. Your dictionary now holds genuine proper nouns only.",
      },
      {
        kind: "improvement",
        de: "Wort-Vorschläge erscheinen nur noch für echte Eigennamen (Firmen, Namen) — nichts wird mehr still im Hintergrund hinzugefügt. Über „Auto-Vokabular leeren“ räumst du Altlasten jederzeit selbst weg.",
        en: "Word suggestions now appear only for genuine proper nouns (companies, names) — nothing is silently added in the background anymore. “Clear auto-learned words” lets you sweep out old entries anytime.",
      },
      {
        kind: "improvement",
        de: "Der Standard-Cleanup läuft jetzt lokal und DSGVO-konform („Aufräumen“).",
        en: "The default cleanup now runs locally and GDPR-compliant (“Tidy”).",
      },
    ],
  },
  {
    version: "0.5.113",
    date: "2026-07-09",
    title: { de: "Pille V1 & V2, Reaktions-Menü + geschmeidiger Genie-Übergang", en: "Pill V1 & V2, reaction menu + a silkier genie handover" },
    changes: [
      {
        kind: "feature",
        de: "Die Pillen-Form ist jetzt frei wählbar: „Pille V2“ ist die aktuelle lange Pille (Standard), „Pille V1“ bringt die allererste, kompakte Website-Pille mit fünf Balken zurück ins Menü.",
        en: "The pill shape is now selectable: “Pill V2” is the current long pill (default), and “Pill V1” brings the very first, compact website pill with five bars back into the menu.",
      },
      {
        kind: "feature",
        de: "Neues eigenes Menü „Reaktion (Pille)“: „Dynamik“ (Standard) — jeder Balken mit eigenem Charakter und Tempo — oder „Klassisch“ mit kräftiger Mitte und tiefer Dynamik. Getrennt von der Form, jederzeit umschaltbar.",
        en: "A new dedicated “Reaction (pill)” menu: “Dynamics” (default) — every bar with its own character and tempo — or “Classic” with a strong centre and deep dynamics. Separate from the shape, switchable anytime.",
      },
      {
        kind: "improvement",
        de: "Der Übergang beim Öffnen des Prompt-Terminals ist jetzt ein Guss: Statt von transparent über flach nach milchig zu springen, trägt das Fenster durchgehend dasselbe Glas und das echte iOS-Milchglas blendet weich darunter ein — kein Haken mehr.",
        en: "Opening the prompt terminal is now one smooth pour: instead of jumping from transparent to flat to frosted, the window carries the same glass throughout and the real iOS frost fades in softly underneath — no more hitch.",
      },
    ],
  },
  {
    version: "0.5.112",
    date: "2026-07-09",
    title: { de: "Die Pille im Doppelpack: V1 zurück, V2 zum Ausprobieren", en: "The pill twin pack: V1 back, V2 to try" },
    changes: [
      {
        kind: "improvement",
        de: "Pille V1 ist zurück — der gewohnte Charakter mit kräftiger Mitte und tiefer Dynamik, den die letzte Version überschrieben hatte. Einzige Änderung: die äußeren Balken atmen jetzt sanft mit der Stimme mit, statt still zu bleiben. V1 bleibt der Standard.",
        en: "Pill V1 is back — the familiar character with a strong centre and deep dynamics that the last version had overwritten. Only change: the outer bars now breathe gently with your voice instead of sitting still. V1 stays the default.",
      },
      {
        kind: "feature",
        de: "Neuer wählbarer Stil „Pille V2 (Dynamik)\u201c: jeder Balken mit eigenem Charakter — eigene Frequenz-Färbung, eigenes Anschwell- und Abkling-Tempo, Mitte mit Spielraum statt Dauervollausschlag. Umschaltbar in den Overlay-Einstellungen — direkt vergleichen und den Favoriten behalten.",
        en: "New selectable style \u201ePill V2 (Dynamics)\u201c: every bar with its own character — its own frequency colouring, its own attack and release tempo, a centre with headroom instead of constant full deflection. Switch in the overlay settings — compare directly and keep your favourite.",
      },
    ],
  },
  {
    version: "0.5.111",
    date: "2026-07-09",
    title: {
      de: "Wortschatz öffnet wieder flüssig",
      en: "Vocabulary opens smoothly again",
    },
    changes: [
      {
        kind: "fix",
        de: "Der Wortschatz-Bereich konnte beim Öffnen kurz einfrieren oder sehr lange laden, während im Hintergrund die Verbesserungsvorschläge und die Bestenliste geholt wurden. Der Tab öffnet jetzt sofort und bleibt bedienbar — die Daten erscheinen, sobald sie da sind, ohne die App zu blockieren.",
        en: "Opening the Vocabulary section could briefly freeze or take very long to load while suggestions and the leaderboard were fetched in the background. The tab now opens instantly and stays responsive — the data fills in as it arrives, without blocking the app.",
      },
    ],
  },
  {
    version: "0.5.110",
    date: "2026-07-09",
    title: { de: "Ausgewogene Pille + Windows-Fixes", en: "Balanced pill + Windows fixes" },
    changes: [
      {
        kind: "improvement",
        de: "Die Sprach-Balken der Pille sind jetzt ausbalanciert: Vorher trugen die mittleren drei bis vier fast alles und die äußeren blieben oft still — jetzt atmet die ganze Pille mit der Stimme. Die Randbalken hören auf lebendige Sprachfrequenzen statt auf die oberste Zisch-Oktave, jeder Balken bekommt einen Anteil der Gesamtenergie, und eine Nachbar-Glättung macht die Welle geschmeidiger.",
        en: "The pill's voice bars are balanced now: before, the middle three or four carried almost everything while the outer ones often sat still — now the whole pill breathes with your voice. The rim bars listen to living speech frequencies instead of the top sibilance octave, every bar gets a share of the overall energy, and neighbour smoothing makes the wave silkier.",
      },
      {
        kind: "fix",
        de: "Auf Windows schwebte dauerhaft ein rechteckiger Schatten-Rahmen um das (transparente) Prompt-Terminal-Fenster — Windows zeichnet Fensterschatten stur ums ganze Rechteck statt um den sichtbaren Inhalt. Der System-Schatten ist dort jetzt aus; das Terminal bringt seine eigene Tiefe mit.",
        en: "On Windows a rectangular shadow frame floated permanently around the (transparent) prompt terminal window — Windows draws window shadows around the full rect instead of the visible content. The system shadow is now off there; the terminal carries its own depth.",
      },
      {
        kind: "fix",
        de: "Die Fenster-Outline um den aktiven Tab konnte neben dem Tab landen, wenn Diktate ins unsichtbare Terminal geleitet wurden („Konsole als Ziel\u201c): Die Vermessung las verzerrte Koordinaten, solange das Fenster eingesaugt ruhte. Die Tabs werden jetzt verzerrungsfrei vermessen — die Outline sitzt immer exakt.",
        en: "The window outline around the active tab could land beside the tab when dictations were routed into the hidden terminal (console-as-target): measurement read distorted coordinates while the window rested sucked-in. Tabs are now measured distortion-free — the outline always sits exactly.",
      },
    ],
  },
  {
    version: "0.5.109",
    date: "2026-07-09",
    title: { de: "Ein Glas, ein Guss — der Genie-Flug im vollen Material", en: "One glass, one pour — the genie flight in full material" },
    changes: [
      {
        kind: "fix",
        de: "Das Prompt-Terminal flog heller und durchsichtiger als es steht — und beim Landen flackerte die Titelleiste einmal, wenn das Milchglas zurückkam. Das Fenster trägt jetzt während des gesamten Flugs ein dichtes Glas in seinem normalen Look (inklusive der Tab-Leiste oben, die vorher ungedeckt war), und das echte Milchglas kondensiert beim Ankommen weich darunter statt aufzupoppen.",
        en: "The prompt terminal flew brighter and more see-through than it looks at rest — and on landing the title bar flickered once as the frosted glass returned. The window now wears dense glass in its normal look for the whole flight (including the previously uncovered tab strip on top), and the real frost condenses softly underneath on arrival instead of popping in.",
      },
    ],
  },
  {
    version: "0.5.108",
    date: "2026-07-09",
    title: { de: "Dein Wortschatz zahlt sich aus", en: "Your vocabulary pays off" },
    changes: [
      {
        kind: "feature",
        de: "Echo erkennt jetzt, wenn du das Wort des Tages oder ein Coach-Wort wirklich in einem Diktat benutzt — auch gebeugt („Diskrepanzen“ zählt für „Diskrepanz“) — und feiert das sofort: Mitteilung, Belohnung in der App und XP (Wort des Tages +50, Coach-Wort +20).",
        en: "Echo now recognizes when you actually use the word of the day or a coach word in a dictation — inflected forms count too — and celebrates it instantly: notification, in-app reward and XP (word of the day +50, coach word +20).",
      },
      {
        kind: "feature",
        de: "Neu im Wortschatz-Tab: deine XP-Karte mit Level und Rang-Titel (vom Wortsammler bis zur Eloquenz-Legende), ein Erfolge-Feed deiner gemeisterten Wörter und die Community-Bestenliste — wer erweitert seinen Wortschatz diese Woche am meisten?",
        en: "New in the Learning tab: your XP card with level and rank title, an achievements feed of your mastered words, and the community leaderboard — who is growing their vocabulary the most this week?",
      },
      {
        kind: "improvement",
        de: "Das Wort des Tages bleibt jetzt den ganzen Tag dasselbe — vorher wechselte es still zum nächsten Wort, sobald du es benutzt hattest. Benutzt du es, zeigt die Karte stolz „Heute benutzt“.",
        en: "The word of the day now stays the same all day — previously it silently moved on to the next word once you had used it. Use it and the card proudly shows “Used today”.",
      },
      {
        kind: "improvement",
        de: "Aktivität öffnet jetzt mit „Gesamt“ und zeigt damit dieselben echten Gesamtzahlen wie der Home-Tab. Bei 7/30/90 Tagen erklärt ein Hinweis, dass tagesgenaue Daten erst seit Kurzem gesammelt werden — ältere Diktate stecken in „Gesamt“.",
        en: "Activity now opens on “All time”, matching the real lifetime numbers from the Home tab. On 7/30/90 days a hint explains that day-level data is only collected recently — older dictations live in “All time”.",
      },
      {
        kind: "improvement",
        de: "Die meistgenutzten Wörter wohnen jetzt nur noch im Wortschatz-Tab (in Aktivität waren sie ein Duplikat), und der Verlauf merkt sich statt 500 jetzt bis zu 5.000 Diktate.",
        en: "Top words now live only in the Learning tab (they were a duplicate in Activity), and history now keeps up to 5,000 dictations instead of 500.",
      },
    ],
  },
  {
    version: "0.5.107",
    date: "2026-07-09",
    title: { de: "Der Genie-Austritt, jetzt so weich wie der Sog", en: "The genie exit, now as smooth as the suction" },
    changes: [
      {
        kind: "fix",
        de: "Beim Öffnen blitzte das Prompt-Terminal für einen Augenblick in voller Größe auf, bevor die Animation aus der Pille startete. Das Fenster bleibt jetzt lückenlos verdeckt, bis der erste Animations-Frame es übernimmt — kein Aufblitzen mehr.",
        en: "On open, the prompt terminal flashed at full size for a split second before the animation out of the pill started. The window now stays seamlessly covered until the first animation frame owns it — no more flash.",
      },
      {
        kind: "improvement",
        de: "Das Herauswachsen aus der Pille ist jetzt so geschmeidig wie das Einsaugen: sanfte Zündung statt Vollgas im ersten Frame, weiche Landung, und der Trichter löst sich im Takt der Bewegung auf. Der Start wartet zudem zwei Frames, bis die Grafik-Pipeline warm ist.",
        en: "Growing out of the pill is now as smooth as the suction: gentle ignition instead of full speed on frame one, a soft landing, and the funnel dissolves in step with the motion. The start also waits two frames for the graphics pipeline to warm up.",
      },
      {
        kind: "improvement",
        de: "Wer das Terminal mitten im Flug wieder schließt (oder öffnet), sieht jetzt eine saubere Umkehr entlang desselben Pfads statt eines Sprungs.",
        en: "Closing (or opening) the terminal mid-flight now reverses cleanly along the same path instead of jumping.",
      },
    ],
  },
  {
    version: "0.5.106",
    date: "2026-07-09",
    title: { de: "Die Pille hört jetzt auch leise Stimmen", en: "The pill now hears quiet voices too" },
    changes: [
      {
        kind: "fix",
        de: "Die Sprach-Balken reagierten erst, wenn man laut sprach — eine feste Rauschschwelle lag über normaler Sprechlautstärke und schaltete alles darunter hart stumm. Die Schwelle passt sich jetzt automatisch an die Umgebung an: In einem ruhigen Raum sinkt sie weit ab, und schon normale, leise Sprache lässt die Balken sauber ausschlagen.",
        en: "The voice bars only reacted when you spoke loudly — a fixed noise threshold sat above normal speaking volume and hard-muted everything below it. The gate now adapts to your environment: in a quiet room it drops way down, so normal, quiet speech deflects the bars cleanly.",
      },
      {
        kind: "improvement",
        de: "Kein Alles-oder-nichts mehr: Nahe der Schwelle blenden die Ausschläge weich ein, statt schlagartig von tot auf voll zu springen.",
        en: "No more all-or-nothing: near the threshold the bars fade in softly instead of snapping from dead to full.",
      },
    ],
  },
  {
    version: "0.5.105",
    date: "2026-07-09",
    title: { de: "Die Pille atmet aus der Mitte", en: "The pill breathes from the centre" },
    changes: [
      {
        kind: "fix",
        de: "Die Ausschläge der Sprach-Balken waren links-lastig — das Spektrum lief Bass→Höhen von links nach rechts, und Sprachenergie sitzt nun mal im Bass. Jetzt schlagen die Balken symmetrisch von der Mitte nach außen aus: Mitte = Energie, Ränder = Höhen.",
        en: "The voice bars deflected mostly on the left — the spectrum ran bass→treble left to right, and speech energy lives in the bass. The bars now deflect symmetrically from the centre out: centre = energy, rims = treble.",
      },
      {
        kind: "fix",
        de: "Nach längerem Diktieren konnten die Balken plötzlich ganz aufhören auszuschlagen — bis zum App-Neustart. Ein einziger fehlerhafter Audio-Frame (z. B. beim Kopfhörer-Wechsel) vergiftete die Animations-Glättung dauerhaft. Alle Pfade heilen sich jetzt selbst.",
        en: "After longer dictations the bars could suddenly stop moving entirely — until an app restart. A single bad audio frame (e.g. when switching headphones) permanently poisoned the animation smoothing. All paths now self-heal.",
      },
    ],
  },
  {
    version: "0.5.104",
    date: "2026-07-09",
    title: { de: "Der Zeitraum-Schalter greift jetzt überall", en: "The time-range switcher now applies everywhere" },
    changes: [
      {
        kind: "fix",
        de: "Im Aktivitäts-Bereich folgen jetzt auch die großen Kennzahlen-Karten (Wörter, Diktate, gesparte Zeit, Sprechtempo) dem Zeitraum-Schalter — 7/30/90 Tage zeigen die Summen des Zeitraums, „Alles“ deine Gesamtwerte. Vorher blieben die Karten immer auf Gesamt stehen.",
        en: "In the Activity section the big stat cards (words, dictations, time saved, speaking pace) now follow the time-range switcher — 7/30/90 days show the sums for that window, \"All\" shows your lifetime totals. Previously the cards were always stuck on lifetime.",
      },
      {
        kind: "improvement",
        de: "Hinweis: Die Tages-Historie wächst erst seit diesem Update dauerhaft mit. In den ersten Tagen können 7/30/90 daher noch gleich aussehen — mit jedem diktierten Tag werden die Zeiträume aussagekräftiger.",
        en: "Note: the daily history only accumulates permanently since this update. For the first few days 7/30/90 may still look identical — every dictated day makes the ranges more meaningful.",
      },
    ],
  },
  {
    version: "0.5.103",
    date: "2026-07-09",
    title: { de: "Streaming für alle — ein Schalter weniger", en: "Streaming for everyone — one switch less" },
    changes: [
      {
        kind: "improvement",
        de: "Live-Streaming ist jetzt der Standard für alle: Diktate werden schon während des Sprechens transkribiert und landen beim Loslassen sofort im Zielfenster. Der alte 3-Wege-Schalter (Standard/Schnell/Live) ist weg — niemand muss mehr einen langsameren Modus wählen. Bei Verbindungsproblemen greift wie bisher automatisch der klassische Upload.",
        en: "Live streaming is now the standard for everyone: dictations are transcribed while you speak and the result lands in the target window the moment you release. The old 3-way switch (Standard/Fast/Live) is gone — nobody has to pick a slower mode anymore. On connection issues the classic upload still kicks in automatically.",
      },
      {
        kind: "improvement",
        de: "Live-Tippen (Text erscheint Wort für Wort, während du sprichst) bleibt als schlanker Schalter unter Einstellungen → Transkription erhalten.",
        en: "Live typing (words appear as you speak) remains available as a compact toggle under Settings → Transcription.",
      },
    ],
  },
  {
    version: "0.5.102",
    date: "2026-07-09",
    title: { de: "Der Genie-Sog erreicht die Pille wirklich", en: "The genie suction truly reaches the pill" },
    changes: [
      {
        kind: "fix",
        de: "Die Genie-Animation endete bisher hart an der Fensterkante — die Pille liegt ja unterhalb des Terminals, und gezeichnet werden konnte nur im Fenster. Jetzt wächst die unsichtbare Zeichenfläche für den Flug kurz über die Pille hinaus: der Sog fließt sichtbar bis hinein und die Fläche schrumpft danach zurück.",
        en: "The genie animation used to stop hard at the window edge — the pill sits below the terminal, and drawing was only possible inside the window. The invisible canvas now briefly grows over the pill for the flight: the suction visibly pours all the way in, then the canvas shrinks back.",
      },
      {
        kind: "improvement",
        de: "Die Bewegung ist deutlich geschmeidiger: statt weniger Eckpunkte mit spürbaren Übergängen läuft der ganze Flug jetzt auf einer durchgehenden Kurve — Trichter, Zug und Stauchung bleiben perfekt im Takt, ohne Ruckeln. Auch der Glas-Wechsel am Anfang und Ende blendet jetzt weich über.",
        en: "The motion is much smoother: instead of a few waypoints with felt seams, the whole flight runs on one continuous curve — funnel, pull and squash stay perfectly in phase, no judder. The glass switch at start and end now cross-fades softly too.",
      },
    ],
  },
  {
    version: "0.5.101",
    date: "2026-07-09",
    title: { de: "Aktivität & Wortschatz — zwei neue Bereiche", en: "Activity & Vocabulary Coach — two new sections" },
    changes: [
      {
        kind: "feature",
        de: "Neuer Bereich „Aktivität“: Dein komplettes Diktier-Dashboard — Wörter, Diktate, gesparte Zeit, Tages-Serie und Sprechtempo (Wörter/Min.), dazu Verlaufs-Charts, deine aktivsten Tageszeiten, Tages- und Wochenziele mit Fortschrittsringen und deine meistgenutzten Wörter.",
        en: "New \"Activity\" section: your complete dictation dashboard — words, dictations, time saved, daily streak and speaking pace (words/min), plus trend charts, your most active hours, daily and weekly goals with progress rings, and your most-used words.",
      },
      {
        kind: "feature",
        de: "Neuer Bereich „Wortschatz“: Jeden Tag ein gehobenes Wort des Tages mit Erklärung, Beispiel und Synonymen — dazu Füllwort-Analyse, Wortschatz-Vielfalt und Verbesserungsvorschläge mit stärkeren Alternativen samt Begründung, wann sie besser passen.",
        en: "New \"Vocabulary\" section: an elevated word of the day with meaning, example and synonyms — plus filler-word analysis, vocabulary richness and upgrade suggestions with stronger alternatives, each explained so you know when it fits better.",
      },
      {
        kind: "feature",
        de: "Echo Wrapped & Export: Erstelle einen teilbaren Rückblick deiner Diktier-Statistiken als Bild oder exportiere deine Aktivität als CSV/JSON.",
        en: "Echo Wrapped & export: create a shareable recap of your dictation stats as an image, or export your activity as CSV/JSON.",
      },
      {
        kind: "improvement",
        de: "Der Verlauf merkt sich jetzt bis zu 500 Diktate (vorher 50) — und deine Aktivitäts-Statistiken wachsen ab jetzt dauerhaft mit, unabhängig von der Verlaufs-Größe.",
        en: "History now keeps up to 500 dictations (previously 50) — and your activity stats now accumulate permanently, independent of history size.",
      },
    ],
  },
  {
    version: "0.5.100",
    date: "2026-07-09",
    title: { de: "Die Pille hört feiner hin", en: "The pill listens closer" },
    changes: [
      {
        kind: "improvement",
        de: "Die Balken reagieren jetzt deutlich feiner auf deine Stimme: Auch leises und normales Sprechen bewegt sie sichtbar — jeder Balken passt sich automatisch an deine Lautstärke, dein Mikrofon und deinen Raum an.",
        en: "The bars now respond much more finely to your voice: quiet and normal speech moves them visibly — every bar auto-adapts to your loudness, your microphone and your room.",
      },
      {
        kind: "fix",
        de: "Vorher tanzten fast nur die linken Balken, während Mitte und rechte Seite stur blieben. Jetzt lebt die ganze Pille: Die rechten Balken springen auf S-, T- und Zischlaute an, die Mitte auf den Kern deiner Stimme.",
        en: "Previously only the left bars really danced while the middle and right stayed stubborn. Now the whole pill is alive: the right bars fire on s, t and sibilant sounds, the middle on the core of your voice.",
      },
    ],
  },
  {
    version: "0.5.99",
    date: "2026-07-09",
    title: { de: "Die Genie-Animation, jetzt echt", en: "The genie animation, for real" },
    changes: [
      {
        kind: "fix",
        de: "Das Prompt-Terminal fliegt jetzt sichtbar BIS IN die Pille — vorher löste es sich ein Stück darüber in Luft auf. Es bleibt auf dem ganzen Weg voll sichtbar, und die Pille pulsiert genau im Moment des Eintauchens.",
        en: "The Prompt Terminal now visibly flies ALL THE WAY into the pill — before, it dissolved into thin air just above it. It stays fully visible the whole way, and the pill pulses right at the moment of impact.",
      },
      {
        kind: "improvement",
        de: "Aus dem einfachen Schrumpfen ist ein echter Magic-Lamp-Sog geworden: das Fenster formt sich erst zu einem Trichter, dessen Mündung über der Pille liegt, dann rutscht es beschleunigend hindurch — und beim Öffnen strömt es genauso wieder heraus.",
        en: "The plain shrink is now a real magic-lamp suction: the window first forms a funnel whose mouth sits over the pill, then accelerates down through it — and pours back out the same way when opening.",
      },
    ],
  },
  {
    version: "0.5.98",
    date: "2026-07-09",
    title: { de: "Ruhiges Loslassen", en: "Calm release" },
    changes: [
      {
        kind: "fix",
        de: "Beim Loslassen leuchten die Balken der Pille nicht mehr kurz alle auf — sie gleiten jetzt sanft in den Ruhezustand über, ohne Blitz.",
        en: "Releasing the hotkey no longer makes all pill bars flash up briefly — they now glide smoothly into their resting state, no flare.",
      },
      {
        kind: "improvement",
        de: "Die Pille sitzt wieder knapp über dem Dock — nur ein kleines Stück höher als ursprünglich, statt weit darüber zu schweben.",
        en: "The pill sits just above the Dock again — only slightly higher than originally, instead of floating far above it.",
      },
    ],
  },
  {
    version: "0.5.97",
    date: "2026-07-08",
    title: { de: "Feinschliff an der Pille", en: "Pill polish" },
    changes: [
      {
        kind: "improvement",
        de: "Die Ruhe-Animation der Pille läuft jetzt von links nach rechts (vorher andersherum), und die Farbwechsel zwischen den Zuständen blenden noch weicher über — etwa eine halbe Sekunde statt eines kurzen Schnitts.",
        en: "The pill's idle animation now travels left to right (it ran the other way before), and state color changes cross-fade even more gently — about half a second instead of a quick cut.",
      },
      {
        kind: "improvement",
        de: "Die Pille reagiert jetzt aufs Anfassen: Beim Drüberfahren hebt sie sich dezent an, beim Drücken gibt sie federnd nach. Die Inseln und ihre Menüs übernehmen denselben Liquid-Glass-Stil wie die Pille (neutrales Glas, doppelte Kante) samt Hover- und Klick-Animation — und alles taucht spürbar sanfter auf: das Erscheinen der Pille ist ruhiger geworden, Menüs und Inseln blühen weich auf statt zu schnappen.",
        en: "The pill now responds to touch: hovering lifts it gently, pressing gives a springy dip. The islands and their menus adopt the pill's liquid-glass style (neutral glass, double edge) along with the same hover and click animations — and everything materializes more softly: the pill's appear is calmer, menus and islands bloom in instead of snapping.",
      },
    ],
  },
  {
    version: "0.5.96",
    date: "2026-07-08",
    title: { de: "Der Orb sitzt über dem Dock — und Abbruch ist kein Fehler", en: "The orb clears the Dock — and cancelling is not an error" },
    changes: [
      {
        kind: "fix",
        de: "Der Orb (Pille) am unteren Bildschirmrand sitzt jetzt etwas höher und kollidiert nicht mehr mit dem macOS-Dock in Standardgröße. Eigene, per Drag gesetzte Positionen bleiben unverändert.",
        en: "The orb (pill) anchored at the bottom of the screen now sits slightly higher and no longer collides with a standard-size macOS Dock. Custom drag-set positions are unaffected.",
      },
      {
        kind: "fix",
        de: "Kurz gedrückt und nichts gesagt? Das ist ein Abbruch — der Orb geht jetzt still zurück in den Ruhezustand statt gelb zu blinken. Die Fehlerfarbe erscheint nur noch, wenn eine echte Aufnahme ohne erkennbare Sprache endet (Mikrofon-Warnung) oder wirklich etwas schiefgeht.",
        en: "Pressed briefly and said nothing? That's a cancel — the orb now returns quietly to idle instead of flashing yellow. The error color only appears when a real recording ends with no detectable speech (mic warning) or something actually fails.",
      },
    ],
  },
  {
    version: "0.5.95",
    date: "2026-07-08",
    title: { de: "Das Prompt-Terminal, neu geboren", en: "The Prompt Terminal, reborn" },
    changes: [
      {
        kind: "feature",
        de: "Das Prompt-Terminal gleitet jetzt wie von Zauberhand aus der Pille heraus — und beim Schließen oder Minimieren fließt es wieder in sie hinein, wie ein Fenster, das ins Dock saugt. Die Pille pulsiert kurz, wenn sie das Terminal aufnimmt oder freigibt.",
        en: "The Prompt Terminal now flows out of the pill like magic — and on close or minimize it pours back into it, like a window minimizing into the Dock. The pill pulses as it absorbs or releases the terminal.",
      },
      {
        kind: "feature",
        de: "Echte Fenster-Knöpfe: die vertrauten drei Punkte oben links auf dem Mac (Rot und Gelb gleiten in die Pille, Grün zoomt), und auf Windows die gewohnten Symbole rechts oben.",
        en: "Real window controls: the familiar three dots top-left on Mac (red and yellow flow into the pill, green zooms), and on Windows the usual buttons top-right.",
      },
      {
        kind: "improvement",
        de: "Der aktive Tab ist jetzt Teil des Fensters selbst: die Umrisslinie des Terminals steigt um ihn herum auf, wie bei einem echten Terminal-Tab — und gleitet flüssig mit, wenn du den Tab wechselst.",
        en: "The active tab is now part of the window itself: the terminal's outline rises around it like a real terminal tab — and glides along smoothly when you switch tabs.",
      },
      {
        kind: "improvement",
        de: "Die ganze Oberfläche ist aufgeräumter: größere, freie Symbole ohne Kästchen, eine ruhigere Werkzeugleiste und ein feinerer Look bis in den Fuß des Fensters.",
        en: "The whole surface is cleaner: larger free-standing icons without boxes, a calmer toolbar, and a more refined look all the way down.",
      },
    ],
  },
  {
    version: "0.5.94",
    date: "2026-07-08",
    title: { de: "Die Pille wird zur Linse", en: "The pill becomes a lens" },
    changes: [
      {
        kind: "improvement",
        de: "Die Orb-Pille in Version 2: länger und schlanker, mit neun Balken statt fünf und deutlich mehr Ausschlag — leise ist ein Zucken, laut füllt das Glas. Das Glas selbst bleibt jetzt komplett neutral (keine Einfärbung mehr durch den Status), die Farbe leuchtet nur noch in den Balken. Dazu der Dome-Linsen-Look: verdichtete Ränder, doppelte Glaskante, Inhalt biegt sich sichtbar zur Kante hin.",
        en: "The orb pill, version 2: longer and slimmer, with nine bars instead of five and far more travel — quiet is a flicker, loud fills the glass. The glass itself now stays fully neutral (no more state tinting), color lives in the bars alone. Plus the dome-lens look: compressed rims, a double glass edge, content visibly bending toward the rim.",
      },
      {
        kind: "feature",
        de: "Im Ruhezustand zeigt die Pille jetzt ruhige Punkte statt offener Balken — mit sanftem Atmen, wenn die Leerlauf-Animation an ist. Neu dazu der Farbmodus unter Einstellungen → Overlay: Farbig, „Ruhezustand farblos“ oder „Immer Liquid Glass“ (nur die Bewegung verrät den Status). Statuswechsel blenden jetzt weich ineinander über, und das Aufleuchten beim Erscheinen nutzt deine Ruhe-Farbe.",
        en: "At rest the pill now shows calm dots instead of open bars — gently breathing when the idle animation is on. New color mode under Settings → Overlay: colored, “colorless at rest” or “always liquid glass” (motion alone tells the state). State changes now cross-fade smoothly, and the appear bloom uses your idle color.",
      },
    ],
  },
  {
    version: "0.5.93",
    date: "2026-07-08",
    title: { de: "Loslass-Sound: drei neue wählbare Klänge", en: "Release sound: three new selectable tones" },
    changes: [
      {
        kind: "feature",
        de: "Der Loslass-Sound (beim Ende der Aufnahme) hat jetzt drei eigene Klänge zur Auswahl: Standard, Tief und Ausklang. Wählbar unter Einstellungen → Sounds mit Vorhör-Button — genau wie beim Aktivierungs- und Einfüge-Sound.",
        en: "The release sound (when recording ends) now has three tones to choose from: Standard, Low and Fade. Pick one under Settings → Sounds with a preview button — just like the activation and paste sounds.",
      },
    ],
  },
  {
    version: "0.5.92",
    date: "2026-07-08",
    title: { de: "Der Hotkey-Wähler, kompakter und überall", en: "The hotkey picker, tighter and everywhere" },
    changes: [
      {
        kind: "improvement",
        de: "Der Hotkey-Wähler öffnet sich jetzt kompakter und weiter oben — die Tastatur, die Haltedauer und alles passen ohne Scrollen ins Fenster.",
        en: "The hotkey picker now opens more compact and higher up — the keyboard, the hold duration and everything fit on screen without scrolling.",
      },
      {
        kind: "feature",
        de: "Auch der Hotkey für die Prompt-Konsole hat jetzt denselben Wähler: klick aufs Feld, und die Tastatur klappt auf — dieselbe Freiheit, eine Kombination oder eine einzelne Taste bzw. einen Modifier (Control, Option …) zu wählen.",
        en: "The Prompt-Console hotkey now uses the same picker too: click the field and the keyboard drops in — the same freedom to pick a combo or a single key/modifier (Control, Option …).",
      },
    ],
  },
  {
    version: "0.5.91",
    date: "2026-07-08",
    title: { de: "Eine einzelne Taste zum Diktieren", en: "A single key to dictate" },
    changes: [
      {
        kind: "feature",
        de: "Halte jetzt eine einzelne Taste zum Diktieren — Control oder die Wahltaste ganz allein. Klick in den Einstellungen → Diktat auf das Hotkey-Feld, und die leuchtende Tastatur aus dem Intro klappt auf: eine Kombination drücken oder eine einzelne Taste wählen. Dazu ein Regler für die Haltedauer — wie lange du die Taste halten musst, bevor die Aufnahme startet. Kurzes Antippen löst nichts aus, und die Taste bleibt normal nutzbar (Control kopiert weiter). Einzeltasten brauchen einmalig die macOS-Freigabe „Eingabeüberwachung“.",
        en: "Hold a single key to dictate now — Control or Option all by itself. In Settings → Dictation, click the hotkey field and the illuminated keyboard from the intro drops in: press a combo or pick a single key. Plus a hold-duration slider — how long to hold before recording starts. A short tap does nothing, and the key stays usable as normal (Control still copies). Single keys need the one-time macOS “Input Monitoring” permission.",
      },
      {
        kind: "fix",
        de: "Der Loslass-Sound lässt sich jetzt eigenständig ausschalten. Er hing vorher am Start-Sound-Schalter — wer den Einfüge-Sound abgeschaltet hatte, hörte ihn trotzdem bei jedem Loslassen. Jetzt hat er seinen eigenen Schalter unter Einstellungen → Sounds.",
        en: "The release sound can now be turned off on its own. It used to ride the start-sound toggle, so silencing the paste sound still left it playing on every release. It has its own switch now under Settings → Sounds.",
      },
    ],
  },
  {
    version: "0.5.90",
    date: "2026-07-08",
    title: { de: "Der Orb leuchtet auf", en: "The orb lights up" },
    changes: [
      {
        kind: "feature",
        de: "Der Orb taucht jetzt mit einer Materialize-Animation auf: Licht verdichtet sich zur Pille, die Balken zünden gestaffelt aus dem Aufleuchten — nach dem Start und immer, wenn der Orb aus dem Versteckt-Modus zurückkommt. Vier Varianten unter Einstellungen → Overlay → „Erscheinen“: Aufleuchten (Standard), Pop, Sanft, Aus — mit Test-Button in der Live-Vorschau.",
        en: "The orb now materializes with an appear animation: light condenses into the pill and the bars ignite out of the bloom — after launch and whenever the orb returns from hidden. Four variants under Settings → Overlay → “Appear”: light bloom (standard), pop, soft fade, off — with a preview button in the live configurator.",
      },
      {
        kind: "improvement",
        de: "Auch alle anderen Orb-Stile erscheinen jetzt mit dem Aufleuchten statt einfach da zu sein. Orb-Profile speichern die Erscheinen-Einstellung mit.",
        en: "Every other orb style now materializes with the bloom instead of just being there. Orb profiles store the appear setting too.",
      },
    ],
  },
  {
    version: "0.5.89",
    date: "2026-07-08",
    title: { de: "Ein Sound zum Loslassen", en: "A sound for letting go" },
    changes: [
      {
        kind: "feature",
        de: "Der Start-Sound bekommt sein akustisches Gegenstück: Lässt du die Diktier-Taste los, hörst du denselben Sound rückwärts — ein sanfter Swoosh, der die Aufnahme sauber abschließt. Spielt instant, auch wenn Echo im Tray versteckt ist, und folgt deiner bestehenden Start-Sound-Einstellung (Lautstärke + An/Aus) unter Einstellungen → Sounds.",
        en: "The start sound now has its acoustic counterpart: release the dictation key and you hear the same sound played backwards — a gentle swoosh that closes out the recording. Plays instantly, even with Echo hidden in the tray, and follows your existing start-sound setting (volume + on/off) under Settings → Sounds.",
      },
    ],
  },
  {
    version: "0.5.88",
    date: "2026-07-08",
    title: { de: "Die neue Orb-Pille", en: "The new orb pill" },
    changes: [
      {
        kind: "feature",
        de: "Echo hat ein neues Gesicht: die Orb-Pille — eine Liquid-Glass-Kapsel mit fünf Balken, die live auf deine Stimme reagieren. Beim Aufnehmen schlagen sie mit dem echten Stimmspektrum aus, in Ruhe atmen sie sanft. Die Pille ist ab jetzt der Standard-Look des Overlays.",
        en: "Echo has a new face: the orb pill — a liquid-glass capsule with five bars that react to your voice live. While recording they follow your real voice spectrum; at rest they breathe gently. The pill is now the overlay's standard look.",
      },
      {
        kind: "improvement",
        de: "Dein gewählter Orb-Stil bleibt erhalten — nur wer noch den bisherigen Standard (Sonar) nutzt, bekommt einmalig die neue Pille. Alle Stile weiterhin unter Einstellungen → Overlay, inklusive Live-Vorschau.",
        en: "Your chosen orb style is preserved — only installs still on the previous default (Sonar) move to the new pill once. All styles remain under Settings → Overlay, live preview included.",
      },
    ],
  },
  {
    version: "0.5.87",
    date: "2026-07-08",
    title: { de: "Kein Diktat geht mehr verloren", en: "No dictation gets lost anymore" },
    changes: [
      {
        kind: "feature",
        de: "Einsprechen ohne aktives Textfeld? Dein Diktat landet jetzt automatisch in der Prompt-Konsole (öffnet sich dezent, ohne dir den Fokus zu klauen) statt ins Leere zu gehen — zusätzlich liegt es wie immer in der Zwischenablage. Abschaltbar unter Einstellungen → Prompt-Konsole → „Konsole als Auffangnetz“. (macOS)",
        en: "Dictating with no active text field? Your dictation now automatically lands in the Prompt Console (opens quietly, without stealing focus) instead of going nowhere — and it’s on the clipboard as always. Turn it off under Settings → Prompt Console → “Console as safety net”. (macOS)",
      },
    ],
  },
  {
    version: "0.5.86",
    date: "2026-07-07",
    title: { de: "Deutsche Kommas sitzen jetzt automatisch", en: "German commas now land automatically" },
    changes: [
      {
        kind: "improvement",
        de: "Diktate bekommen fehlende Kommas jetzt automatisch gesetzt: vor Nebensätzen („das geht nicht weil …“ → „das geht nicht, weil …“), bei „um … zu“-Gruppen und vor „sondern“. Verhörtes „gesagt das er“ wird zu „gesagt, dass er“. Regelbasiert und ohne zusätzliche Latenz — Mehrdeutiges bleibt unangetastet. Abschaltbar unter Einstellungen → Cleanup → „Deutsche Kommasetzung“.",
        en: "Dictation now gets missing German commas inserted automatically: before subordinate clauses (“das geht nicht weil …” → “das geht nicht, weil …”), around “um … zu” groups and before “sondern”. A misheard “gesagt das er” becomes “gesagt, dass er”. Rule-based with zero added latency — ambiguous cases are left alone. Turn it off under Settings → Cleanup → “German comma insertion”.",
      },
    ],
  },
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
