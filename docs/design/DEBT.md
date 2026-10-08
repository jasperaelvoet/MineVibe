# Known debt

These are verified issues, deferred to a cleanup sweep so they don't block milestone work. Each one names its
source. Fixed items are removed (the git history keeps them); the I4 sweep of 2026-10-08 fixed M1 N2 (run-lock
empty-file window, time-zone-dependent start times), M1 N3 (dead save left unburied after a crash), the "Node's
seed" PLAN wording, the `world.state` office slot kind (`pc` vs `workstation`), the flaky `devServer` and
`approach` tests and the flaky `skill_craft_places_atable_for3x3` GameTest. The live acceptance run of 2026-10-09
(docs/design/ACCEPTANCE.md) fixed the I4 agent-id blocker (Node now mints `<handle><4 hex>`), the blank head icon
during a new agent's first turn, speech bubbles that dropped text before a dotted token, agents mining the starter
office, and a game that never left BootScreen when its window started hidden.

## Found in the live acceptance run (2026-10-09)
- **Visible oak is unreachable on most seeds.** `mine oak_log` fails `UNREACHABLE (no_path)` for an exposed oak 11 to
  18 blocks away on seeds `minevibe-e2e` and `42`, from inside the office and again from the porch outside the door;
  seed `mv-forest-1` works. In live run 1 the CEO then mined other logs (and, before the office fix, the office's
  corner posts). A plain `mine oak_log` without `radius` answered `NOT_FOUND` ("found only 0 of 10") while `find`
  (radius 64) listed oak at 10.7 blocks. Zero-token repro: `node --conditions=source --import tsx
  scripts/e2e/run-scenario.ts --crew scripted --steps 1,0 --seed 42` (`oakMineJob`, `oakFromPorch` in the result).
  - **Suspects:** `Miner` picks the nearest *exposed* log, which can be high in the canopy; `AgentNavigator` counts
    segments that do not get closer as fruitless and gives up after 4 (`MAX_FRUITLESS_SEGMENTS`), so a detour fails.
  - **Fix:** prefer trunk logs reachable from the ground (or rank targets by path cost), and let `mine`'s default
    radius match what `find` reports.
- **PCs have no `/mnt/codex`.** PLAN §6.6 promises the Codex export read-only at `/mnt/codex` (and `~/codex`), but
  `PcManager` never mounts `paths.codexExport` and `PcGuestApi.info` returns `codexPath: null`; the CEO's
  `ls /mnt/codex` failed in the PC flow. The export lives under `MINEVIBE_HOME`, which in development is inside
  `~/Documents` (TCC-protected, so Apple `container` cannot mount it): the mount source must sit outside, like the
  container roots.
- **The mod's `ok` replies drop nested nulls.** `ProtocolCodec.encodeOk` converts each value with `GSON`, which has no
  `serializeNulls`, so a null inside a nested map or `JsonObject` is left out, although the method's comment says nulls
  are kept. `debug.state`'s per-agent and per-monitor keys are `nullish` because of it.
  - **Fix:** convert with the null-keeping `WRITER`, after checking Node's reply schemas for nested keys that are
    optional but not nullable.
- **A plan card without a plan.** A seated, plan-first agent that states its plan in prose and calls `ExitPlanMode`
  without writing `~/.claude/plans/*.md` gets a card reading "(No plan file was captured…)", and the player approves
  blind (live run 1, kick step). Fix: fall back to the turn's last assistant text.
- **Throwaway homes leak PC instances into the dev engine.** Every fresh `MINEVIBE_HOME` mints a new PC instance id;
  its container, network and three volumes stay in `~/Library/Application Support/MineVibe-dev/container` after quit
  (the VM stops; the network's vmnet helper runs as long as the engine does). The acceptance harness removes its own
  (`scripts/e2e/out/leaked-instances.txt`); `npm run play` with a scratch home does not.
  - **Fix:** prune instances whose `pcs.json` no longer exists, or name the instance after something stable.

## Found in the I4 sweep (2026-10-08)
- **The status footer is sent twice.** The mod puts `footer` into every job `result` and observation; Node also
  appends its own footer (from `agent.state`) to every `mcp__mc__*` result. `summarizeResult` and `compactJson`
  (`apps/server/src/agents/EventRouter.ts:325`, `tools/results.ts`) JSON-encode the mod's result as is, so the
  agent sees both, and the mod's footer eats into the 200-character job summary.
  - **Fix:** Node drops the `footer` key before rendering (or the mod stops sending it). protocol.md §7.4 states
    the current behaviour.
- **GameTest neighbours.** The default batch places test structures 5 blocks apart (columns) and 6 apart (rows),
  while reflexes and jobs reach further: ShareFood 16 blocks, Pickup 6, block scans 24 (`craft`, `smelt`) and 48
  (`goto` places).
  `skill_craft_places_atable_for3x3` failed once on another test's crafting table 16 blocks away; it now runs in the
  41×41 `wide_yard` structure (agent in the middle). Other tests that rely on "nothing of type X nearby" can still be
  disturbed; give them `wide_yard` or a batch of their own.
- **Lint is a silent no-op inside `.claude/worktrees`.** biome.json's `"!!**/.claude"` matches the worktree's own
  path, so `npm run lint` there checks 0 files and passes. The workaround is in the docs (Development, "Linting
  inside a git worktree").
  - **Fix (tested in a worktree, not committed):** anchor the pattern to the root, `"!!.claude"`. Inside a worktree
    `biome check .` then lints its 379 files, and a `.claude/` directory at the root is still never entered.

## M1 (from the M1 fix verification, 2026-10-08)
- **N1, `loading` cleared while an existing world is still opening.** `ClientSession.java:128-131`, `WorldTicker.java:31-36`. `WorldOpenFlows#openWorld` resumes asynchronously through `Util.backgroundExecutor()`, so `loading` is cleared mid-open, and a duplicate `world.open` stored as `pendingOpen` is never cleared by `markReady`.
  - **Fix:** clear `pendingOpen` in `markReady`/`markClosed` for that world, and don't clear `loading` in the tick before the timeout.
  - **Test gap:** S7 never reopens an existing live world.
  - **Doc:** API_MAP §7.2 says loads happen in one client task, which is wrong for `openWorld`.

## PC manager (from round-2 verification)
- **Monitor vs. `bootAll`.** A monitor pass can stop a container that still runs for an inactive PC just before
  `bootAll` would adopt it; `bootAll` then starts the same container again. Benign but wasteful: one restart, never
  a recreate, so the rootfs and the volumes are kept. Pinned down by
  `apps/server/test/pcs/PcManager.monitorBootAll.test.ts`.
  - **Fix:** the monitor leaves strays alone while a `bootAll` runs (a flag checked in `#checkContainers` before
    the stop), and the first test of that file then expects no restart.
- **Engine left running after a slow release.** The engine release on shutdown is capped at 20 s and left running
  on timeout. In unit tests the next start adopts an engine of ours as is (ContainerRuntime "ours: no start") and
  breaks a dead holder's `engine.lock` (EngineLeases). Not yet verified live: force the timeout under
  `npm run test:pcs` and check that the next start neither restarts nor duplicates the engine.
- **EngineLeases start-time strings.** Leases compare `ps -o lstart=` text read with `TZ=UTC`, which is
  consistent, but they keep their own copy of the logic the run lock now has (`processStartTime`,
  `sameStartTime` in `apps/server/src/orchestrator/runLock.ts`). Share one helper when either changes next.
