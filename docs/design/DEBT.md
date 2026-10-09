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
`footer` off, `mcServer.ts` `splitFooter`). Dual sessions (2026-10-09, PLAN §6.1) fixed "wandering agents carry
the 31 `pc` tools" (the body session has no `pc` server; EVALS.md "Dual sessions") and the per-turn `ai-title`
question (a fixed session `title` skips the AI title generation, verified live), and mitigated the account e-mail in
agent prompts (outbound redactor and persona rule; what is left is below).

## Found in the after-v2 tool eval (2026-10-09, docs/design/EVALS.md "After v2")
- **"Keep me safe" is still unsolved.** With v2, every `mc.dark_safe` run built a shelter from gathered dirt or
  planks (71 blocks) instead of sending Jasper into his house next door and guarding: 33 calls and ~1.2M prompt
  tokens per run (40.7 and 1.0M before); after the `033c096` fixes 22 calls and 613k, but 1/3 passed: gathering takes
  two to three game hours, the zombie reached Jasper first in one run, and in another Haiku told him "you're sealed
  in" a shelter he never entered. The eval cannot show W1's scene: `eval/sim/observe.ts` has no `Scene.java`
  text, so `observe{scene}` renders the house as `logs ×77 nearest 7m SE` with no owner, and the trees without
  reachability. **Fix:** port `Scene.lookAround`'s lines (zone, trees, buildings with owners, people) into the
  simulated mod so the eval measures W1's perception, then re-run dark_safe; if Haiku still builds, give the night
  case a composite or a hint (`set_mode guard` + "tell the player to get inside").
- **`do` with one step fails input validation.** The schema requires 2-8 steps; Haiku sent
  `do{steps:[{tool:"goto",...}]}` once and got an MCP `too_small` error. Accept one step (run it as that tool).
- **The NEEDS_TOOL hint suggests a craft that cannot work.** It says `craft{"item":"wooden_pickaxe"}`; with no wood
  carried that fails `MISSING_INGREDIENTS` (dark_safe run 3). With `craft.tree` it should say
  `craft{"item":"wooden_pickaxe","gather_missing":true}`.
- **Two turns per long composite.** `gather`/`craft`/`do` answer `running` after 20 s and the agent ends its turn,
  so the incident and the iron task take a second (cheap, one round trip) turn for the `[JOB DONE]` report: 2 turns
  per run against 1.7-2.3 before. By design (tools-v2-mc.md §7); a longer first wait would trade turns for latency.
- **The v1/v2 split of the gain is unmeasured.** The after-v2 run used the v2 tools on the simulated W1 + v2 mod;
  a `--tools v1 --mod v2` run would show how much of the gain is W1's protection alone. Production still defaults to
  v1 (`MINEVIBE_MC_TOOLS`); the §14 flip gates call for N=5 runs per scenario and `eval:world -- --tools v2`.

## Found in the mode-profiles work (2026-10-09)
- **`runLock.test.ts` "never shows a reader an empty or partial lock" times out (5 s) under a full `npm test`** on a
  busy machine (4 of 6 full runs here); it passes alone.

## Found in the dual-sessions work (2026-10-09)
- **The account e-mail still reaches every agent prompt.** Claude Code 2.1.293 injects it as a `session_context`
  attachment in every session and has no supported switch (only `ANTHROPIC_UNIX_SOCKET`, which reroutes the transport,
  leaves it out; checked in the CLI source). Mitigated, not removed: the personas forbid repeating account identifiers
  and `agents/redact.ts` redacts the e-mail and organisation name from everything agent-authored that leaves a session
  (PLAN §6.1). Gaps: (1) the match is literal, so an obfuscated form ("jasper dot …", spaces) passes; (2) typing and
  the clipboard inside a PC are out of scope; (3) question and plan cards are not redacted (only the player sees them,
  and an answer is keyed by the question's exact text); (4) in API-key mode `accountInfo()` reports no e-mail, while a
  stored OAuth login may still put one into `session_context`: the redactor then knows nothing; (5) the organisation
  *id* (`credential_org`) never reaches the model's prompt (it renders to nothing) but sits in the on-disk transcripts
  under `~/.claude/projects/`, and Node never learns it. Fix when Claude Code offers a switch; otherwise consider a
  generic e-mail pattern for agent text.
- **Claude Code's `[Image: source: …]` notes are only handled by a persona line.** The CLI saves every image an MCP
  tool returns on the host (`mcp-pc-blob-….png`) and adds the note to the result. `CLAUDE_CODE_SKIP_PROMPT_HISTORY`
  appears to skip that persistence (CLI source: `persistence_off`), which would also drop the note and the host copies
  of PC screenshots; its other effects (prompt history, transcripts) are unverified, so it is not set.
- **The KICKOFF repeats itself on resumed desks.** Every sit sends memory.md (up to 8 KB), the Codex digest, the notes
  and the PC primer, also to a desk session that already has them in its transcript (≈1-3k tokens per sit). A resumed
  desk could get only what changed since its last sit.
- **A resumed desk session grows without bound.** It keeps its whole transcript within the 6 h TTL; Claude Code's own
  auto-compaction is the only limit. A desk that crossed the TTL starts fresh and keeps only what the handoff carries.
- **Plan-first toggled during a desk's life** changes its built-ins (ExitPlanMode) on resume through Claude Code's
  in-message tool delta (S3b's M3 mechanism); not verified live for ExitPlanMode.
- **Two claude processes per seated agent.** The body session stays open (idle) while its desk works: with the crew cap
  of 4 and `maxSeated=2` up to 6 `claude` processes. Closing an idle body while seated (and resuming it at the
  handoff back) would save memory at the cost of ~1 s per stand.
- **Only one live sample of the handoffs** (EVALS.md "Dual sessions": 4 turns); the tool evals were not re-run live
  after the switch (their replays pass). `test/live/brain.live.ts` was rewritten for dual sessions but not re-run.

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
