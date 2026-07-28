#!/bin/sh
# S1 (fork fix): install-free spawn.
# Dependencies are vendored into the plugin dir at install/update time, so the
# normal spawn does ZERO work in the shared cache dir and therefore cannot race
# bun's node_modules/.bin linker. Only a genuinely-missing tree self-repairs,
# and that install is serialized by an flock so concurrent cold spawns run the
# installer exactly once instead of racing it.
[ -d node_modules/@modelcontextprotocol ] || flock "$PWD/.install.lock" bun install --frozen-lockfile --no-summary
exec bun server.ts
