# Echo — Audit & Roadmap

Stand: 2026-05-30. Basis: Stabilitäts-/Port-/UX-/Marktreife-Audit (10 Subsystem-Analysen
+ adversariale Verifikation) gegen den vollständigen Python/PyQt6-Vorgänger
(`sonar/synapse_voice`, ~18k Zeilen). `cargo check` + `clippy` (Default-Features) sauber.

## Fundament (was bereits gut ist)
- cpal-Aufnahme über dedizierten Worker-Thread (löst `!Send`-Stream sauber), 30-Min-Buffer-Cap.
- `parking_lot`-Locks mit engen Scopes, kein Deadlock-Risiko, nur ~11 `unwrap` (meist statische Regex).
- IPC-Vertrag (`ipc.ts` ↔ `commands.rs`) stimmt 1:1; Secrets werden vor Frontend & auf Disk (0600) geschützt.
- Nativer Updater (minisign) + reqwest/tokio-tungstenite (rustls) statt hand-gerolltem Python-Stack.
- Atomarer Windows-Paste-Chord (ein `SendInput`-Batch) statt enigos racendem 3-Call-Chord.

---

## P0 — Blocker vor jedem Kundenkontakt
1. **Login fror die App bis 30 Min ein** — `login` war synchroner Command, blockierte den Main-Thread. → *Sprint 1: behoben (async + spawn_blocking).*
2. **Mikrofon-Fehler wurde verschluckt** — UI zeigte „Aufnahme", obwohl kein Audio kam. → *Sprint 1: behoben (Start meldet Fehler → `EngineState::Error`).*
3. **Kein Windows-Code-Signing** → AV-Quarantäne. → *Sprint 3 (Azure Trusted Signing nach Gründung).*
4. **Kein globaler ErrorBoundary** → White-Screen bei Render-Fehler. → *Sprint 1: behoben (`Sentry.ErrorBoundary` + Fallback).*
5. **Updater auf Dev-minisign-Key** → Rotation vor GA zwingend. → *Sprint 3.*

## P1 — Stabilität
- **Live-WS (`live_ws.rs`)**: kein Reconnect, `SERVER_READY` wird nie abgewartet, Prefix-Match verwirft
  Server-Korrekturen, kein Fehler-Feedback/Timeout. → *Sprint 2.*
- **`config.save()` nicht atomar** → Token-/History-Verlust bei Crash. → *Sprint 1: behoben (temp+rename, serialisiert).*
- **Token-Refresh-Race** in `ensure_fresh` → Zwangs-Logout. → *Sprint 1: behoben (single-flight + double-check).*
- **Kein Single-Instance-Guard** → zwei Instanzen kollidieren um Hotkey/Tray/Config. → *Sprint 1: behoben.*
- **Fenster-X beendet die App** (Hotkey-Daemon stirbt). → *Sprint 1: behoben (Hide-to-Tray).*
- Recorder-Snapshot O(n²) im Live-Pfad; 30-Min-Cap schneidet still ab; Whisper-Mutex über Inferenz;
  Heap-Alloc pro Audio-Callback (I16/U16); kein Cloud-Retry. → *Sprint 2.*

## Port-Lücken (was noch rein muss)
| Modul (Python) | Status | Prio |
|---|---|---|
| `autostart.py` | fehlt komplett | MUSS (`tauri-plugin-autostart`) |
| `i18n.py` (~150 Keys) | toter `ui_language`-Schalter, DE-hartkodiert | MUSS für nicht-DACH |
| `target_lock.py` | nur capture/focus/paste portiert (retry-shield, focused-child-HWND, WM_PASTE fehlen) | MUSS für Win |
| `meet_host_stream.py` + `meeting_host.py` | nur Stub (Browser öffnen) | HOCH — bauen oder ausblenden |
| Account-Refresh (Plan/Trial vom Server) | weggefallen | HOCH fürs Geschäftsmodell |
| `ui/tray.py` | nur Open/Toggle/Quit, statisches Icon | MITTEL |
| `languages.py` (99 Sprachen) | nur 56 in `languages.ts` | MITTEL |
| `bridge_client.py`, BYO-Provider, ONNX | fehlt / bewusst weg | NICE (ONNX-Verzicht korrekt) |

## UX-Sprünge
- Onboarding stark verkürzt (kein Login/Mikro-Test/Hotkey-Schritt).
- Kein Toast-/Notification-System → stille Fehler.
- Destruktive Aktionen ohne Bestätigung; Vocabulary-Dirty-Guard fehlt.
- Orb blockiert Klicks auf transparenten Pixeln (statisches click-through statt Hit-Test).
- `apply_config` feuert bei jedem Settings-Patch (Overlay-Flackern); Config-`patch()`-Race;
  Stale State Orb↔Hauptfenster; Clipboard wird nie wiederhergestellt; toter `echo://mic-level`-Push.
- A11y (`:focus-visible`, Tastatur-Nav), `prefers-reduced-motion`, Hilfe-Section leer.

## Marktreife & Azure-Signing (Sprint 3, nach Gründung)
1. Azure Trusted Signing (CI-Secrets, `bundle.windows.signCommand`, Bundler ≥2.9 signiert ARM64) → löst AV-Quarantäne.
2. Prod-minisign-Key, Dev-Key ersetzen, privaten Key in Secrets-Manager.
3. Rechtsartefakte: Lizenz, Datenschutzerklärung (Cloud sendet Audio!), EULA, Publisher-Metadaten.
4. WebView2-Bootstrapper; Hauptfenster `label`/Mindestgröße/Center; macOS = Phase 2.

---

## Sprint-Plan
- **Sprint 1 (Stabilität) ✅ erledigt (Branch `fix/sprint1-stability`, PR #2):** Login-async, Mic-Fehler-State,
  ErrorBoundary, atomares Save, Refresh-Single-Flight, Single-Instance, Hide-to-Tray, Login-UI-Feedback.
  Codex-Review: 0 P0; 2 P1 + 1 P2 (per-Prozess-Temp, 0600-before-write, Late-Stream-Abort) — alle gefixt.
- **Sprint 2 (Live + Port) — teilweise erledigt (gleicher Branch):**
  - ✅ Live-WS gehärtet (SERVER_READY abwarten, Reconnect, Connect-Timeout, Fehler→Error-State).
  - ✅ Autostart (`tauri-plugin-autostart` + Settings-Toggle).
  - ✅ Toast-System + globale Engine-Fehler + Lösch-Bestätigung.
  - ✅ **i18n** (PR #3): react-i18next, de/en-Katalog (234 Keys, symmetrisch), `ui_language`-Picker,
    alle 13 string-tragenden Komponenten auf `t()` migriert.
  - ✅ **Onboarding-Rebuild** (PR #3): 5-Schritt-Flow (Welcome → Konto/Login → Mikro-Live-Test →
    Hotkey → Modus/Features), i18n-nativ.
  - ⏳ offen: **target_lock-Robustheit** — BLOCKIERT auf Windows-Gerätetest (retry-shield/
    focused-child-HWND/WM_PASTE sind reiner Windows-FFI-Code, nicht auf Linux verifizierbar).
    Vocabulary-Dirty-Guard, Orb-click-through-Hit-Test, languages.ts auf 99, Overlay-Strings (eigener Root).
- **Sprint 3 (Marktreife):** Azure-Signing + Key-Rotation + Rechtsartefakte → erste signierte Release.
