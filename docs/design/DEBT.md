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
"Navigation v2"). The gathering polish of 2026-10-09 (ACCEPTANCE.md, "Gathering polish") fixed the high logs of tall
trees left standing (a climb beside or in the trunk, with dirt dug nearby), one missed log giving up the rest of a
tree, a felled big tree's drops left in its crown, `mine` / `collect` searching 24 blocks where `find` searched 32, and
a cliff-side office porch with no stairs down.

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
- **An agent in a water pocket under the ground drowns.** In an intermediate build of the polish the CEO followed a
  drop into an enclosed water pocket under seed `3207449953`'s oak (ACCEPTANCE.md, "Gathering polish"): Tier 2 planned
  its way out by breaking the grass ceiling while swimming, every break timed out (`break_timeout`: mining under
  water and off the ground is 25 times slower), and the Hazard reflex cannot surface under a solid ceiling; the job
  resumed after each reflex until the agent drowned. The felling no longer opens such pockets (dirt is dug one block
  deep on solid ground) and its sweep fetches no drop under the ground or in roofed water, but any walk can still
  swim into one. **Fix:** Tier 2 should treat water with no air within reach above as a hazard to enter, and plan
  a way out with breaks only from a standing cell; the Hazard reflex could cancel a job that keeps swimming back in.
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
- **Wandering agents carry the 31 `pc` tools.** Both MCP servers are attached to every session, so a wandering Haiku
  pays for the PC tools V2 list (31 tools, 19,558 chars, ~4.9k tokens; it was 20 tools, 8,751 chars) on every round
  trip although the gate denies them all until it sits. That ate most of the mc v2 saving: about 24k prompt tokens
  per Haiku round trip after v2 against 26k before, where the mc list alone shrank by ~4k tokens. One dark_safe run
  even called `mcp__pc__wait` while standing in a field. **Fix:** attach the `pc` server only while seated (the SDK's
  dynamic MCP server update at sit / stand, if it keeps the cache prefix stable enough), or defer the pc tools behind
  tool search for wandering sessions once tool search is verified on Haiku 5.5 (tools-v2-mc.md §16.8).
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
- **The player's e-mail address reaches every agent prompt.** With the allowlisted env and `settingSources: []`, the
  CLI still injects `session_context` (the account's e-mail address) and `credential_org` (the organisation id)
  attachments into agent sessions (spike S3b, `spikes/s3b-mode-switch/result.md`, "Side effects"). Agents can read and
  repeat them. Source not investigated (presumably the CLI's account profile); decide whether an env switch or a
  persona rule is needed (PLAN §6.1 env).
- **Per-turn `ai-title` generation in persisted sessions.** S3b saw an `ai-title` transcript entry after every turn
  (`persistSession: true`), probably a small background model call per turn that no usage number counts.
- **`runLock.test.ts` "never shows a reader an empty or partial lock" times out (5 s) under a full `npm test`** on a
  busy machine (4 of 6 full runs here); it passes alone.

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
