# Known debt

These are verified issues, deferred to a cleanup sweep so they don't block milestone work. Each one names its
source. Fixed items are removed (the git history keeps them); the I4 sweep of 2026-10-08 fixed M1 N2 (run-lock
empty-file window, time-zone-dependent start times), M1 N3 (dead save left unburied after a crash), the "Node's
seed" PLAN wording, the `world.state` office slot kind (`pc` vs `workstation`), the flaky `devServer` and
`approach` tests and the flaky `skill_craft_places_atable_for3x3` GameTest.

## Found in the I4 sweep (2026-10-08)
- **Agent ids: Node mints ids the mod refuses (blocks spawning; not low severity).** `AgentManager#newRecord`
  (`apps/server/src/agents/AgentManager.ts:548`) mints `${handle}-${6 hex}`: a hyphen, and up to 19 characters. The
  mod names each body's fake player after its id and accepts only `[a-z][a-z0-9_]{0,15}`
  (`AgentService.ID`, `SkillService.AGENT_ID`), so every `agent.spawn` Node sends for such an id is answered
  `BAD_ARGS`, and with no body, every `skill.run` and `obs.query` for it `UNKNOWN_AGENT`. The protocol's `AgentId`
  allows both. Documented in protocol.md §7.4.2.
  - **Fix (pick one):** Node mints ids inside the mod's rule (for example `${handle}${4 hex}`, at most 16), and the
    protocol's `AgentId` narrows to match; or the mod accepts any `AgentId` and derives the fake player's name and
    UUID from it separately.
  - **Test gap:** no test sends a Node-minted id through the mod's validation.
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
