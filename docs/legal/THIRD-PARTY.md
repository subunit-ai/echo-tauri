# Open-Source-Komponenten Dritter

> Echo bündelt Open-Source-Software, die ihren eigenen (durchweg permissiven) Lizenzen
> unterliegt. Generierte, versionsgenaue Listen — vor jedem Release neu erzeugen:
> - Frontend (npm): [`THIRD-PARTY-npm.md`](./THIRD-PARTY-npm.md) — alles MIT/Apache-2.0/ISC.
> - Backend (Rust): [`THIRD-PARTY-rust.md`](./THIRD-PARTY-rust.md) — MIT/Apache-2.0/BSD/ISC/Unicode.

## Generieren

**Rust (`src-tauri/`):**
```bash
cargo install cargo-about
cargo about generate about.hbs > THIRD-PARTY-rust.html   # oder: cargo-license / cargo-deny
```

**Frontend (npm):**
```bash
npx license-checker --production --summary        # Überblick
npx license-checker --production --json > THIRD-PARTY-npm.json
```

## Hauptkomponenten (Überblick, nicht abschließend)
- **Rust:** tauri & tauri-plugins (MIT/Apache-2.0), reqwest/rustls, tokio, serde, cpal, enigo,
  arboard, regex, core-graphics/core-foundation, sentry, whisper-rs (feature-gated) u. a.
- **Frontend:** react, react-dom, i18next/react-i18next, @tauri-apps/api, qrcode.react, vite,
  typescript u. a. (überwiegend MIT).

Vor jeder Veröffentlichung neu generieren, damit Versionen und Lizenztexte aktuell sind.
