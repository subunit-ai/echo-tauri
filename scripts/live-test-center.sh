#!/usr/bin/env bash
# Live-typing test center for Echo dictation.
#
# Replays REAL speech through the REAL client reconcile logic (agreed_stable +
# plan_target in src-tauri/src/transcribe/stream.rs) into a simulated buffer, so
# live-typing correctness + stalls + wild-deletes + latency can be checked WITHOUT
# a human dictating. The simulated buffer is byte-identical to what would land in
# the target app, because plan_target is the single source of truth for both.
#
# Two ways to get fixtures:
#   1) Opt-in app capture (preferred — uses Echo's own fresh auth, real timing):
#        launch Echo with ECHO_LIVE_DEBUG=1, dictate normally; each dictation writes
#        ~/.config/echo/livetest/<unix_ms>.json. Then: ./live-test-center.sh --all
#   2) Re-stream an audio file to the server (needs a fresh access token in
#        ~/.config/echo/config.json — dictate once first if it has expired):
#        ./live-test-center.sh path/to/voice.m4a   (any ffmpeg-decodable audio)
#
# Usage:
#   ./live-test-center.sh <audio-file>        convert→16k PCM, stream+capture, report
#   ./live-test-center.sh --replay <fix.json> replay one fixture offline (no server)
#   ./live-test-center.sh --all               replay every ~/.config/echo/livetest/*.json
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../src-tauri" && pwd)"
FIXDIR="$HOME/.config/echo/livetest"
CARGO=(cargo test --lib --quiet --)

run_replay() { ECHO_LIVE_FIXTURE="$1" "${CARGO[@]}" --ignored livetest_replay --nocapture; }

case "${1:-}" in
  --replay)
    [ -f "${2:-}" ] || { echo "usage: $0 --replay <fixture.json>"; exit 1; }
    cd "$HERE"; run_replay "$2" ;;
  --all)
    cd "$HERE"
    shopt -s nullglob
    found=0
    for f in "$FIXDIR"/*.json; do
      found=1; echo "════ $f ════"; run_replay "$f" || true
    done
    [ "$found" = 1 ] || echo "no fixtures in $FIXDIR — launch Echo with ECHO_LIVE_DEBUG=1 and dictate" ;;
  ""|-h|--help)
    sed -n '2,32p' "$0" ;;
  *)
    AUDIO="$1"
    [ -f "$AUDIO" ] || { echo "no such file: $AUDIO"; exit 1; }
    PCM="$(mktemp -t echo-lt).pcm"
    FIX="$(mktemp -t echo-lt).json"
    echo "→ converting to 16k s16le mono PCM…"
    ffmpeg -hide_banner -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -f s16le "$PCM"
    cd "$HERE"
    ECHO_LIVE_AUDIO="$PCM" ECHO_LIVE_FIXTURE="$FIX" "${CARGO[@]}" --ignored livetest_capture --nocapture
    echo "fixture: $FIX" ;;
esac
