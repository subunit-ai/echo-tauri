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
