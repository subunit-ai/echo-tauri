#!/bin/bash
# Sync the vendored meet UI from the canonical source (projects/meet-react/src).
# Interim until meet-ui is its own published repo / submodule. Run after any meet-react change.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$HERE/meet-ui"
cp -r "$HERE/../meet-react/src" "$HERE/meet-ui"
rm -f "$HERE/meet-ui/main.tsx"
echo "✓ synced meet-ui ← ../meet-react/src"
