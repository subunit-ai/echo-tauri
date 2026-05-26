# Echo (Tauri)

Hotkey-driven dictation + meeting capture — the Tauri rewrite of the Python/PyQt6
Echo app. Rust backend + React/TS frontend, native builds for Windows x64,
**Windows ARM64**, Linux, and (later) macOS.

Why the rewrite: the PyInstaller build was heavy and slow, and a whole class of
bugs came from x64 emulation on Windows ARM (requests/WSAEACCES, SendInput, lost
Ctrl+V, no ctranslate2 ARM wheels). A **native ARM64 Tauri build removes that
entire class**, with a much smaller binary and faster start.

## Stack
- **Backend (Rust, `src-tauri/`)**: cpal (audio), tauri-plugin-global-shortcut
  (push-to-talk + toggle), reqwest/rustls (cloud), enigo + arboard (paste-back),
  whisper-rs/whisper.cpp (local STT, feature `local-whisper`), tauri-plugin-updater,
  sentry.
- **Frontend (React + TS + Vite, `src/`)**: Home / Settings / History, design
  tokens ported from the old `theme.py` (cyan on deep navy).
- **Server**: unchanged — speaks the existing `transcribe.subunit.ai` /
  `auth.subunit.ai` contract.

## Develop
```bash
npm install
npm run tauri dev                                # cloud path (fast iteration)
npm run tauri dev -- --features local-whisper    # + on-device whisper.cpp
```
Linux dev prereqs: `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
librsvg2-dev libayatana-appindicator3-dev libasound2-dev libxdo-dev libssl-dev
build-essential clang libclang-dev cmake patchelf`.

## Build / Release
Tag `vX.Y.Z` → `.github/workflows/release.yml` builds + signs all platforms via
`tauri-action` and publishes a draft release + updater manifest. See
[`docs/SIGNING.md`](docs/SIGNING.md) for signing keys + secrets.

## Config
`~/.config/echo/config.json` (1:1 with the old `synapse-voice` schema; the legacy
file is migrated automatically on first run).

## Status
M1 (core dictation) is built: config + IPC, cpal recorder, global hotkey,
cloud + local transcription, paste-back, account auth, tray, updater, Sentry.
Next: M2 orb/bubble overlay + streaming, M3 meetings/onboarding/vocabulary UI,
M4 Azure Trusted Signing + first signed release.
