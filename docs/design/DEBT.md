# Known low-severity debt

These are verified issues, deferred to a cleanup sweep so they don't block milestone work. Each one names its source.

## M1 (from the M1 fix verification, 2026-10-08)
- **N1, `loading` cleared while an existing world is still opening.** `ClientSession.java:128-131`, `WorldTicker.java:31-36`. `WorldOpenFlows#openWorld` resumes asynchronously through `Util.backgroundExecutor()`, so `loading` is cleared mid-open, and a duplicate `world.open` stored as `pendingOpen` is never cleared by `markReady`.
  - **Fix:** clear `pendingOpen` in `markReady`/`markClosed` for that world, and don't clear `loading` in the tick before the timeout.
  - **Test gap:** S7 never reopens an existing live world.
  - **Doc:** API_MAP §7.2 says loads happen in one client task, which is wrong for `openWorld`.
- **N2, run-lock empty-file window.** `runLock.ts:124-126` writes the lock with `open('wx')` and fills it in afterwards, so another starter that reads the empty file treats it as stale.
  - **Fix:** write a temp file and `link` it into place, or treat an empty or young lock as live.
  - Also: `ps lstart` is compared as a TZ-dependent string.
- **N3, dead save left unburied after a crash.** `WorldLifecycle.ts:112,167` persists the advance before the burial hook (`:114,173`). A Node crash in between leaves the dead save in `saves/`; the dead marker still guards it.
  - **Fix:** a durable "bury pending" record, retried at startup.
- **Doc:** Node's `world.open` never sends a seed. Either drop "Node's seed" from PLAN or implement it.

## PC manager (from round-2 verification)
- **Monitor vs. `bootAll`.** A concurrent monitor pass can stop a container just before `bootAll` adopts it. `bootAll` then restarts the same container (rootfs kept). Benign, but wasteful.
- The engine release on shutdown is now capped at 20 s and left running on timeout. Verify the next start adopts it cleanly.
