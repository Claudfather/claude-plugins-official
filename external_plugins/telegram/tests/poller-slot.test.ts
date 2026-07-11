/**
 * getUpdates slot-policy tests: prefer-live-holder, dead/stale reap,
 * heartbeat, 409 slot release, audit trail. See POLLER-SLOT.md.
 *
 * Every poller is pointed at a LOCAL stub Bot API via TELEGRAM_API_ROOT
 * (a healthy stub for the slot-mechanics tests, an always-409 stub for
 * the exhaustion test) — the suite never touches Telegram and needs no
 * real token. Pollers run the real server.ts the way Claude Code does:
 * a bun process with stdin held open (closing stdin = the MCP client
 * disconnect path).
 *
 * The scenarios run in file order and share one state dir on purpose —
 * the slot lifecycle under test IS sequential (claim → hijack attempt →
 * crash → reap → staleness → release), and the audit log at the end
 * must show that whole story.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN_DIR = join(import.meta.dir, '..')
const STATE_DIR = mkdtempSync(join(tmpdir(), 'tg-poller-slot-'))
const PID_FILE = join(STATE_DIR, 'bot.pid')
const AUDIT_FILE = join(STATE_DIR, 'poller-audit.log')
const FAKE_TOKEN = '8888888:AAAAAAAAAAAAAAAAAAAA'

// Stale threshold in server.ts is 120s (24x the 5s heartbeat cadence).
const BACKDATE_MS = 10 * 60 * 1000

type Poller = {
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  stderr: () => string
  end: () => void
}

const procs: ReturnType<typeof Bun.spawn>[] = []

// --- stub Bot API servers ---------------------------------------------------

function botApiJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Healthy: getMe answers a fake bot, getUpdates long-polls briefly and stays
// empty, everything else succeeds generically. A poller against this stub is
// a genuinely working poller (poll loop running -> heartbeat active).
const healthyStub = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() ?? ''
    if (method === 'getMe') {
      return botApiJson({
        ok: true,
        result: { id: 8888888, is_bot: true, first_name: 'stub', username: 'slot_test_bot' },
      })
    }
    if (method === 'getUpdates') {
      await Bun.sleep(1000)
      return botApiJson({ ok: true, result: [] })
    }
    return botApiJson({ ok: true, result: true })
  },
})

// Conflict: every call answers 409, so bot.init() itself throws and attempts
// accumulate without onStart ever resetting the counter — the exhaustion
// branch trips deterministically in ~30s (upstream backoff: 1+2+..+7s).
const conflictStub = Bun.serve({
  port: 0,
  fetch() {
    return botApiJson(
      { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
      409,
    )
  },
})

// --- helpers -----------------------------------------------------------------

function spawnPoller(apiRoot: string): Poller {
  let buf = ''
  const proc = Bun.spawn({
    cmd: ['bun', 'server.ts'],
    cwd: PLUGIN_DIR,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // Minimal env: never leak a real TELEGRAM_BOT_TOKEN from the caller.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TELEGRAM_STATE_DIR: STATE_DIR,
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_API_ROOT: apiRoot,
    },
  })
  const decoder = new TextDecoder()
  void (async () => {
    for await (const chunk of proc.stderr) buf += decoder.decode(chunk)
  })()
  procs.push(proc)
  return {
    proc,
    pid: proc.pid,
    stderr: () => buf,
    end: () => proc.stdin.end(),
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

function pidFile(): string | null {
  try {
    return readFileSync(PID_FILE, 'utf8')
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const healthyRoot = `http://127.0.0.1:${healthyStub.port}`
const conflictRoot = `http://127.0.0.1:${conflictStub.port}`

beforeAll(async () => {
  // server.ts imports resolve from the plugin dir; make sure deps exist.
  const install = Bun.spawn({ cmd: ['bun', 'install', '--no-summary'], cwd: PLUGIN_DIR })
  expect(await install.exited).toBe(0)
}, 120000)

afterAll(() => {
  for (const p of procs) p.kill('SIGKILL')
  healthyStub.stop(true)
  conflictStub.stop(true)
  rmSync(STATE_DIR, { recursive: true, force: true })
})

// --- the slot lifecycle -------------------------------------------------------

let A: Poller // the victim-to-be: a live, working poller
let C: Poller // claims after A crashes
let D: Poller // claims after reaping a stale holder

test('boot claims the slot and audits the claim', async () => {
  A = spawnPoller(healthyRoot)
  await waitFor(() => pidFile() === String(A.pid), 'A to claim bot.pid')
  await waitFor(() => A.stderr().includes('polling as @slot_test_bot'), 'A to start polling')
  expect(readFileSync(AUDIT_FILE, 'utf8')).toMatch(
    new RegExp(`pid=${A.pid} ppid=\\d+ parent=".*" decision=claimed`),
  )
}, 20000)

test('a second instance DEFERS to the live fresh holder instead of killing it', async () => {
  const B = spawnPoller(healthyRoot)
  await waitFor(() => B.stderr().includes(`deferring to live holder pid=${A.pid}`), 'B to defer')
  expect(await B.proc.exited).toBe(0)

  // The old behavior this suite exists to prevent: SIGTERM of the live holder.
  expect(B.stderr()).not.toInclude('replacing stale poller')
  expect(A.stderr()).not.toInclude('shutting down')
  expect(alive(A.pid)).toBe(true)
  expect(pidFile()).toBe(String(A.pid))
  expect(readFileSync(AUDIT_FILE, 'utf8')).toInclude(`decision=deferred pid=${A.pid}`)
}, 20000)

test('a DEAD holder is still reaped (crashed-session orphans cannot pin the token)', async () => {
  A.proc.kill('SIGKILL') // crash: no graceful unlink, bot.pid left behind
  await A.proc.exited
  await waitFor(() => !alive(A.pid), 'A to be gone')
  expect(pidFile()).toBe(String(A.pid)) // the stale slot file survives the crash

  C = spawnPoller(healthyRoot)
  await waitFor(() => pidFile() === String(C.pid), 'C to claim the crashed slot')
  expect(readFileSync(AUDIT_FILE, 'utf8')).toMatch(
    new RegExp(`pid=${C.pid} .*decision=claimed`),
  )
}, 20000)

test('an alive-but-STALE holder is reaped (deaf holders stay reclaimable)', async () => {
  C.end() // graceful client disconnect: C unlinks and exits
  await C.proc.exited
  await waitFor(() => pidFile() === null, 'C to release the slot')

  // A live process that never heartbeats, holding a backdated slot file —
  // the shape of a holder whose poll loop died without releasing the slot.
  const decoy = Bun.spawn({ cmd: ['sleep', '600'] })
  procs.push(decoy)
  writeFileSync(PID_FILE, String(decoy.pid))
  const old = new Date(Date.now() - BACKDATE_MS)
  utimesSync(PID_FILE, old, old)

  D = spawnPoller(healthyRoot)
  await waitFor(() => D.stderr().includes(`replacing stale poller pid=${decoy.pid}`), 'D to reap the stale holder')
  await waitFor(() => pidFile() === String(D.pid), 'D to claim the slot')
  expect(readFileSync(AUDIT_FILE, 'utf8')).toInclude(`decision=reaped pid=${decoy.pid}`)
}, 20000)

test('the holder heartbeats bot.pid mtime while the poll loop runs', async () => {
  await waitFor(() => D.stderr().includes('polling as @slot_test_bot'), 'D to start polling')
  const m1 = statSync(PID_FILE).mtimeMs
  // Heartbeat cadence is 5s (the orphan-watchdog interval).
  await waitFor(() => statSync(PID_FILE).mtimeMs > m1, 'mtime to advance', 8000)
  expect(pidFile()).toBe(String(D.pid)) // content untouched: bare pid, no rewrite
}, 20000)

test('persistent 409 exhaustion EXITS and RELEASES the slot (no deaf zombie)', async () => {
  D.end()
  await D.proc.exited
  await waitFor(() => pidFile() === null, 'D to release the slot')

  const E = spawnPoller(conflictRoot)
  await waitFor(() => pidFile() === String(E.pid), 'E to claim the slot')
  await waitFor(
    () => E.stderr().includes('409 Conflict persists after 8 attempts'),
    'E to exhaust its 409 retries',
    50000,
  )
  await E.proc.exited
  await waitFor(() => pidFile() === null, 'E to release the slot on exit', 5000)
  expect(E.stderr()).toInclude('shutting down')
}, 60000)

test('the audit trail tells the whole story in a parseable format', () => {
  const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n')
  // A claimed, B deferred, C claimed, D reaped + claimed, E claimed.
  expect(lines.length).toBeGreaterThanOrEqual(6)
  for (const line of lines) {
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+ ppid=\d+ parent=".*" decision=(claimed|deferred pid=\d+|reaped pid=\d+)$/,
    )
  }
})
