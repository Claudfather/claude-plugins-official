#!/bin/sh
# Install-free spawn.
#
# Dependencies are vendored into the plugin dir at install/update time, so the
# normal spawn does ZERO install work and cannot race bun's node_modules/.bin
# linker. Only a genuinely-missing tree self-repairs. Getting that repair safe
# under concurrent cold spawns took three properties, each of which was a
# separately-observed failure on aarch64 with 8 concurrent spawns:
#
# 1. THE DEPS CHECK MUST HAPPEN UNDER A LOCK, not before one. Checking first and
#    locking second means every concurrent spawn decides to install before any of
#    them holds the lock; the lock then faithfully serializes N redundant
#    installs, and each later one rewrites node_modules underneath servers that
#    earlier spawns already started. Measured: 8 spawns, 8 decisions, 8 installs.
#
# 2. THE CHECK IS NOT A VALID FAST PATH EITHER. `node_modules/<pkg>` appears
#    partway through an install, so a spawn arriving mid-install sees "deps
#    present", skips the lock entirely and execs against a half-populated tree.
#    Both 1 and 2 surface identically — a running server dying on
#    `Cannot find package 'zod'` — which is why instrumenting the lock shows it
#    serializing perfectly while spawns keep dying. Hence the per-directory gate
#    below is taken UNCONDITIONALLY: it is the thing that makes "is this tree
#    usable?" a question with a stable answer.
#
# 3. THE INSTALL ITSELF NEEDS A HOST-GLOBAL LOCK. `bun install` reads and writes
#    the bun install cache, which is shared by every plugin dir on the host, so a
#    per-directory lock leaves the actually-contended resource unguarded when two
#    different plugins cold-install at once.
#
# Hence two locks with different jobs: a per-directory gate around the decision,
# and a host-global lock around the install. Nesting them this way keeps the warm
# path off the global lock, so a healthy spawn never waits behind an unrelated
# plugin's cold install and cannot blow the MCP connect deadline.
set -u

DEPS=node_modules/@modelcontextprotocol
DIR_LOCK="$PWD/.install.lock"
CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-${BUN_INSTALL:-$HOME/.bun}/install/cache}"
mkdir -p "$CACHE_DIR" 2>/dev/null || CACHE_DIR="${TMPDIR:-/tmp}"
GLOBAL_LOCK="$CACHE_DIR/.claude-plugin-install.lock"

# Install output goes to stderr: stdout is the MCP stdio transport.
if command -v flock >/dev/null 2>&1; then
    flock "$DIR_LOCK" sh -c '
        [ -d "$1" ] && exit 0
        flock "$2" bun install --frozen-lockfile --no-summary 1>&2
    ' _ "$DEPS" "$GLOBAL_LOCK"
else
    # No flock (stock macOS). mkdir is atomic on POSIX, so it serves as a
    # portable mutex. Bounded wait: a spawn that cannot take the gate proceeds
    # rather than hanging past Claude Code's MCP connect deadline.
    waited=0
    until mkdir "$DIR_LOCK.d" 2>/dev/null; do
        waited=$((waited + 1))
        [ "$waited" -ge 120 ] && break
        sleep 1
    done
    [ -d "$DEPS" ] || bun install --frozen-lockfile --no-summary 1>&2
    rmdir "$DIR_LOCK.d" 2>/dev/null || true
fi

exec bun server.ts
