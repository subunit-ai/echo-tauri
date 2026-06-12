#!/bin/bash
# Sync the vendored meet UI from the canonical source (projects/meet-react/src).
# Interim until meet-ui is its own published repo / submodule. Run after any meet-react change.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$HERE/meet-ui"
cp -r "$HERE/../meet-react/src" "$HERE/meet-ui"
rm -f "$HERE/meet-ui/main.tsx"
echo "✓ synced meet-ui ← ../meet-react/src"

# meet-ui references a handful of public assets by absolute path (e.g. /notion.svg,
# /dsgvo-icon.png). The native embed serves them from Echo's public/ — vendor them too,
# else the icons 404. (PWA-only assets like manifest.json / icon-192/512 are NOT needed.)
mkdir -p "$HERE/public"
for f in notion.svg dev-multi-icon.png dsgvo-icon.png pod-mic-icon.png single-icon.png bg-wave6-1080.mp4 bg-wave6-2160.mp4 bg-wave6-2160-hq.mp4 bg-wave-poster.jpg; do
  cp "$HERE/../meet-react/public/$f" "$HERE/public/$f" 2>/dev/null \
    && echo "  ✓ public/$f" || echo "  ⚠ missing in meet-react/public: $f"
done
echo "✓ synced meet public assets → public/"
