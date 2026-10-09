# Known debt

These are verified issues, deferred to a cleanup sweep so they don't block milestone work. Each one names its
source. Fixed items are removed (the git history keeps them); the I4 sweep of 2026-10-08 fixed M1 N2 (run-lock
empty-file window, time-zone-dependent start times), M1 N3 (dead save left unburied after a crash), the "Node's
seed" PLAN wording, the `world.state` office slot kind (`pc` vs `workstation`), the flaky `devServer` and
`approach` tests and the flaky `skill_craft_places_atable_for3x3` GameTest. The live acceptance run of 2026-10-09
(docs/design/ACCEPTANCE.md) fixed the I4 agent-id blocker (Node now mints `<handle><4 hex>`), the blank head icon
during a new agent's first turn, speech bubbles that dropped text before a dotted token, agents mining the starter
office, and a game that never left BootScreen when its window started hidden. The D2 sweep of 2026-10-09 fixed the
missing `/mnt/codex` in PCs, the mod's `ok` replies dropping nested nulls, plan cards without a plan, throwaway homes
leaking PC instances (`npm run doctor -- --clean-orphans`, and the E2E harness removes its own instance on exit), the
lint no-op inside worktrees, the monitor stopping strays while `bootAll` runs, and a `devServer` contract test that
booted a real linux-1 from `npm test`; the doubled status footer had already been fixed (Node splits the mod's
`footer` off, `mcServer.ts` `splitFooter`). Track P1 of 2026-10-09 (tools-v2-mc.md §16.10) made v2 the default and
fixed the after-v2 leftovers: a one-step `do`, the NEEDS_TOOL hint, the `[Image: source: …]` host paths, consent for
`use_block` / `menu_click` and for the refused step of Node's `do` macro, and the eval sim's missing W1 scene and
shapes (also in `worldEval.ts`).

## Found in the after-v2 tool eval (2026-10-09, docs/design/EVALS.md "After v2")
- **Wandering agents carry the 31 `pc` tools.** Both MCP servers are attached to every session, so a wandering Haiku
  pays for the PC tools V2 list (31 tools, 19,558 chars, ~4.9k tokens; it was 20 tools, 8,751 chars) on every round
  trip although the gate denies them all until it sits. That ate most of the mc v2 saving: about 24k prompt tokens
  per Haiku round trip after v2 against 26k before, where the mc list alone shrank by ~4k tokens. One dark_safe run
  even called `mcp__pc__wait` while standing in a field. **Fix:** attach the `pc` server only while seated (the SDK's
  dynamic MCP server update at sit / stand, if it keeps the cache prefix stable enough), or defer the pc tools behind
  tool search for wandering sessions once tool search is verified on Haiku 5.5 (tools-v2-mc.md §16.8).
- **"Keep me safe" is unmeasured since the fixes.** With v2, every `mc.dark_safe` run built a shelter from gathered
  dirt or planks (71 blocks) instead of sending Jasper into his house next door and guarding (1/3 after `033c096`;
  in one run Haiku told him "you're sealed in" a shelter he never entered). P1 ported W1's scene into the sim (the
  house is now `Base … ; Jasper's build`, the People line says whether he is `under cover`), and the primer, tool
  texts and hints now prefer the shelter that stands and say to check he went in (EVALS.md "After-v2 polish").
  **Next:** a live `eval:tools -- --suite mc --scenario mc.dark_safe --mode live --runs 3`; if Haiku still builds,
  give the night case a composite (`set_mode guard` + "ask the player inside" as one call).
- **Two turns per long composite.** `gather`/`craft`/`do` answer `running` after 20 s and the agent ends its turn,
  so the incident and the iron task take a second (cheap, one round trip) turn for the `[JOB DONE]` report: 2 turns
  per run against 1.7-2.3 before. By design (tools-v2-mc.md §7); a longer first wait would trade turns for latency.
- **The v1/v2 split of the gain is unmeasured.** The after-v2 run used the v2 tools on the simulated W1 + v2 mod;
  a `--tools v1 --mod v2` run would show how much of the gain is W1's protection alone. Production defaults to v2
  since P1, on the after-v2 eval rather than the §14 gates (N=5 runs per scenario and `eval:world`), which are still
  to run.

## Found in track P1 (2026-10-09, tools-v2-mc.md §16.10)
- **Claude Code names its working directory, a host path.** The preset system prompt's environment section has the
  agent's home on the host; `excludeDynamicSections` only moves it into the first user message. A seated agent could
  `cd` there in the PC. The seated primer's `HOST_PATHS_RULE` tells it not to; nothing removes the path.
- **The persona and the gate still fall back to v1.** `personaPrompt` without `mcTools` and a `GateContext` without
  `mcTools` assume v1 (`?? 'v1'`), while the process default is v2. Every production caller passes the session's set,
  so only tests rely on it; a caller that forgets gets v1 texts or a v1 gate for v2 tools. Make the field required.
- **A one-step `do` is gated as a world tool.** `do{steps:[{tool:"craft",args:{plan:true}}]}` runs as `craft{plan}`
  (a read) but the gate decides by tool name, so a seated agent is denied what `craft{plan}` alone would be allowed.
- **The People line's cover is not covered by a GameTest.** `Scene.shelterWords` is unit-tested; the heightmap test
  and the zone lookup for a real player need a client GameTest (server GameTests have no player).
- **`runGameTest` can hang after a light-engine crash.** The first `./gradlew build` of P1 logged `ReportedException:
  Getting block state` (`MissingPaletteEntryException: Missing Palette entry for index 3`, from
  `ThreadedLevelLightEngine` on a worker thread) two seconds into the 124-test batch, then logged nothing for 20
  minutes until the server was killed; the re-run passed all 124. A race between the batch's block edits and the light
  thread, it seems. Add a GameTest timeout or a watchdog on the server thread so a crash fails the run instead.
- **The sim's craft-tree gathering makes no tools.** `craft{stone_pickaxe, gather_missing}` gathers cobblestone
  without a pickaxe in the sim (the mod's makes one): a NEEDS_TOOL replay above the wooden tier fails in the sim only.

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
    radius match what `find` reports. (Owned by the world-awareness track: natural tree targeting.)

## Found in the D2 sweep (2026-10-09)
- **PC instances from before the registry stay in the dev engine.** `doctor --clean-orphans` knows an instance's home
  only from the instance registry (`<appRoot>/minevibe-instances/`, written since this sweep), a relocated Codex
  export's owner file, or the homes of the checkout it runs in. Instances made by older builds (throwaway homes of
  earlier E2E and `npm test` runs, and of other worktrees) show as `unregistered` and are kept. When this was written
  the dev engine held eight, some of them live (another worktree's dev server, a tools-v2 probe) and one the main
  checkout's play home (`4d19177e`); `0fa3430b` is a leaked E2E run (`scripts/e2e/out/leaked-instances.txt`, which the
  harness now removes through the same code). Remove one with
  `npm run doctor -- --clean-orphans --apply --instance <id>` once you know its home is gone; the next `npm run dev` /
  `play` of a live home registers it.
- **Other branches still boot a real PC from `npm test`.** `test/contract/devServer.test.ts` ("buries a dead save on
  the next start") started its second server without `NO_CREW`, so it booted linux-1 in the shared dev engine (and
  leaked it with the temp home) and took about 13 s. Fixed here; branches cut before this keep doing it until they
  merge.
- **`~/codex` is linked at boot, not by the image.** PcManager makes the link through spacesd once a PC serves
  (`#linkCodex`), because the dev image is only rebuilt when it is missing. The image's boot hook could make it instead
  once images are versioned.
- **`runLock.test.ts` "never shows a reader an empty or partial lock" can time out under load.** Its 150
  acquire/release rounds against a busy-reading loop took over the 5 s test timeout once during a full `npm test`
  while other worktrees' sessions loaded the Mac (D2 review, 2026-10-09); alone it takes under 1 s. Give it its
  own timeout or fewer rounds.
- **A Vault folder at `/mnt` would sit over `/mnt/codex`.** Vault mounts are path-identical in the guest, and nothing
  refuses a host folder that is, contains or lies inside `/mnt/codex`. It cannot happen on macOS (no `/mnt`); a Linux
  host with the Docker driver could mount one. Refuse such folders in `Vault.ts` when that driver matters.
- **The first boot after this sweep recreates linux-1.** A container from before the Codex mount no longer matches its
  record (one bind short), so the next start recreates it: `/home/cua` and the Vault are kept, changes elsewhere in the
  root filesystem are reset, as for any recreate (resize, mounts).

## Found in the I4 sweep (2026-10-08)
- **GameTest neighbours.** The default batch places test structures 5 blocks apart (columns) and 6 apart (rows),
  while reflexes and jobs reach further: ShareFood 16 blocks, Pickup 6, block scans 24 (`craft`, `smelt`) and 48
  (`goto` places).
  `skill_craft_places_atable_for3x3` failed once on another test's crafting table 16 blocks away; it now runs in the
  41×41 `wide_yard` structure (agent in the middle). Other tests that rely on "nothing of type X nearby" can still be
  disturbed; give them `wide_yard` or a batch of their own.

## M1 (from the M1 fix verification, 2026-10-08)
- **N1, `loading` cleared while an existing world is still opening.** `ClientSession.java:128-131`, `WorldTicker.java:31-36`. `WorldOpenFlows#openWorld` resumes asynchronously through `Util.backgroundExecutor()`, so `loading` is cleared mid-open, and a duplicate `world.open` stored as `pendingOpen` is never cleared by `markReady`.
  - **Fix:** clear `pendingOpen` in `markReady`/`markClosed` for that world, and don't clear `loading` in the tick before the timeout.
  - **Test gap:** S7 never reopens an existing live world.
  - **Doc:** API_MAP §7.2 says loads happen in one client task, which is wrong for `openWorld`.

## PC manager (from round-2 verification)
- **Engine left running after a slow release.** The engine release on shutdown is capped at 20 s and left running
  on timeout. In unit tests the next start adopts an engine of ours as is (ContainerRuntime "ours: no start") and
  breaks a dead holder's `engine.lock` (EngineLeases). Not yet verified live: force the timeout under
  `npm run test:pcs` and check that the next start neither restarts nor duplicates the engine.
- **EngineLeases start-time strings.** The run lock's start-time helpers now live in `apps/server/src/util/processes.ts`
  (`processStartTime`, `sameStartTime`, `pidExists`), shared with the PC instance registry. EngineLeases still keeps
  its own copy: its lease files hold raw `ps -o lstart=` text read with `TZ=UTC`, which `sameStartTime` would read as
  local time, so switching it needs a lease format change that old leases of running processes survive.
