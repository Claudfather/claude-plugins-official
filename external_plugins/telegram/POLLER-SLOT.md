# The getUpdates slot: hijack bug and the prefer-live-holder fix

Telegram's Bot API allows **exactly one** `getUpdates` consumer per token.
This plugin guards that slot with a pid file (`$STATE_DIR/bot.pid`) and a
boot-time reap. This document describes a production-observed failure mode of
the original reap, the fix this branch applies to `server.ts`, and the
reasoning behind each design choice — written for review toward upstreaming
into `anthropics/claude-plugins-official` (`external_plugins/telegram/`).

Fork lineage: `anthropics/claude-plugins-official` @ `6fbe3b0`.

## The bug: last-writer-wins reap murders the live poller

The original boot block read `bot.pid`, probed the holder with
`process.kill(pid, 0)`, and — if the holder was alive — SIGTERMed it and
claimed the slot. That reap was designed for one target: an orphaned poller
left behind by a crashed session (SIGKILL, closed terminal), which would
otherwise pin the token forever and 409 every new session.

The problem: the reap cannot distinguish that orphan from **the live poller
of the current, healthy session**. Sequence observed in production, on a
host running many concurrent Claude Code sessions:

1. A session's telegram MCP server (poller A) is up, polling, holding
   `bot.pid`.
2. A second claude-family process starts in the same environment — a
   transient/headless run inheriting the session's env — and launches the
   telegram MCP. That newcomer (B) boots `server.ts` in the same
   `$STATE_DIR`.
3. B finds A's pid, logs `replacing stale poller pid=<A>`, SIGTERMs A. A
   exits via its graceful shutdown path. B writes its own pid and polls.
4. B's client goes away (transients are short-lived). B's shutdown unlinks
   `bot.pid` — correctly, it owns the file — and exits.
5. The slot is now **abandoned**. A's Claude session logs nothing when a
   connected MCP server dies and never respawns it. The bridge is dark until
   a full session restart, which can be hours away.

A second, subtler dark flavor lived in the polling retry loop: after 8
persistent 409-Conflict attempts the loop logged "…Exiting." and `return`ed —
but only out of the async IIFE. The MCP stdin kept the process alive, deaf,
still holding `bot.pid`: structurally healthy to any pid-liveness check,
functionally dead.

Both mechanisms were confirmed by deterministic replication (two pollers, a
fake token, a private state dir — the sequence above reproduces byte-for-byte
every run) before this fix was written, and the fix was validated against the
same replication before being transcribed here. The test suite in
`tests/poller-slot.test.ts` is that replication, ported to `bun test`.

## The fix: four coupled changes to `server.ts`

**1. Prefer-live-holder (the boot block).** The slot belongs to a holder that
is *both alive and fresh*. A newcomer that finds one logs
`deferring to live holder pid=<N>` and exits 0 — it never signals a live,
working peer. Dead holders (ESRCH on the probe) are claimed exactly as
before; alive-but-stale holders are SIGTERMed exactly as before. The only
behavior change is for the one case the old code got wrong.

**2. Heartbeat (freshness signal).** The holder freshens `bot.pid`'s *mtime*
every 5s from the already-existing orphan-watchdog interval — content is
never rewritten, so the bare-pid format stays parseable by anything that
reads the file today. The touch is gated on the poll loop actually running
(a flag flips false when the polling IIFE settles) and ownership-checked
like the unlink in `shutdown()`. Freshness therefore means "poll loop
alive", not "process alive" — which is exactly what makes a deaf holder
reapable. Staleness threshold: 120s = 24x the cadence, so a loaded host
never mistakes a live-but-slow holder for a stale one.

**3. 409 exhaustion releases the slot.** The persistent-Conflict branch now
calls `shutdown()` instead of `return`: the process exits, `bot.pid` is
unlinked, and the log line finally tells the truth. External supervision
(anything watching for a missing poller) can now see and heal the condition.

**4. Audit trail.** Every boot appends one line per slot decision to
`$STATE_DIR/poller-audit.log`:

```
2026-07-11T14:47:51.021Z pid=829738 ppid=829729 parent="bun run --cwd ... start" decision=claimed
2026-07-11T14:47:51.379Z pid=829766 ppid=829757 parent="bun run --cwd ... start" decision=deferred pid=829738
2026-07-11T14:47:52.838Z pid=829836 ppid=829827 parent="bun run --cwd ... start" decision=reaped pid=829824
```

`parent` is the launching process's argv (`/proc/<ppid>/cmdline`, `ps`
fallback off-Linux, best-effort). The first hijack *attempt* after deployment
names the offending process definitively — this is how "what keeps launching
second pollers" stops being a guessing game. The file is size-guarded at boot
(tail-truncated past 256 KB), so it needs no external rotation.

Supporting change: `TELEGRAM_API_ROOT` overrides grammy's `apiRoot` — it
makes the plugin usable against self-hosted Bot API servers and gives the
test suite a way to force deterministic 409s locally.

## What we deliberately did NOT do

- **No lock file.** Deferral *is* the lock semantics; a separate lock file
  adds stale-lock failure modes without adding safety.
- **No JSON pid file.** `{pid, ts}` would carry the heartbeat in-band, but it
  breaks every existing reader of the bare-pid format and makes mixed-version
  rollout hazardous. mtime carries exactly the one needed bit.
- **No change to the dead-holder path.** ESRCH-probe-then-claim keeps its
  pre-existing semantics, including its narrow pid-reuse window — unchanged
  from upstream, not widened by this patch.
- **Defer = exit 0 (minimal form).** A richer variant would stay resident and
  serve *outbound-only* tools (sendMessage needs no slot) while skipping
  `bot.start()`. Either satisfies the bug fix; the minimal form is what's
  implemented, and we're happy to rework to the resident form if preferred.

## Compatibility during mixed-version rollout

- Patched newcomer + old holder: the old holder never heartbeats, so after
  120s of uptime it reads as stale and is reaped — identical to today's
  behavior for it.
- Old newcomer + patched holder: the old newcomer still murders (it has the
  old code). Full protection requires all instances in an environment to run
  the patched version.
- The pid-file format, shutdown ownership check, and orphan watchdog are
  unchanged.

## Tests

```
cd external_plugins/telegram
bun test
```

`tests/poller-slot.test.ts` runs the real `server.ts` as real processes
(stdin held open the way an MCP client does) against in-process stub Bot API
servers — no network, no real token. It covers, in lifecycle order: boot
claim, defer-not-murder, dead-holder reap, stale-holder reap, heartbeat,
409-exhaustion exit + slot release, and the audit-log format. The 409 test
takes ~30s by design: it exercises the upstream retry backoff unmodified.

## Change map

| File | Change |
|---|---|
| `server.ts` | the four changes above + `TELEGRAM_API_ROOT` |
| `tests/poller-slot.test.ts` | new: the slot-policy suite |
| `package.json` | new `test` script |
| `.claude-plugin/plugin.json` | fork-local version bump 0.0.6 → 0.0.7 (cache-busting for fork-marketplace consumers; maintainers should re-version as they see fit) |
| `POLLER-SLOT.md` | this document |
