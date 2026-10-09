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
The gathering polish of 2026-10-09 (ACCEPTANCE.md, "Gathering polish") fixed the high logs of tall
trees left standing (a climb beside or in the trunk, with dirt dug nearby), one missed log giving up the rest of a
tree, a felled big tree's drops left in its crown, `mine` / `collect` searching 24 blocks where `find` searched 32, and
a cliff-side office porch with no stairs down. Water navigation (2026-10-09, PLAN §7.2 "Water" and §7.3) fixed "an agent
in a water pocket under the ground drowns" and the live report behind it (the CEO silent in a cave pool whose ledge
stood a block over the water, brains 0/3): water exits in both tiers, no digging while swimming, the WaterEscape
reflex, `STUCK_IN_WATER`, and stuck agents speaking up; also a GameTest's office (`OfficeService.overrideLayout`) that
was saved into the GameTest world, which is kept from run to run, so every later player stand-in was welcomed into it.

## Found by navigation v2 (2026-10-09)
- **Bridges, and pillars outside tree felling, stay in the world.** Felling a tree, the miner clears the pillars
  Tier 2 built; any other walk leaves its scaffold (noted, so agents may break it again later).
- **Found in the navigation v2 review (fixed meanwhile: crew builds broken to make way, an earlier walk's pillar
  cleared by a later felling job, drops taken after their landing went, scaffold planned into a torch's cell, mid-fall
  re-plans, the office stairs flooding).** Still open:
  - Tier 2 pillars and bridges with any dirt, cobblestone or plain stone in the bag, the material a `build` job was
    given included (its `toBlock` walks fall back to Tier 2), and may put scaffold on top of a player's build outside
    a zone (W1 lets agents place there); that scaffold stays unless a felling job built it.
  - Water is fuzzy: a swim step arrives within 1.2 blocks vertically, so a goal checked by cell (a pickup, a block in
    reach) can need one more small plan after a plunge; a swim step is not re-checked if the water drained meanwhile.
  - The office stairs cut natural-looking blocks nobody placed, generated structures included (a village house's log
    corner in front of a sunk porch); planks or cobblestone end the stairs. The stairs down from a cliff-side porch
    (gathering polish) end at a fluid or at anything somebody placed, and at 12 steps: a drop deeper than that keeps
    its last part.

## Found in the gathering polish (2026-10-09)
- **Logs no climb reaches stay up.** The climb rises at most 12 blocks (health minus 8) in one of the 9 columns
  around a log, so logs more than 17 above the stump (mega spruce and jungle tops) and branch ends with no standable
  column under or beside them (`no_column`) are left (`logsLeftHigh`; 2 of 86 targets in the polish runs). Once a
  pillar block found nothing to rest on (`pillar_failed`, `NO_SUPPORT`, seed `3207449953`, a column beside a
  branch); not reproduced, and the climb then gives that log up rather than retry.
- **A climb knocked off its column leaves its pillar when no walk reaches its top.** A mob's hit or a reflex that
  moves the agent ends the climb (`off_column`); since the review, the log gets a new climb beside the old pillar and
  the cleanup reaches the old top from a short Tier-2 pillar (cleared after it). A top higher than a Tier-2 pillar
  reaches (about 8 above the ground) leaves the whole column standing (`pillar_left`; noted as scaffold, so
  navigation may break it later).
- **The ground around a felled tree comes back as dirt, not grass** (grass spreads back over time), and a hole whose
  refill times out or whose dirt was lost stays open (`hole_left` with `MINEVIBE_NAV_DEBUG=1`; 1 of 10 holes in the
  final polish runs).
- **The sweep fetches logs and the sapling to plant, nothing else.** Sticks, apples and other saplings are left to
  the Pickup reflex (6 blocks, in sight). A log in the crown higher than a Tier-2 walk to the leaf under it reaches,
  or lying where no pickup box reaches (`not_picked_up`), stays: 3 of 84 logs in the final polish runs (another
  agent standing by took 2 more).
- **Whole trees take long.** W1 finishes the tree it is felling, high logs included now, by hand when no axe is
  carried: `collect 10` took 142 s on `minevibe-e2e` (a 22-log oak) and 190 s on `3207449953` (29 logs). For trees
  far over the count, consider stopping at the count and leaving the tree standing, or crafting an axe first.
- **Search radii differ by layer.** The mod's `mine` / `collect` default is 32 now (as `find`'s); Node's v2 `gather`
  and the craft tree pass 48, and Node's own guard for mods without provenance assumes their default of 24 (right
  for those mods).
- **Two approach GameTests flake on the time of day.** `reflex_approaches_the_player` and
  `seated_agent_with_afar_player_walks_over_and_returns` failed once each in 11 full runs here (their code is not
  touched): on its first tick the agent reported `approach_blocked(night)` although its batch's environment sets the
  clock to noon, and the Approach reflex stays put once blocked. Not run down; the likely cause is that
  `Goals.nightOutside` reads `isDarkOutside()`, whose sky darkness only follows a clock change on the next tick, while
  the test world's saved clock (it keeps running from run to run) can stand at night when the batch starts. **Fix:**
  read the clock in `nightOutside`, or let the tests wait a tick before the approach.

## Found in water navigation (2026-10-09)
- **With nothing in the bag, deep water with high banks strands the agent.** No block is broken while swimming, so
  water deeper than one block whose banks all stand over the water line, with no block to step on, has no way out the
  agent finds: it treads water at the surface, says so once (urgency 2, "I'm stuck in water — can you help or should I
  dig out?"), looks again every 15 s, and waits for help (a block handed over, a step built) or for its brain. Digging a
  block from the wall while swimming to have one (25 times slower) is left out on purpose.
- **Tier 1 cuts only partial paths that end in water.** A path that reaches its goal through water climbs out where
  vanilla's evaluator says it can (a bank level with the water line), so it has an exit; but a dry spot inside an
  enclosed pocket reached through water (a ledge in a cave lake) is not seen as a dead end, and a complete path whose
  exit the water would not lift the body onto (a thin layer of flowing water) still leads in. The WaterEscape reflex
  gets the agent out; without a job, 3 escapes in 3 minutes are said out loud.
- **A stuck walk wakes the brain at most every 2 minutes.** `nav.loop` (5 failed walks from about the same spot to
  about the same goal) is an urgency-2 `stuck` event: following a player who stands where no walk leads (a roof, a
  pillar, a boat) now costs one brain turn per 2 minutes (`BodyEvents` cooldown) besides the bark. Watch the token
  use in play; a longer cooldown for repeats of the same loop would cut it.
- **The current is compensated for the water the body touches now.** A body swimming into faster water a block ahead
  drifts until it gets there; `water_crosses_flowing_river` measured 0.01 blocks off its line (0.34 without the
  upstream aim) in a stream one deep. Strong currents in deep, wide rivers are not tested.

## Found in the gathering polish review (2026-10-09)
Fixed in the review (ACCEPTANCE.md, "Gathering polish", review): an agent left on its pillar by a cancelled, timed out
or failed job (no walk comes down: Tier 1 drops 3 blocks, Tier 2 never digs straight down) now comes down by the
PillarDown reflex; the climb's fall limit followed the health only when planned (now while climbing), and was measured
from whatever the agent stood on (leaves too); cobblestone scaffold was mined back by hand (lost, 10 s a block); a
full bag dug every dirt block around (the drop stayed on the ground, each hole open); a knocked-off climb gave its log
up, planned the next climb on top of the old pillar, and the cleanup mined the Tier-2 block under its own feet.
Still open:
- **A stranded agent at low health cannot flee.** On a pillar with no job, Flee (85) wins over PillarDown (41) once
  HP is 6 or less and a hostile is near, and Flee's walk finds no way off (Tier 1). Mid-climb the job is preempted
  the same way before its own retreat (8 HP) runs. **Fix:** let PillarDown (or Flee) come down a remembered pillar
  first when stranded.
- **PillarDown knows only scaffold remembered in memory.** `NavBlocks`' scaffold set is not saved: after a restart an
  agent stranded on its pillar stays up there.
- **A cancelled felling leaves its holes open.** Filling the holes dug for scaffold is a chore of the job; cancelled,
  the dirt stays in the bag and the holes in the ground.
- **The miner still clears other walks' cobblestone pillars by hand** when it has no pickaxe (Tier 2 now places dirt
  first, but uses cobblestone when that is all it carries): that cobblestone is lost.
- **`nav_fells_big_spruce_keeping_the_drops` left one hole open once** in seven runs during the review (the first,
  before the sweep fetched dirt; not reproduced with `MINEVIBE_NAV_DEBUG=1`): a refill that timed out, or a pillar
  block's dirt that bounced away. The sweep now fetches dirt while holes wait; watch this test.

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
  thread, it seems. Add a GameTest timeout or a watchdog on the server thread so a crash fails the run instead. Seen
  again in the water navigation work (1 of 5 full runs, 174 tests): the server thread waited for a chunk in
  `StructureGridSpawner` (`TestInstanceBlockEntity.forceLoadChunks`) for 10 minutes; the re-run passed.
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
