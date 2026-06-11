#!/usr/bin/env bash
# Synct die vendored meet-core-Rust-Crate aus dem kanonischen Repo
# (subunit-ai/meet-core) nach src-tauri/crates/meet-core.
#
# meet-core ist die EINZIGE Quelle der Diarisierungs-Logik + Schwellen
# (PARAMS.json). Server (echo-server, Python) und Echo (Rust) konsumieren
# vendored Kopien — Änderungen IMMER zuerst in meet-core (Versions-Bump +
# Golden-Tests py+rs grün), dann hier syncen. NIE die vendored Kopie editieren.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${MEET_CORE_REPO:-$HERE/../meet-core}"
DST="$HERE/src-tauri/crates/meet-core"

[ -d "$SRC/rust/src" ] || { echo "FEHLER: meet-core Repo nicht gefunden unter $SRC (MEET_CORE_REPO setzen)"; exit 1; }

# Drift-Wächter an der Quelle: gebundelte params.json muss PARAMS.json entsprechen
if ! python3 -c "import json,sys; a=json.load(open('$SRC/PARAMS.json')); b=json.load(open('$SRC/rust/src/params.json')); sys.exit(0 if a==b else 1)"; then
  echo "FEHLER: meet-core rust/src/params.json driftet von PARAMS.json — erst dort syncen+committen"
  exit 1
fi

mkdir -p "$DST"
rsync -a --delete --exclude target/ --exclude Cargo.lock "$SRC/rust/" "$DST/"

REV="$(git -C "$SRC" rev-parse --short HEAD)"
VER="$(python3 -c "import json; print(json.load(open('$SRC/PARAMS.json'))['version'])")"
cat > "$DST/VENDORED.md" <<EOF
# VENDORED — nicht editieren!
Quelle: https://github.com/subunit-ai/meet-core @ $REV (PARAMS $VER)
Sync:   scripts/sync-meet-core.sh
EOF

echo "OK: meet-core @ $REV (PARAMS $VER) → src-tauri/crates/meet-core"
