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
`footer` off, `mcServer.ts` `splitFooter`). Navigation v2 (2026-10-09, Tier 2 in PLAN §7.2) fixed
"visible oak is unreachable on most seeds": on seeds 42 and minevibe-e2e the starter office was sunk into a hillside
with its porch opening into the ground (`OfficeBuilder` now cuts stairs up from the porch), and canopy logs, ledges,
gaps and drops in leaves were out of reach on foot (Tier 2 digs, pillars and bridges its way there; ACCEPTANCE.md,
"Navigation v2"). Track P1 of 2026-10-09 (tools-v2-mc.md §16.10) made v2 the default and
fixed the after-v2 leftovers: a one-step `do`, the NEEDS_TOOL hint, the `[Image: source: …]` host paths, consent for
`use_block` / `menu_click` and for the refused step of Node's `do` macro, and the eval sim's missing W1 scene and
shapes (also in `worldEval.ts`). The v2 confirmation of 2026-10-09 (EVALS.md "Confirmation of v2") measured "keep me
safe" after those fixes (the agents now use the house) and scores `eval:world`'s v2 runs on the outcome.
Dual sessions (2026-10-09, PLAN §6.1) fixed "wandering agents carry the 31 `pc` tools" (the body
session has no `pc` server; EVALS.md "Dual sessions") and the per-turn `ai-title` question (a fixed session `title`
skips the AI title generation, verified live), and mitigated the account e-mail in agent prompts (outbound redactor
and persona rule; what is left is below). The live dual-sessions check (2026-10-09, ACCEPTANCE.md "Dual sessions,
live") fixed a `(silent)` reply showing in the player's chat log and the body repeating what its desk had just said.

## Found by navigation v2 (2026-10-09)
- **High logs of a felled tree stay up.** Felling a tree whole (W1), the miner gives up on logs that neither a Tier-2
  pillar (3 blocks, 2 at low health, so the agent can always get down without digging under itself) nor its own
  (2 blocks) reaches: 30 of 117 targets in the zero-token runs on `b7c347f`, 14 of 94 on `5f7e72d`, most in the
  spruce of seed `217793310` (ACCEPTANCE.md, "Navigation v2"). After the arrival fix of the nav v2 scripted runs
  (`4a9acd1`) it is 22 of 162 on nine seeds, 16 of them in one 29-log oak on seed `3207449953` (ACCEPTANCE.md, "Nav v2
  scripted runs"; before that fix, arrivals short of hand reach were booked as high logs too). Each costs a Tier-2
  search that runs out (20 000 nodes, 70-110 ticks at 1.5 ms).
  - **Fix:** a dedicated "log straight above, beside its trunk" plan (pillar beside the trunk up to the log, clear it
    on the way down), and skip the search for logs above the pillar limit outright.
- **Bridges, and pillars outside tree felling, stay in the world.** Felling a tree, the miner clears the pillars
  Tier 2 built; any other walk leaves its scaffold (noted, so agents may break it again later).
- **The office's floor still follows the median of 9 terrain samples.** Its exit stairs fix the buried porch, but a
  porch high above the ground in front (a cliff side) gets no stairs down; a drop over 3 blocks there hurts the player.
- **Found in the navigation v2 review (fixed meanwhile: crew builds broken to make way, an earlier walk's pillar
  cleared by a later felling job, drops taken after their landing went, scaffold planned into a torch's cell, mid-fall
  re-plans, the office stairs flooding).** Still open:
  - Tier 2 pillars and bridges with any dirt, cobblestone or plain stone in the bag, the material a `build` job was
    given included (its `toBlock` walks fall back to Tier 2), and may put scaffold on top of a player's build outside
    a zone (W1 lets agents place there); that scaffold stays unless a felling job built it.
  - Water is fuzzy: a swim step arrives within 1.2 blocks vertically, so a goal checked by cell (a pickup, a block in
    reach) can need one more small plan after a plunge; a swim step is not re-checked if the water drained meanwhile.
  - The office stairs cut natural-looking blocks nobody placed, generated structures included (a village house's log
    corner in front of a sunk porch); planks or cobblestone end the stairs.
- **`mine` and `collect` search 24 blocks by default, `find` 32.** An agent that `find`s oak at 28 blocks and then
  `collect`s without `radius` gets `NOT_FOUND` (seed `mv-forest-1`, nearest oak 27.9 from the office). The scripted
  step 3 passes `radius: 48`. Fix: one default for both (W1 owns tree targeting).

## Found in the nav v2 scripted runs (2026-10-09, ACCEPTANCE.md "Nav v2 scripted runs")
- **One missed log sends the miner climbing for the rest of the tree.** When a walk to a log above the feet fails,
  for whatever reason, `Miner` sets `climbing`, and every later log of that tree goes straight to `climbToward`
  without a walk. With no dirt in the bag, each is booked `logsLeftHigh` and skipped. On seed `1350113924` a walk that
  arrived short of a bank tree's base log gave up all six logs, though all were in reach from the bank's foot. The
  short arrival is fixed (`4a9acd1`), but the latch stays: a base log on a ledge that no walk reaches still gives up
  the whole tree. **Fix:** climb only for logs above the lowest log still standing, and clear `climbing` once a
  walk to a log of the tree arrives.
- **A felled big tree leaves most of its drops in the canopy.** After a tree, `collect` picks up drops within 5 blocks
  of the stump for 100 ticks (`TREE_COLLECT_TICKS`). On seed `2368183124` it finished a 24-log oak whole (W1 finishes
  the tree it is felling): 36 logs mined, 15 kept, and `collect 10` took 165 s. **Fix:** pick up a broken log's drop
  when it lands within reach of the walk, or look for drops around each felled log, not only the stump. For trees
  far over the count, consider stopping at the count and leaving the tree standing.

## Found in the after-v2 tool eval (2026-10-09, docs/design/EVALS.md "After v2")
- **Two turns per long composite.** `gather`/`craft`/`do` answer `running` after 20 s and the agent ends its turn,
  so the incident and the iron task take a second (cheap, one round trip) turn for the `[JOB DONE]` report: 2 turns
  per run against 1.7-2.3 before (10 of 10 in the v2 confirmation). By design (tools-v2-mc.md §7); a longer first
  wait would trade turns for latency.
- **The v1/v2 split of the gain is unmeasured.** The after-v2 and confirmation runs used the v2 tools on the
  simulated W1 + v2 mod; a `--tools v1 --mod v2` run would show how much of the gain is W1's protection alone. The
  N=5 confirmation (mc 24/25, pc 6/6, `eval:world` 3/3 on the outcome) meets the §14 gates it covers (S1 ≤ 3 calls,
  S2 asks 5/5, no PC regression, no `BAD_ARGS`), but has no v1 control on the same harness and no S4 / S5 as
  written.

## Found in the v2 confirmation (2026-10-09, docs/design/EVALS.md "Confirmation of v2")
- **`goto` knows no `base`.** The scene and the primer call the house `Base (Jasper's base) 4m SE` and say to bring
  the player into it, but `goto{to:"base"}` fails `UNKNOWN_PLACE` (Node's `resolveTarget`; the mod's `Places` has
  none either), and `office` / `home` mean the agent's own home spot, not the Base. In `mc.dark_safe` Haiku spent most
  of its 14-35 calls finding the way in: `goto office`, `goto home`, `goto Base` (2 runs), `codex` searches, `find`
  bed / chest / crafting_table, then walking to the bed. **Fix:** let `goto` take `base` (and the zone's name) to the
  Base's entrance or the nearest walkable cell inside it, in `targets.ts` and `Places.java`, or have the scene name
  the entrance's position.
- **The eval's player does not understand "into the Base".** `SHELTER_WORDS` (`eval/scenarios/mc.ts`) knows inside,
  indoors, into the / your house, home, shelter and cover, so "let's go into the Base", "come into the Base" and "go
  in" leave Jasper outside: dark_safe #3 failed on it (it then told him the truth, that he was still in the open) and
  #5 took 35 calls and the round-trip cap. The vocabulary predates P1 naming the house "Base". Add `(the|your) base`
  and a bare "go / come in" (keeping the negation and first-person rules), then re-run dark_safe; until then its
  success rate understates the agent.
- **`find door` finds nothing next to a door.** In the sim `find{target:"door"}` answered `none` with the house's oak
  door 6-8 m away (a bare `door` is no block id). Check what the mod answers; map family names (door, bed, log) to their
  tag, or say that the name is not a block id.

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
- **`eval:world` runs the v2 tools against a fake mod without the v2 caps.** `EvalWorldSkills` has W1's shapes but
  an empty `hello.caps`, so with v2 (now its default) `craft` has no recipe tree (`MISSING_INGREDIENTS` for the table,
  then planks by hand, in every v2 reachable and legacy run so far) and `do` is Node's macro. Give the W1 scenarios
  the v2 caps (and the fake the craft tree and `sequence`; `GATHER` in `scoreScenario` then needs `sequence` steps).
  The scoring half is done: since the v2 confirmation, v2 is scored on the outcome and looking first is a note.
- **The sim's craft-tree gathering makes no tools.** `craft{stone_pickaxe, gather_missing}` gathers cobblestone
  without a pickaxe in the sim (the mod's makes one): a NEEDS_TOOL replay above the wooden tier fails in the sim only.

## Found in the mode-profiles work (2026-10-09)
- **`runLock.test.ts` "never shows a reader an empty or partial lock" times out (5 s) under a full `npm test`** on a
  busy machine (4 of 6 full runs here); it passes alone.

## Found in the dual-sessions work (2026-10-09)
- **The account e-mail still reaches every agent prompt.** Claude Code 2.1.293 injects it as a `session_context`
  attachment in every session and has no supported switch (only `ANTHROPIC_UNIX_SOCKET`, which reroutes the transport,
  leaves it out; checked in the CLI source). Mitigated, not removed: the personas forbid repeating account identifiers
  and `agents/redact.ts` redacts the e-mail and organisation name from everything agent-authored that leaves a session
  (PLAN §6.1). Gaps: (1) the match is literal, so an obfuscated form ("jasper dot …", spaces) passes; (2) typing and
  the clipboard inside a PC are out of scope; (3) the redactor learns the account from the first session's startup
  check (`accountInfo()`, milliseconds after its init), so text streamed before that is not redacted; (4) in API-key mode `accountInfo()` reports no e-mail, while a
  stored OAuth login may still put one into `session_context`: the redactor then knows nothing; (5) the organisation
  *id* (`credential_org`) never reaches the model's prompt (it renders to nothing) but sits in the on-disk transcripts
  under `~/.claude/projects/`, and Node never learns it. Fix when Claude Code offers a switch; otherwise consider a
  generic e-mail pattern for agent text.
- **Claude Code's `[Image: source: …]` notes are only handled by prompt lines.** The CLI saves every image an MCP
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
- **Context during the body's sit turn reaches only the body.** A broadcast, consent or house-rule notice that arrives
  while the body's sit turn ends (`seated_pending_handoff`) is sent to the body (as before), not kept for the desk;
  the player's lines reach the desk anyway (the KICKOFF quotes them, and wakes wait for the desk since the review).
- **A PC recreated under the same id resumes the old desk session** within the TTL: the desk record is keyed by the
  PC id only, so the desk "remembers" work on a disk that no longer exists until it looks.
- **Few live samples of the handoffs**: the live check (EVALS.md "Dual sessions": 4 turns) and the E2E check in the
  real game (ACCEPTANCE.md "Dual sessions, live": three sits, one resume, 11 turns). The tool evals were not re-run
  live after the switch (their replays pass). `test/live/brain.live.ts` was rewritten for dual sessions but not re-run.

## Found in the live dual-sessions check (2026-10-09, ACCEPTANCE.md "Dual sessions, live")
- **The body answers before its desk.** Asked "sit at linux-1 again and tell me what you did last time", the body's
  sit turn already answered from its own DESK REPORT ("Last time I ran uname -a there, got Linux 6.18.35 …"), and the
  desk said the same 3.6 s later: the player heard it twice. The body knows every DESK REPORT, so a question about PC
  work gets answered at the sit. One sample; the `sit_at_pc` result ("End your turn now; your PC session takes over
  from here.") could ask for a short line that leaves the task to the desk.

## Found in the D2 sweep (2026-10-09)
- **PC instances from before the registry stay in the dev engine.** `doctor --clean-orphans` knows an instance's home
  only from the instance registry (`<appRoot>/minevibe-instances/`, written since this sweep), a relocated Codex
  export's owner file, or the homes of the checkout it runs in. Instances made by older builds (throwaway homes of
  earlier E2E and `npm test` runs, and of other worktrees) show as `unregistered` and are kept. When this was written
  the dev engine held eight, some of them live (another worktree's dev server, a tools-v2 probe) and one the main
  checkout's play home (`4d19177e`); `0fa3430b`, a leaked E2E run listed in `scripts/e2e/out/leaked-instances.txt`, was
  removed by the harness in the nav v2 scripted runs (2026-10-09), which left 12 unregistered instances and the play
  home. Remove one with
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
