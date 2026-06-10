---
name: API server EADDRINUSE / orphaned process on restart
description: Why the api-server intermittently fails to start on port with EADDRINUSE, and the durable fix.
---

# API server orphaned process → EADDRINUSE on restart

The api-server workflow would intermittently fail to start with
`EADDRINUSE 0.0.0.0:8080`, which silently breaks uploads/transcription because
the API is down. Symptom from the user side: "upload breaks again".

**Root cause:** the dev script chained `pnpm run build && pnpm run start`, so the
long-running `node dist/index.mjs` was a grandchild behind an extra `sh -c`
layer. On workflow restart the SIGTERM did not reach that grandchild, leaving an
orphaned node process still bound to the port. The next start then collided.

**Fix (two parts, both needed):**
1. `dev` script ends with `exec node …` (not `pnpm run start`) so node replaces
   the shell and is a direct child that actually receives signals.
2. `index.ts` installs SIGTERM/SIGINT handlers that `server.close()` + exit
   (with an unref'd 5s force-exit fallback) so the port is released promptly.

**Why:** without an explicit graceful shutdown AND a flat process tree, a SIGTERM
can orphan the node process / leave the socket bound.

**How to apply:** any long-running Node service in this monorepo started via a
nested `pnpm run` chain should `exec` the final node process and handle
SIGTERM/SIGINT. If you see EADDRINUSE here again, check for an orphaned
`node dist/index.mjs` (ps) holding the port before assuming a code bug.
