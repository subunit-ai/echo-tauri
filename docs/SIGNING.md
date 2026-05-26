# Signing & Secrets

## Updater (minisign) — REQUIRED for auto-update
The updater verifies each release with a minisign signature.

- **Public key**: committed in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key**: generated with `npm run tauri -- signer generate`. Kept **out of
  the repo** (dev keypair lives at `~/.config/echo-signing/echo.key` on the build
  box). Password: stored separately.

CI secrets (GitHub → Settings → Secrets):
- `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

> Rotate to a fresh production keypair before the first public release and keep
> the private key in a secrets manager. If the private key is lost, auto-update
> for already-installed clients breaks (they only trust the old public key).

## Windows code-signing (Authenticode) — REQUIRED for Windows GA
Unsigned `.exe`s get quarantined by Bitdefender / corporate AV (the historic
Windows blocker). Plan: **Azure Trusted Signing**.

Configure in `src-tauri/tauri.conf.json` → `bundle.windows` (signCommand or
certificate thumbprint) and add the Azure credentials as CI secrets. Tauri
bundler ≥ 2.9 signs ARM64 too.

## Sentry (optional, no-op without DSN)
- `ECHO_SENTRY_DSN` — Rust backend DSN.
- `VITE_SENTRY_DSN` — frontend DSN (build-time).

No audio or transcript content is ever sent to Sentry.
