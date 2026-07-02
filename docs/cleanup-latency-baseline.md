# Cleanup Latency Baseline + Optimisation (2026-06-28/29)

How much does AI cleanup add to a dictation, and why. Measured directly in the
**prod `transcribe-api` container** against the real `claude -p` Abo path.

**Update 2026-06-29 (TJ: "make it faster"):** built a server-side optimisation
that hides the Node boot — **prewarm + startup-flags, ~0.6 s off felt cleanup,
still 100 % over the Abo, staged (not yet deployed).** See "Optimisation" below.

## TL;DR
- Cleanup adds **~2.4 s** to a short dictation on the live model (**sonnet**).
- Breakdown: **~0.8 s** Node/CLI process start (fixed per call) + **~1.5–2 s**
  model inference for a short output.
- Latency scales with **output length**, not input: rewrite-heavy styles
  (letter, social, email) generate more text → 5–10 s; light styles (tidy,
  notes, slack) stay ~2 s.
- 🔴 **haiku is 4–5× SLOWER than sonnet over the Abo** (~10–15 s) — counter-
  intuitive, but it's the subscription routing. The live `CLEANUP_MODEL=sonnet`
  is already the right latency choice. (The old `echo-cleanup-abo` handoff still
  says "haiku" — stale; verify before trusting.)

## Where the time goes
Normal dictation runs cleanup **inline** on `/v1/transcribe` (one round trip,
combined transcribe+cleanup — see `main.py::_inline_cleanup`). So the user-felt
press→paste time is:

```
press→paste  =  Whisper GPU (~0.4 s)  +  claude -p cleanup  +  network
                                          └─ ~0.8 s process start
                                          └─ inference (output-length bound)
```

The cleanup `claude -p` call is a **fresh Node process per dictation** (no warm
pool — `claude -p` is one-shot). The ~0.8 s start is Node boot + CLI init; it is
already trimmed (`--exclude-dynamic-system-prompt-sections`, empty `--mcp-config`
with `--strict-mcp-config`, `--tools ""`).

## Measurements (prod container, 3 calls each, short German dictation)

claude -p, identical cleanup flags:

| Model  | wall (3 runs)        | process start (wall−cli_dur) | inference (api_ms) |
|--------|----------------------|------------------------------|--------------------|
| sonnet | 2.89 / 3.06 / 2.41 s | ~0.79–0.88 s                 | ~1.7–3.3 s         |
| haiku  | 10.1 / 14.7 / 13.6 s | ~0.86 s                      | ~10.3–16.0 s       |

Per-style, end-to-end through the real `cleanup()` (sonnet, output-length effect):

| Style  | time   | why                                  |
|--------|--------|--------------------------------------|
| notes  | 1.8 s  | short bullet output                  |
| tidy   | 2.4 s  | near-passthrough                     |
| social | 5.7 s  | full post = more output tokens       |
| letter | 9.6 s  | full letter body = most output       |

## Optimisation BUILT 2026-06-29 (server-side, staged — needs deploy)
Two changes in `cleanup.py` + `main.py`, both 100 % over the Abo, no UX/quality
change, env-toggleable, with a hard fallback to the normal path:

1. **Prewarm** (`cleanup_prewarm`/`cleanup_finish`/`cleanup_cancel`): spawn the
   `claude -p` process the instant the transcribe request arrives, so its Node
   boot runs **in its own OS process while Whisper transcribes** (the boot
   overlaps even though the blocking GPU call holds the event loop). The
   transcript is fed via stdin once Whisper is done. A `_settle()` arbiter frees
   the concurrency slot exactly once across finish/cancel/watchdog; a watchdog
   reaps a never-fed process. `CLEANUP_PREWARM=0` disables it instantly.
   → **measured median ~0.4 s saved** (cold 2.3–2.6 s → prewarmed 1.8–1.9 s),
   plus a tighter tail (cold spiked to 4.3 s, warm capped ~2.2 s).
2. **Startup flags** `--no-session-persistence --no-chrome` on every cleanup call
   → **~0.2 s** less per call, output byte-identical (verified). (`--bare` does
   NOT work — it skips OAuth → "Not logged in", and doesn't cut Node boot anyway.)

Combined vs current prod: **~0.6 s off the felt cleanup** (~2.4 s → ~1.8 s for a
short dictation; the boot is fully hidden for longer ones). Verified end-to-end
in the container (`scratchpad/{verify_prewarm,bench_prewarm,integration_test}.py`)
— output correct, edge cases (empty/cancel/idempotency/limit-fallback) clean, no
slot leak. NOT yet exercised against a live HTTP `/v1/transcribe` (needs deploy).

The remaining ~1.6–1.8 s is the **subscription inference floor** (TTFT) — only
beatable by the metered API or a local model, both excluded by "über das Abo".

## Levers NOT taken (and why)
- **Keep sonnet.** haiku is a latency trap over the Abo (4–5× slower). Re-test
  periodically (`/tmp/measure_cleanup.py`) in case routing changes.
- **Warm process POOL** (idle pre-booted processes): would hide the boot even for
  sub-0.8 s dictations, but costs steady idle RAM (~hundreds of MB/proc on the
  16 GB box) for marginal gain over per-request prewarm. Not worth it.
- **Optimistic paste + reconcile**: feels "free" but risky in foreign apps; TJ
  ruled it out (2026-06-28).
- **Skip cleanup for already-clean / very short text** (heuristic) — marginal.

## How to re-measure
`scratchpad/measure_cleanup.py` (sonnet vs haiku, cold+warm) and
`scratchpad/verify_styles.py` (per-style output + timing). Run inside the
container: `docker cp … transcribe-api:/tmp/ && docker exec transcribe-api
python3 /tmp/measure_cleanup.py`.
