# The getUpdates slot: prefer-live-holder

Telegram's Bot API allows **exactly one** `getUpdates` consumer per token.
This plugin guards that slot with a pid file (`$STATE_DIR/bot.pid`) and a
boot-time policy in `server.ts`. This document describes a
production-observed failure mode of the original last-writer-wins reap, the
prefer-live-holder policy that replaced it, and the reasoning behind each
design choice.

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
every run) before the fix was written. `tests/poller-slot.test.ts` is that
replication, ported to `bun test`.

## The fix: four coupled changes in `server.ts`

**1. Prefer-live-holder (the boot block).** The slot belongs to a holder that
is *both alive and fresh*. A newcomer that finds one logs
`deferring to live holder pid=<N>` and exits 0 — it never signals a live,
working peer. Dead holders (ESRCH on the probe) are claimed exactly as
before; alive-but-stale holders are SIGTERMed exactly as before. The only
behavior change is for the one case the old code got wrong. Both decisions
now run only after the recycled-PID check (below).

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
unlinked, and the log line finally tells the truth. Whatever supervises the
server — the next session, an external watchdog — sees a dead poller instead
of a live deaf one, and can act.

**4. Audit trail.** Every boot appends one line per slot decision to
`$STATE_DIR/poller-audit.log`:

```
2026-07-11T14:47:51.021Z pid=829738 ppid=829729 parent="bun run --cwd ... start" decision=claimed
2026-07-11T14:47:51.379Z pid=829766 ppid=829757 parent="bun run --cwd ... start" decision=deferred pid=829738
2026-07-11T14:47:52.838Z pid=829836 ppid=829827 parent="bun run --cwd ... start" decision=reaped pid=829824
```

A fourth decision, `ignored pid=<N>`, records a recycled PID (see below).

`parent` is the launching process's argv (`/proc/<ppid>/cmdline`, `ps`
fallback off-Linux, best-effort). The first hijack *attempt* after deployment
names the offending process definitively — "what keeps launching second
pollers" stops being a guessing game. The file is size-guarded at boot
(tail-truncated past 256 KB), so it needs no external rotation.

Supporting change: `TELEGRAM_API_ROOT` overrides grammy's `apiRoot` — it
makes the plugin usable against self-hosted Bot API servers and gives the
test suite a way to force deterministic 409s locally.

## Follow-up: the mid-life 409, where §2 and §3 both failed to fire

Change 3 above shipped, and did not work for the 409 that actually happens in
production. The retry loop reset its attempt counter inside `onStart`:

```ts
for (let attempt = 1; ; attempt++) {
  await bot.start({ onStart: info => { attempt = 0; ... } })
```

`onStart` fires when **`getMe`** succeeds; a mid-life 409 is raised afterwards,
by **`getUpdates`**. So every iteration reset the counter *before* the failure
was counted, and two things followed:

- `attempt >= 8` was never true — **the §3 exhaustion release was unreachable**
- `Math.min(1000 * attempt, 15000)` with `attempt === 0` is `0` — a busy loop

And because a busy loop *is* a running poll loop, the heartbeat kept touching
`bot.pid`, so **§2 staleness reaping never fired either** and every newcomer
correctly deferred (§1) to a holder that had been deaf for hours. Measured on a
stub API: **5,317 `retrying in 0s` in 10 seconds, no exhaustion, ever.**

The fix is to reset on *demonstrated health* rather than on a start event — a
poller must stay up `STABLE_MS` before its backoff clears. A stuck poller then
accumulates attempts, exhausts, and releases the slot; a poller that recovers
from a transient conflict still gets its counter cleared and is not evicted for
unrelated blips accumulated over a long life.

**Why the original test suite missed it:** `conflictStub` answers 409 to *every*
call including `getMe`, so `onStart` never fires and attempts accumulate by
accident. That covers the **cold** 409 (booting into a held slot); it cannot
express the **mid-life** one. `midlifeConflictStub` (getMe ok, getUpdates 409)
and `flakyStub` (transient, then healthy) cover both directions now. Both fail
against the pre-fix server.

## Recycled PIDs: only a server.ts can hold the slot

A holder that dies uncleanly (SIGKILL, OOM, a crash) leaves its pid in
`bot.pid`, and the kernel can hand that pid to any new process. Stock v0.0.7
added a check before the SIGTERM: `ps -p <pid> -o args=` must name
`server.ts`. This fork runs the same check before *both* boot decisions. A
live process whose argv does not name `server.ts` is not a holder, so the
newcomer neither signals it nor defers to it: it audits
`decision=ignored pid=<N>` and claims the slot. Deferring to such a process
would leave the token with no poller at all.

The check reads argv, not identity, so a reused pid that lands on another
`server.ts` still reads as a holder: on a host that runs several bots, that
can be a different bot's poller. Without a `ps` binary the check throws and
the newcomer claims, as stock's does.

## What is deliberately NOT done

- **No lock file.** Deferral *is* the lock semantics; a separate lock file
  adds stale-lock failure modes without adding safety.
- **No JSON pid file.** `{pid, ts}` would carry the heartbeat in-band, but it
  breaks every existing reader of the bare-pid format and makes mixed-version
  rollout hazardous. mtime carries exactly the one needed bit.
- **No change to the dead-holder path.** ESRCH-probe-then-claim keeps its
  pre-existing semantics. Its pid-reuse window is now closed for any process
  that is not a `server.ts` (see Recycled PIDs above).
- **Defer = exit 0 (minimal form).** A richer variant would stay resident and
  serve *outbound-only* tools (sendMessage needs no slot) while skipping
  `bot.start()`. Either satisfies the fix; the minimal form is what is
  implemented, and the resident form is a compatible future refinement.

## Compatibility during mixed-version rollout

- New newcomer + old holder: the old holder never heartbeats, so after 120s
  of uptime it reads as stale and is reaped — identical to today's behavior
  for it.
- Old newcomer + new holder: the old newcomer still murders (it has the old
  code). Full protection requires all instances in an environment to run the
  new version.
- The pid-file format and shutdown ownership check are unchanged. The orphan
  watchdog follows stock v0.0.7: it watches stdin only (stock dropped the
  ppid check because it false-fires when a wrapper exits), and the heartbeat
  still runs on its 5s interval.

## Tests

```
cd external_plugins/telegram
bun test
```

The scenario inventory and harness mechanics live in
`tests/poller-slot.test.ts`'s header — the executable version of this
document. The suite runs the real `server.ts` as real processes against
in-process stub Bot API servers: no network, no real token. The 409 test
takes ~30s by design — it exercises the retry backoff unmodified.
