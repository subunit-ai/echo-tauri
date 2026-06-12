# Datenschutzerklärung — Echo

> **ENTWURF — vor Veröffentlichung anwaltlich prüfen lassen.** Dieser Text beschreibt die
> Datenverarbeitung technisch korrekt nach dem aktuellen Stand der App; er ersetzt keine
> Rechtsberatung. Platzhalter `[…]` vor Veröffentlichung füllen.

Stand: [Datum] · App-Version: ab v0.4.x · Verantwortlicher: Subunit UG [Anschrift, Kontakt,
ggf. Datenschutzbeauftragter]

## 1. Überblick
Echo ist eine Desktop-App für Hotkey-Diktat und Meeting-Erfassung. Wie Daten verarbeitet
werden, hängt vom gewählten **Modus** ab:

- **Lokal (on-device):** Aufnahme, Transkription und – bei lokalen Meetings (Pro) –
  Sprecher-Trennung laufen vollständig auf deinem Gerät. **Audio verlässt das Gerät nicht.**
- **Cloud (DSGVO):** Die Audioaufnahme wird zur Transkription an `transcribe.subunit.ai`
  (Server in Deutschland) übertragen, dort verarbeitet und das Ergebnis zurückgesendet.

Du wählst den Modus in der App; der aktive Modus wird angezeigt.

## 2. Verarbeitete Daten & Zwecke

| Datenart | Wann | Zweck | Wohin |
|---|---|---|---|
| Audioaufnahme | bei aktiver Aufnahme | Transkription | lokal **oder** `transcribe.subunit.ai` (DE) je nach Modus |
| Transkript-Text | nach Transkription | Anzeige, Verlauf, Einfügen in die Zielanwendung | lokal (`~/.config/echo`), Zwischenablage |
| Konto-/Anmeldedaten (E-Mail, Tokens) | bei Login | Authentifizierung der Cloud-Nutzung | `auth.subunit.ai`; Tokens lokal gespeichert (Datei-Rechte 0600) |
| Meeting-Aufnahmen/-Transkripte | bei Meetings | Protokoll/Zusammenfassung | lokal; Cloud-Meetings zusätzlich serverseitig |
| Vokabular-Einträge | bei Nutzung | Korrektur wiederkehrender Begriffe | lokal |
| Absturz-/Fehlerberichte | bei Fehlern (nur wenn aktiviert) | Stabilität | Sentry — **ohne** Audio- oder Transkriptinhalte |
| Update-Prüfung | regelmäßig | Software-Aktualisierung | GitHub (Release-Manifest) |

**Keine Inhalte in Logs/Telemetrie:** Diagnose-Logs und Absturzberichte enthalten nur
Zähler/Metadaten (z. B. Zeichenanzahl), **nie** den Transkript- oder Audioinhalt.

## 3. Rechtsgrundlagen (DSGVO)
- **Art. 6 Abs. 1 lit. b** (Vertragserfüllung) — Bereitstellung der von dir gewählten
  Transkriptions-/Meeting-Funktion.
- **Art. 6 Abs. 1 lit. a** (Einwilligung) — optionale Cloud-Verarbeitung, Absturzberichte.
  Widerruf jederzeit über die Einstellungen.
- **Art. 6 Abs. 1 lit. f** (berechtigtes Interesse) — Stabilität/Missbrauchsabwehr.

## 4. Empfänger & Auftragsverarbeitung
- `transcribe.subunit.ai`, `auth.subunit.ai` — Server in Deutschland, betrieben von
  [Anbieter/AVV-Status]. Bei Cloud-Nutzung Auftragsverarbeitungsvertrag (Art. 28 DSGVO) [Status].
- Sentry [Anbieter/Region/AVV] — nur bei aktivierter Fehlerberichterstattung.
- GitHub [Microsoft] — nur Update-Manifest-Abruf (keine personenbezogenen Inhalte).
- **Keine Weitergabe** von Audio/Transkripten an Dritte zu Werbezwecken.

## 5. Speicherdauer
- Lokale Daten (Verlauf, Vokabular, Tokens) bleiben bis zu deiner Löschung auf dem Gerät
  (`~/.config/echo`); der Verlauf ist in der App löschbar.
- Cloud-seitige Speicherdauer der Audio-/Transkriptdaten: [serverseitige Retention angeben].

## 6. Deine Rechte
Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch
(Art. 15–21 DSGVO) sowie Beschwerde bei einer Aufsichtsbehörde. Kontakt: [E-Mail].

## 7. Drittland-Übermittlung
Die Transkription erfolgt auf Servern in Deutschland. Sofern einzelne Dienste (z. B. Sentry,
GitHub) Daten außerhalb der EU verarbeiten, geschieht dies auf Basis geeigneter Garantien
(z. B. EU-Standardvertragsklauseln) [konkretisieren].

## 8. Änderungen
Diese Erklärung wird bei funktionalen Änderungen aktualisiert; die jeweils gültige Fassung ist
[Ort/URL] abrufbar.
