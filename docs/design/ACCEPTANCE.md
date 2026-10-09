# Live acceptance, 2026-10-09

The end-to-end scenario of PLAN §13.7 item 7, run for real on `main` after the integration tracks merged (I1a core
runtime, I1b PCs, I1c org, I2 mod wiring, I4 debt and docs, I5 packaging): `npm run play` from a temporary
`MINEVIBE_HOME`, the game launched by the launcher, linux-1 on the real Apple `container` engine, and the crew on a
real Claude subscription through the Agent SDK's bundled `claude` (`MINEVIBE_CLAUDE=bundled`; the installed CLI is
2.1.284, older than the 2.1.293 MineVibe needs).

**Result: all nine steps pass (run 2 below).** The runs before it found eight bugs, fixed on `main` with tests;
five more findings are in [DEBT.md](DEBT.md).

## How it runs

```sh
cd apps/mod && ./gradlew build && cd ../..
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --seed mv-forest-1          # live, ~6 min
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --crew scripted --seed 42   # zero tokens
```

`scripts/e2e/run-scenario.ts` calls `play()` (the code behind `npm run play`) in its own process, with
`MINEVIBE_E2E=1`, so it holds the composed runtime and drives the game through the bridge:

- the mod's E2E requests: `debug.state` (screen, world, player, and now the crew as the client draws it: bubble, head
  icon, cards, position, seated; and each PC monitor's frame count and pixel CRC32), `debug.chat` (a line typed as the
  player, through the chat interceptor), `debug.ui_request` (any request the UI sends: `agent.cmd`, `calendar.put`,
  `pending.answer`, `plan.decision`), `debug.kill_player` and `debug.click_begin`;
- `obs.query` for inventories and `skill.run` for zero-token scouting;
- the runtime's own events: each turn's model (`message.model`), each tool call's model and effort, brain swaps, PC
  status.

It approves plan cards as the player would (runs 1-4 predate the 2026-10-08 user decision, when the CEO was plan-first
by default; plan-first is now off unless the player turns it on, so a default crew raises none), stops
prompting the crew at `--max-turns`, captures screenshots of the game window only, and writes everything to
`scripts/e2e/out/<run>/` (`result.json`, `summary.md`, `events.jsonl` with every bridge message, `samples.jsonl`
with the client snapshots, `server.log`, the game's logs, screenshots). `--crew scripted` runs boot, the CEO at the
door (greeted by the harness instead of a welcome turn), a chat and UI smoke test, a seed scout (can a body mine oak
here?), step 3 by the mod's own jobs, death and quit without spending tokens.

## Results (run 2, seed `mv-forest-1`, 13 agent turns)

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Cold boot | PASS | Screens: BootScreen (TitleScreen redirected), GenericMessage, Progress, LevelLoading, in game; never TitleScreen. Hardcore, HARD, survival. Starter office with 10 slots, workstation 1 bound to `linux-1`. linux-1 `running` 6.3 s after start; world ready at 21.2 s; first monitor frame on the client at 21.5 s (640x400). |
| 2 | CEO at the door, follows | PASS | `agent.spawn{at: door (-80,70,-13), mode: follow}`, body 0 blocks from the door; 3.0 blocks from the player after the walk. Client saw head icons THINKING then NONE and the bubbles "Wake" and "Hello, Player. Ada here, ready when you are." |
| 3 | `@ceo collect 10 oak logs and make a crafting table` | PASS | 60 s, 2 turns. Inventory: 9 oak logs and 1 crafting table (one log went into planks); `craft` jobs done. Every turn `claude-haiku-5-5` (`message.model`), every tool call `xhigh`. |
| 4 | Ask flow | PASS | Question card 3.9 s after the line; `agent.approach{present}` 1 ms later; QUESTION head icon; the CEO stood 2.8 blocks from the player. `@ceo 2` cleared the card and the model answered "You picked spruce as the next tree to harvest." (options Birch, Spruce, Acacia). |
| 5 | PC flow | PASS | `sit_at_pc` on Haiku/xhigh, swap to Opus 2.8 s later at the turn boundary, plan approved, `pc__bash` on `claude-opus-5-5`/medium, ShellMirror changed the monitor 5 times (CRC 233eb36d to 688368f4), `stand_up`. Reply: "The kernel version is 6.18.35 on aarch64, but ls failed because /mnt/codex doesn't exist on linux-1." (the guest says 6.18.35). Back on Haiku 79.8 s after standing, after a needless `/compact` (fixed in `02c0ffb`; 60.0 s in run 4). |
| 6 | Kick | PASS | `sleep 600` running in the guest, then `agent.cmd kick` through the UI: reply in 74 ms, turn interrupted in 74 ms, guest processes gone in 133 ms, off the seat, back on Haiku in 133 ms. |
| 7 | Codex and calendar | PASS | `mc__codex_write` (Haiku) created "E2E acceptance", scope lasting. The player's `calendar.put` (real clock, task, due in 60 s) fired 412 ms after due; the CEO said "check-in done" and `mc__report_task` marked the occurrence done. |
| 8 | Hardcore | PASS | `debug.kill_player`: Game Over in 38 ms; Begin to World #2 in 4.3 s (4.6 s from death). The dead save is in `saves/_graveyard`. Same PCs (`linux-1`), running, bound to the new office's workstation; the lasting page "E2E acceptance" survived; a new CEO arrived and greeted. |
| 9 | Quit | PASS | The game closed (SIGTERM to the JVM): `npm run play` returned in 4.8 s. No child processes, no java, claude or node left; linux-1's VM gone; the container engine stopped (no `com.apple.container.*` jobs left). |

Run 2's SDK estimate is $0.28 (Ada's session $0.276, the World #2 CEO $0.001).

## Runs

| Run | Kind | Seed | Turns | Outcome |
| --- | --- | --- | --- | --- |
| dry 1-2 | scripted | `minevibe-e2e` | 0 | Found: `debug.state` replies failed to parse (nested nulls), screenshots captured the whole desktop. |
| live 1 | agents | `minevibe-e2e` | 9 | Steps 1, 4, 6 PASS; 2, 3, 5 FAIL; stopped after step 6 (see below). |
| dry 3-4 | scripted | `minevibe-e2e` | 0 | Found the hidden-window boot hang; checked the office fix; oak `UNREACHABLE` from a body in the office. |
| scouts | scripted | `42`, `minevibe`, `mv-forest-1` | 0 | Oak unreachable or not found on two seeds, mined on `mv-forest-1`; from the porch it stays unreachable on `42`. |
| live 2 | agents | `mv-forest-1` | 13 | **9/9 PASS.** |
| live 3-4 | agents | `mv-forest-1` | 1 + 3 | Steps 1, 2, 5 again after the downswap fix (run 3 skipped step 5 on its own `--max-turns`). Run 4: all PASS, back on Haiku 60.0 s after standing with no `/compact` (run 2: 79.8 s). |

Live run 1 failed where the product was wrong: the CEO's head icon stayed blank through its first turn (step 2); oak
was unreachable, so the CEO mined `#minecraft:logs` and took the office's corner posts (step 3; the player typed "you
are destroying my house" into the test game); the PC-flow bubble read "35 on aarch64, but..." (step 5). Two harness
bugs also failed step 5 (an empty list taken for a result, the bubble read instead of the full reply). After the kick
the CEO asked what to do next, the player picked "Retry the build" in the game, and the 10-minute `sleep` started
again, so the run was stopped there; step 9 then failed on the harness's own exit path (it left before the teardown,
fixed).

The cap was about 40 agent turns for the whole job; 26 were used (9 + 13 + 1 + 3), all short.

## Fixed on `main`

| Commit | Fix |
| --- | --- |
| `4bf7ec4` | Node minted agent ids (`ada-1a2b3c`) the mod refuses, so no CEO could spawn (the I4 blocker). Ids are now the handle plus 4 hex digits, at most 16 characters. |
| `433f0a7` | E2E plumbing: `npm run play` never passed `-Dminevibe.e2e=true`, so the game's debug handlers were off; `debug.chat`, `debug.ui_request`, the richer `debug.state`, `PlayOptions.onRuntime`, and `MINEVIBE_WORLD_SEED` for repeatable terrain. |
| `cd33459` | The harness; `debug.state`'s nested keys are nullish because the mod drops nested nulls (DEBT). |
| `7069006` | Speech bubbles dropped everything before a dotted token ("6.18.35" became "35 on aarch64..."). |
| `019ea00` | A new agent's head icon stayed blank through its first turn: the mod ignored `agent.brain` until `crew.state` named the agent. Every `crew.state` is now followed by each brain. |
| `07031b1` | Agents mined the starter office (its stripped spruce corner posts are logs). `mine` and `collect` now skip the office's blocks. |
| `02898df` | A game whose window started hidden never left BootScreen: Dynamic FPS draws 0 frames for a hidden window and the loading overlay only fades on drawn frames. The seeded config keeps 1 fps. |
| `02c0ffb` | The swap back to Haiku compacted for nothing: the context guard read the result's usage, which adds up every API call of the turn (165,948 "tokens" after a 5-call turn), and ran an extra Opus `/compact` turn (~$0.20, 20 s). It now reads the last call's usage. |
| `7f61d46`, `e14ef10`, `877905b` | Harness: plan approvals, full replies, craft jobs, running jobs, teardown before exit, own PC instances removed from the shared engine, per-turn model from `message.model`, downloads cloned with `cp -cR`. |

## Found, not fixed

In [DEBT.md](DEBT.md), "Found in the live acceptance run": no `/mnt/codex` in the PCs, the mod's `ok` replies drop
nested nulls, plan cards without a plan when the agent states its plan in prose, and throwaway homes leaking PC
instances into the shared dev engine. The visible oak that was unreachable on most seeds is fixed by navigation v2
(below).

Fixed since, in the D2 sweep (same day): PCs mount the Codex read-only at `/mnt/codex` with `~/codex` (step 5's
`ls /mnt/codex` would now list the pages); `ok` replies keep nested nulls, so `debug.state`'s per-agent and
per-monitor keys are plain `nullable` again; a plan stated in prose becomes the plan card; and
`npm run doctor -- --clean-orphans` removes the PC instances of deleted homes, which the harness now does for its own
instance on exit (replacing `out/leaked-instances.txt`). The oak item stays open.

## Limits of this run

- The player never moves (there is no movement hook), so "follows the player" is the CEO walking from the door to
  about 3 blocks from a player standing at the spawn.
- "Closing the game" is a SIGTERM to the JVM, which runs the same shutdown as a closed window; `npm run play` then
  returns 143 instead of 0.
- Live run 1 shared the Mac with a manual `npm run play` session, and the player typed into the test game twice;
  run 2 ran alone. The engine is shared by design (leases): with another MineVibe up, step 9 accepts the engine
  staying up for it, which run 2 did not need.
- The scenario's oak step depends on terrain: seed `mv-forest-1` was picked by the zero-token scout.

## Navigation v2, step 3 at zero tokens (2026-10-09)

DEBT's "visible oak is unreachable on most seeds", run down with `MINEVIBE_NAV_DEBUG=1` (terrain maps of every failed
walk in the game log) and fixed by Tier 2 of PLAN §7.2 (`DigPathPlanner`), plus exit stairs for the starter office.

**Diagnosis.** Not the trees. On seeds `42` and `minevibe-e2e` the starter office is sunk into a hillside: the floor
sits at the median of 9 terrain samples, which a lake (42) or a slope pulled down, so the ground around three sides
stands 3 to 7 blocks above the floor and the porch is a 3-high hole into the hill. No walking path leads out of the
office, from inside or from the porch; Tier 1's best partial path led back into the office toward the tree, and after
4 segments that got no closer it gave up (`no_path`). On the other seeds Tier 1 reached nearly every log it targeted
(2 given up); what it lost there were drops caught in leaves (13 to 40 per run).

**Fix.** Tier 2 digs through natural ground (grass is `#grass_blocks`, not `#dirt`, in 26.3), pillars and bridges
where no walk leads, and fetches drops from the leaves. Since W1 (merged meanwhile) protects the Base, natural ground
around the office included, agents may not dig out of a sunk office; `OfficeBuilder` now cuts stairs up from the porch
when the ground in front stands higher than a step, so the player and the crew walk out. Bugs found on the way, fixed
with tests: a job's walks share one navigator, so a walk left running for a vanished item kept digging while the job
mined elsewhere (each tick's held attack aborted the other's, and nothing ever broke); a walk that arrived next to an
item it could not pick up stood there until the item despawned (5 minutes); a block that came into reach at the top
of a pillar's jump stopped the pillar, and the body fell back out of reach and started over (a loop); and W1's tree
felling never ended a `collect` or `mine` whose count was met (it picked the next tree in the same tick the last one's
chores ended, so the job felled trees until its 6-minute timeout).

**How it runs.** `--crew scripted --steps 1,3`: step 3 then has the mod's own jobs do it, from the body's spawn next
to the player in the office: `collect` 10 logs (oak, or the nearest other log when no oak is within 48 blocks) with
`radius: 48`, then planks and a crafting table. `mine` and `collect` default to 24 blocks, so the radius is passed
(DEBT). Two baselines, because W1 landed on `main` during this work: `main` before W1 (`d747169`) and with it
(`b7c347f`), both Tier 1 only; after = this branch, on each, and once more after rebasing onto `5f7e72d` (tools v2
and mode profiles merged).

```sh
cd apps/mod && ./gradlew build && cd ../..
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --crew scripted --steps 1,3 --seed 42
```

| Seed | Log | Nearest | `d747169` | This branch on `d747169` | `b7c347f` (W1) | This branch on `b7c347f` | This branch on `5f7e72d` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `42` | oak | 11.4 | FAIL, `UNREACHABLE` in 8.9 s | PASS, 62.8 s | FAIL, `NO_NATURAL_SOURCE` | PASS, 98.1 s | PASS, 45.7 s |
| `mv-forest-1` | oak | 28.9 | PASS, 45.1 s | PASS, 43.9 s | `TIMEOUT` (87 logs) | PASS, 41.3 s | PASS, 42.1 s |
| `minevibe-e2e` | oak | 17.5 | FAIL, `UNREACHABLE` in 7.9 s | PASS, 76.7 s | FAIL, `NO_NATURAL_SOURCE` | PASS, 77.8 s | PASS, 72.9 s |
| `3037014017` | oak | 36.1 | PASS, 68.6 s | PASS, 54.8 s | `TIMEOUT` (86 logs) | PASS, 57.6 s | PASS, 58.9 s |
| `217793310` | spruce | 3.3 | PASS, 102.7 s | PASS, 62.3 s | `TIMEOUT` (57 logs) | PASS, 97.2 s | PASS, 89.9 s |
| `2921725920` | oak | 3.2 | PASS, 65.7 s | PASS, 46.2 s | `TIMEOUT` (75 logs) | PASS, 49.8 s | PASS, 41.9 s |
| **Collect done** | | | **4 of 6** | **6 of 6** | **0 of 6** | **6 of 6** | **6 of 6** |
| **Reach** | | | **40 of 60 (0.67)** | **66 of 69 (0.96)** | | **87 of 117 (0.74)** | **80 of 94 (0.85)** |
| **Drops left** | | | **99** | **0** | | **0** | **1** |

- **Reach** is mining targets reached of those tried: blocks mined against targets given up on (the job's own
  `mined` and `unreachable`; on `d747169`, a failed walk to a block's bottom centre in the game log and the logs
  collected for the mined count, so a lower bound). **Drops left** are walks to a drop that failed. With `mine`'s
  default radius of 24 only one seed passed on `d747169` (`2921725920`); the others found no oak in range.
- With W1 a tree is felled whole, bottom-up, so "given up" also counts the high logs of a felled tree that neither a
  Tier-2 pillar (3 blocks) nor W1's own reaches (`logsLeftHigh`): 30 of them on `b7c347f` and 14 on `5f7e72d`, most
  in the spruce of `217793310` and the tall oaks of `minevibe-e2e`. The job collects 10-16 logs because it finishes
  the tree it is felling. On `5f7e72d` seed `42`'s nearest oak is 19.6 blocks away, not 11.4.
- `b7c347f`'s `TIMEOUT` rows are the felling loop above (the logs were there, the job never ended); its two FAILs are
  the sunk office (the oak by the office is in the Base, the others unreachable on foot).
- Tier 2 planned 1 to 16 times per run, each search within 1.5 ms per tick (the first one on `d747169`, out of seed
  42's office by digging, 349 nodes in 10 ticks; a search that runs out, 20 000 nodes in 70-110 ticks).
- The 27 navigation GameTests (`NavGameTests`, `-Pminevibe.gametestFilter='minevibe-gametest:nav_game_tests_*'`): a
  tree on a 3-block ledge (dug stairs, or a 2-block pillar with dirt in the bag), across a 2-wide gap 4 deep (bridged),
  behind a leaf wall, on a hill with a 2-high grass step (1 block cut), across a river (swum), an office sunk in a hill
  (walked out by its stairs, office untouched), a sealed tree (`no_path`, not one block broken), a goal past 96 blocks
  (`too_far` at once), a door, a ladder, `goto` falling back to Tier 2, drops fetched from leaves, a stale walk
  stopped, a pillar not cut short at the top of its jump, `collect` stopping at its count, the safety rules (no block
  next to water, nothing under the feet, only natural blocks), and four agents planning at once (median 1.45 ms, 90th
  percentile 1.48 ms per agent tick). Six more from the review (each failed before its fix): a ring the crew built
  (planks, glass, bricks) is never broken, even under a stale scaffold note, while the agent's own scaffold is; a tree
  felled after a `goto` pillared elsewhere leaves that pillar's position (a crew build by then) alone; a drop whose
  landing is mined away while the agent walks to the edge re-plans instead of falling 6 blocks; a 9-block fall into a
  pool is no re-plan; no scaffold is planned into a torch's cell (one clean `no_path`, not 9 searches ending `stuck`);
  and the office's exit stairs seal off a pond beside them and sand above them.

## Nav v2 scripted runs (2026-10-09)

The zero-token acceptance run on `main` right after navigation v2 merged (`0098139`, with its review fixes): steps 1
to 3, 8 and 9 with `--crew scripted` on the three usual seeds and three new random ones, then all six again after the
two fixes below (`4a9acd1`, `3b52313`). Step 3 is the mod's own `collect` of 10 logs with `radius: 48`, as in the
section above. As a regression check, the three random seeds of that section's table ran steps 1 and 3 before and
after the fix.

```sh
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --crew scripted --steps 1,2,3,8 --seed 1350113924
```

**Result: with the fixes, all six seeds pass all five steps.** On `0098139`, step 2 failed on all six (a harness gap)
and step 3 failed on `1350113924` (a navigation bug).

| Seed | 1 Cold boot | 2 CEO | 3 on `0098139` | 3 after the fix | 8 Hardcore | 9 Quit |
| --- | --- | --- | --- | --- | --- | --- |
| `42` | PASS: world 21.8 s, linux-1 6.3 s, frame 22.1 s | FAIL, now PASS | PASS, 46.0 s, 11 of 11 | PASS, 47.3 s, 10 of 10 | PASS: Game Over 48 ms, World #2 3.9 s | PASS, 3.6 s |
| `mv-forest-1` | PASS: 24.0 s, 6.3 s, 24.2 s | FAIL, now PASS | PASS, 41.9 s, 10 of 10 | PASS, 42.2 s, 10 of 10 | PASS: 51 ms, 3.9 s | PASS, 6.0 s |
| `minevibe-e2e` | PASS: 25.0 s, 9.0 s, 25.1 s | FAIL, now PASS | PASS, 76.5 s, 15 of 26 | PASS, 68.0 s, 14 of 16 | PASS: 50 ms, 3.2 s | PASS, 2.8 s |
| `1350113924` | PASS: 18.2 s, 6.0 s, 18.4 s | FAIL, now PASS | **FAIL**, 46.1 s, 6 logs, `NO_NATURAL_SOURCE`, 6 of 13 | PASS, 59.5 s, 12 of 12 | PASS: 49 ms, 3.7 s | PASS, 2.7 s |
| `2368183124` | PASS: 17.9 s, 6.0 s, 18.1 s | FAIL, now PASS | PASS, 188.2 s, 19 of 35 | PASS, 165.1 s, 36 of 36 | PASS: 49 ms, 3.7 s | PASS, 2.0 s |
| `3207449953` | PASS: 17.7 s, 6.0 s, 17.8 s | FAIL, now PASS | PASS, 65.1 s, 13 of 29 | PASS, 66.0 s, 13 of 29 | PASS: 48 ms, 3.7 s | PASS, 3.0 s |
| `3037014017` (1, 3) | PASS | | PASS, 68.8 s, 16 of 29 | PASS, 47.2 s, 10 of 10 | | PASS |
| `217793310` (1, 3) | PASS | | PASS, 80.7 s (spruce), 19 of 22 | PASS, 87.6 s, 20 of 24 | | PASS |
| `2921725920` (1, 3) | PASS | | PASS, 46.0 s, 11 of 11 | PASS, 65.8 s, 15 of 15 | | PASS |
| **Collect done** | | | **8 of 9** | **9 of 9** | | |
| **Reach** | | | **120 of 186 (0.65)** | **140 of 162 (0.86)** | | |

- Step 3's "x of y" is logs mined of the mining targets tried (mined plus given up, the job's own `mined` and
  `unreachable`). No walk to a drop failed in any run. Tier 2 planned 4 to 31 times per run.
- Steps 1, 8 and 9 are from the runs after the fix; those on `0098139` match (world ready 17.9 to 21.1 s, linux-1
  running 5.9 to 8.5 s, death to World #2 3.0 to 3.9 s, teardown 2.1 to 3.0 s), except one Begin to World #2 of
  10.3 s (seed `3207449953`; under the 60 s check, not seen again). Each step 8 kept the same PCs (linux-1, running,
  bound to the new office) and buried the dead save in `saves/_graveyard`. Each step 9: `npm run play` returned 143
  (SIGTERM, as before), no child processes or orphans, linux-1's VM gone, the engine stopped.
- Step 2 after the fix: the CEO spawned 0 blocks from the door, then stood 3.0 blocks from the player (3.8 on
  `mv-forest-1`); head icons NONE then THINKING, bubble "On it: hello".

**Step 3 on `1350113924` (fixed in `4a9acd1`).** The office there is sunk about 6 blocks into a hill; its exit
stairs (the N1 review fix) let the CEO out. (`ceb3c01`, before the review fixes, failed this seed at once: no way out
of the office, three trees `no_path`.) The first tree gave 6 logs. The second, a 6-log oak on a bank 2 blocks above
the path, gave none, and the third was called unreachable from 4 blocks away. The cause: Tier 2 tests a "reach a
block" goal cell by its middle (3.75 blocks), but the body enters the last cell of a path on the side away from the
block, so the navigator arrived with the eyes 4.05 and 4.27 blocks from the log, and `Walk.toMine` failed
`out_of_reach` (hand reach 4.0). The miner then took the bank tree's base log for a high log; with no dirt in the bag
it booked all six as `logsLeftHigh`. The third tree could only be reached by digging, so that one failure made it
unreachable. Diagnosed with `MINEVIBE_NAV_DEBUG=1` and a throwaway instrumented mod jar (`MINEVIBE_MOD_JAR`). The fix:
a "reach a block" goal arrives only once the eyes are in hand reach; when the path is walked out, the body first
steps to the middle of the cell, crouched, for at most 30 ticks. Two GameTests, each failing on `0098139`: a block
up a glass corridor (old code arrived 4.02 from it) and the same geometry as a tree on a bank (old code:
`NO_NATURAL_SOURCE`, "oak tree 4m SE (unreachable)"). `NavGameTests` now has 29, and all 152 server GameTests pass.

The fix lifted reach on the seeds that passed too. On `0098139`, 65 of the 66 targets given up were booked as high
logs, the bank tree's six among them. After the fix, 22 were given up, all of them high logs: 16 in one 29-log oak
(`3207449953`), 4 in `217793310`'s spruce and 2 on `minevibe-e2e` (DEBT, "High logs of a felled tree stay up"). Collect
now fells more: on `2368183124` it finished a 24-log oak whole, so it mined 36 logs and kept 15, the rest left in the
canopy (DEBT).

**Step 2 (harness, `3b52313`).** The scripted crew has no welcome turn, so no bubble ever showed over the CEO, and
step 2 had failed in every scripted run since the harness was written (dry runs 1 to 4 above too). In scripted mode
the harness now says `@ada hello` and samples `debug.state` at 10 Hz until the reply bubble shows. It checks the
THINKING head icon in both modes.

**Cleanup.** Every run removed its own PC instance (container, network, three volumes, registry entry). The first run
also removed `0fa3430b`, the leaked E2E instance listed in `out/leaked-instances.txt` (DEBT, D2 sweep). The dev
engine still holds the other 13 instances it held before (12 unregistered, plus the play home). No temporary home, game,
node or VM process is left.

## Dual sessions, live (2026-10-09)

A small live check of dual sessions (PLAN §6.1, §6.3) on `main` right after they merged (`4a72fe4`): the E2E
harness with the real game, linux-1 on the Apple `container` engine and the SDK-bundled `claude`, seed
`mv-forest-1`, a hard cap of 12 agent turns for the whole check. Steps 1, 2 and 5, and two new steps: 10 (sit at
linux-1 again: the same desk session, and it remembers) and 11 (each session's tool list, the handoffs, titles,
tokens per request and the account e-mail, read from both sessions' transcripts and everything the run sent out).
Run A used 7 turns; run B, after the fixes below, ran steps 1, 2, 5 and 11 in 4 more (11 of 12).

```sh
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --steps 1,2,5,10,11 --seed mv-forest-1 \
  --max-turns 12 --hard-cap --pc-line '@ceo sit at linux-1, run uname -a, tell me the kernel, then stand up'
```

**Result: every step passed in both runs.** Run A found two small issues, fixed with tests (below), and one
more, left in DEBT.md. The harness also had a cost bug of its own (fixed).

| Check | Result | Evidence |
| --- | --- | --- |
| The CEO wanders in its body session | PASS | Welcome turn on `claude-haiku-5-5`. The body transcript's prompt snapshot offers 20 `mc` tools and AskUserQuestion: **no `pc` tool**. |
| `@ceo sit at linux-1, run uname -a, tell me the kernel, then stand up` | PASS | `sit_at_pc` on Haiku/xhigh; a new desk session took over 2.9 s later (2.4 s in run B). Its snapshot: 31 `pc` tools, 7 `mc` (calendar, codex, observe, remember, say, stand_up, tell), AskUserQuestion, WebFetch, WebSearch. `pc__bash` and `stand_up` ran on `claude-opus-5-5`/medium; ShellMirror changed the monitor twice. |
| Handoffs | PASS | The KICKOFF in the desk transcript carries the instruction (the task and the player's line, `uname -a`). The DESK REPORT in the body transcript carries the kernel, 6.18.35 (`uname -r` in the guest). The body was back 1.3 s after the stand (2.5 s in run B). |
| Report to the player | PASS | Desk: "Linux-1 is running Linux kernel 6.18.35 on aarch64, built June 15, 2026. I've stood up from the PC." Run A's body then said the kernel again (fixed in `ad5bb75`); run B's body stayed silent. |
| `@ceo sit at linux-1 again and tell me what you did last time` | PASS | The same desk session id (`774671b1`), server log `desk session took over` with `resumed: true`, and a second KICKOFF ("You sat down at linux-1 again") in the same transcript. The desk: "Last time I ran uname -a on linux-1. It showed Linux kernel 6.18.35 on aarch64, built June 15, 2026, and then I stood up." The version is only in the desk's own transcript (the KICKOFF quotes the player's lines, which name `uname`, not the version). It stood up by itself; the body took back. |
| Titles | PASS | 0 `ai-title` entries in the body and desk transcripts of both runs (2 `custom-title` each). The single-session E2E runs of 2026-10-08 wrote 4 (run 4) and 8 (run 2). |
| Account e-mail | PASS | The address, learned from the sessions' startup check and held in memory only, is in none of 7 client bubbles, 14 chat entries, 110 messages to the mod and 2 Codex files (run A; run B: 3, 7, 73, 2). The outbound redactor knew the account. |
| Quit | PASS | `npm run play` returned in 2.7 s (4.3 s); no orphans, linux-1's VM gone, the PC instance removed, the engine stopped. |

### Tokens

Per turn, run A (`result.usage`; prompt = uncached input + cache reads + cache writes, over the turn's requests):

| # | Turn | Session | Requests | Prompt tokens (cache read / write) | Output |
| --- | --- | --- | --- | --- | --- |
| 1 | welcome | body, Haiku | 1 | 14,035 (0 / 14,033) | 202 |
| 2 | sit | body | 2 | 28,863 (28,386 / 473) | 135 |
| 3 | KICKOFF: `uname -a`, stand up | desk, Opus (new) | 3 | 52,656 (34,956 / 17,694) | 200 |
| 4 | DESK REPORT | body | 1 | 14,781 (14,506 / 273) | 227 |
| 5 | sit again | body | 2 | 30,644 (29,895 / 745) | 401 |
| 6 | KICKOFF: "what you did last time", stand up | desk, Opus (resumed) | 2 | 37,217 (36,240 / 973) | 90 |
| 7 | DESK REPORT | body | 1 | 15,801 (15,524 / 275) | 191 |

Per request, from the transcripts, against the single-session E2E runs of 2026-10-08:

| Session | Requests | Prompt tokens per request: mean (range) |
| --- | --- | --- |
| Body (Haiku), run A / run B | 7 / 4 | 14,875 (14,035-15,801) / 14,471 (14,052-14,854) |
| Desk (Opus), run A / run B | 5 / 3 | 17,975 (17,385-18,669) / 17,539 (17,391-17,673) |
| One session, Haiku: run 4 / run 2 of 2026-10-08 | 3 / 19 | 27,040 (26,739-27,298) / 30,003 (26,744-34,610) |
| One session, Opus: run 4 / run 2 | 5 / 7 | 31,507 (29,634-32,591) / 32,774 (31,755-33,449) |

- Per request, the body costs 12.2k fewer prompt tokens than the old session on Haiku (−45%), the desk 13.5k fewer
  than on Opus (−43%). The old runs offered 79 tools on every request (54 v1 `mc`, 20 v1 `pc`, 5 built-ins), so this
  mixes the split with tools v2; EVALS.md ("Tool-list size per session") puts the split alone at −11.3k per body
  request and −5.3k per desk request against a v2 single session.
- One PC task (sit to body back) took 96.3k prompt tokens in 3 turns and 6 requests (96.4k in run B), against 211.9k
  in 2 turns and 7 requests in run 4 (sit 54.4k, then 157.5k for the seated turn). Not like for like: run 4 was
  plan-first and swapped models inside one session.
- What the split costs instead: the sit is a body turn of 2 requests (`sit_at_pc`, then end the turn), and the DESK
  REPORT one more body request (≈15k). A new desk writes its prompt prefix to the cache on its first request (17.7k
  tokens on Opus, $0.15 of run A's $0.17); run B, 4 minutes later, found it cached (3.8k written) and cost $0.045 in
  all. The resumed desk read its transcript from the cache (36.2k read, 1.0k written).

SDK estimates: run A $0.174 (body $0.0046, desk $0.169), run B $0.045 (body $0.0018, desk $0.043).

### Fixed on `main`

| Commit | Fix |
| --- | --- |
| `72c191e` | The body answers a DESK REPORT it has nothing to add to with `(silent)`, as the report asks; the brain skipped the bubble but still wrote `(silent)` to the merged transcript, so the player's chat log showed it after a PC session (run A, step 10). A silent reply now leaves neither. Test in `dualSessions.test.ts`. |
| `ad5bb75` | In run A's step 5 the body repeated the kernel version the desk had just said: the report left it to guess ("If Jasper already heard the result"). The report's summary is always the desk's final text, which was said aloud, so the report now says so; with no last words it asks the body for the result. Run B's body stayed silent. Test in `prompts.test.ts`. |
| `3bb41ca` | Harness: steps 10 and 11, each turn's session and tokens, `--hard-cap` (ends the session at `--max-turns`) and `--pc-line`. The run's cost took one session per agent (run A printed $0.0046 for $0.174); it now adds the body and desk sessions. Step 5 needs 3 turns now (sit, desk, report), not 6. |

### Found, not fixed

- **The body answers before its desk** (DEBT.md). In step 10 the body's sit turn already said "Last time I ran uname
  -a there, got Linux 6.18.35 on aarch64, and stood up." from its own DESK REPORT, and the desk said the same 3.6
  s later, so the player heard it twice.

### Limits

Two runs, one seed, one PC, 11 turns. Kick, damage, meetings, the TTL, crashes and cards in the desk are covered by
the unit tests only (EVALS.md "Dual sessions"). The comparison numbers come from the single-session runs of
2026-10-08 (v1 tools, plan-first). The runs' transcripts stay under `~/.claude/projects/`, as every E2E run's do;
they hold the account e-mail in Claude Code's own `session_context` attachment (DEBT.md).

## Gathering polish (2026-10-09)

The felling fixes of PLAN §7.2 ("Felling tall trees") for DEBT's tree-felling items, measured with step 3 at zero
tokens on the four seeds the task named, before (`7611dcd`) and after (this branch). Step 3 is the mod's own `collect`
of 10 logs with `radius: 48`, as above; "kept" is the logs in the CEO's bag, "given up" the job's `unreachable`
(`logsLeftHigh` in brackets).

```sh
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --crew scripted --steps 1,3 --seed 3207449953
```

| Seed | Before: trees, mined, kept, given up, time | After: trees, mined, kept, given up, time |
| --- | --- | --- |
| `42` | 2 (5, 5), 10, 10, 0, 45.7 s | 3 (4, 5, 5), 14, 14, 0, 78.2 s |
| `2368183124` | 3 (5, 6, 6), 17, 14 (+2 Bram), 0, 61.5 s | 3 (5, 6, 6), 17, 14 (+2 Bram), 0, 64.2 s |
| `3207449953` | 1 (29-log oak), 13, 13, 16 (16 high), 65.5 s | 1, 27, 26, 2 (2 high), 189.6 s |
| `minevibe-e2e` | 2 (4, 10), 14, 14, 2 (2 high), 70.9 s | 2 (4, 22), 26, 25, 0, 142.5 s |
| **Reach** | **54 of 72 (0.75)** | **84 of 86 (0.98)** |
| **Kept** | **51 of 54 (0.94)** | **79 of 84 (0.94; 0.96 with Bram's)** |

- Every run passed steps 1, 3 and 9; no hurt or death in the final runs. The trees differ between runs of a seed
  (the CEO's start varies, and W1 fells every tree it starts whole), so the table compares reach and kept rates
  more than totals. Times grew with the work: the high logs are felled now, by hand (the scripted CEO has no axe),
  and dirt for the pillar is dug first (5 blocks on `3207449953`, put back after).
- **High logs** (DEBT "High logs of a felled tree stay up"): `3207449953`'s 29-log oak gave up 16 logs before; now 2.
  The climb dug 5 dirt, pillared in the cut trunk to the top and twice beside a branch (8 blocks placed, all cleared;
  4 of the 5 holes filled again, one refill timed out). The two left: a branch log with no column in the 3x3 around it
  to stand in (`no_column`), and one where a pillar block found nothing to rest on (`pillar_failed`, NO_SUPPORT; DEBT).
- **Canopy drops** (DEBT "A felled big tree leaves most of its drops in the canopy"): in two earlier runs of this
  branch the CEO started by `2368183124`'s 24-log oak (which the nav v2 runs felled with 36 mined, 15 kept): 36
  mined, 28 kept (+2 Bram) and 34 mined, 29 kept (+3 Bram, 2 high). The rest were a log lying where no pickup box
  reaches (`not_picked_up`) and logs in the crown higher than a Tier-2 walk to the leaf under them reaches.
  "Bram" is the scripted crew's second agent, standing by: his Pickup reflex takes logs within 6 blocks of him.
- **One missed log** (DEBT "One missed log sends the miner climbing"): no run gave up more than a log of a tree; on
  `minevibe-e2e` (an earlier run of this branch) a log whose column the CEO could not walk into waited, was retried
  once at the end, and only that log was left.
- **Found on the way, fixed before these runs:** in an intermediate build the CEO drowned on `3207449953`. Digging dirt
  for the pillar took the floor of a hole it had dug before (deepening it block by block) and opened a water pocket
  under the oak; the drop sweep walked in after a log, and inside the pocket Tier 2 tried to break the grass ceiling
  while swimming (25 times slower: `break_timeout`) until the CEO drowned; the Hazard reflex cannot surface under a
  solid ceiling. Dirt is now dug only at the surface, one block deep, on solid ground, never a hole's floor, and the
  sweep fetches no drop under the ground or in roofed water (the Tier-2 side is in DEBT).

**GameTests** (`NavGameTests`, 33 then, 38 after the review below): a 9-log oak felled whole with nothing but an axe in the bag (dirt dug, 3
pillar blocks in the cut trunk, 9 of 9 kept, 350 ticks, holes filled, no scaffold left); a 2x2 spruce 12 high (48
logs, 7 pillar blocks, 48 of 48 kept, about 1 140 ticks); an 8-log oak whose branch end over an obsidian block no walk
reaches (the rest of the tree comes down, and the blocked log on the retry, with the dug dirt as a Tier-2 pillar: 15
of 15); and an office on a 6-high plateau whose porch is its edge (stairs down 6 treads, Tier 1 walks down and back
up unhurt, the office unchanged). The regression suites pass: all 156 server GameTests in the last three full runs
(earlier runs on this branch caught its own bugs, and two approach tests failed once each from a time-of-day race this
change does not touch: DEBT); `TreeClimbTest` (4 unit tests) for the climb's numbers.

**Cleanup.** Every run removed its own PC instance; no game, node or VM process is left.

**Review (same day).** An adversarial review of the polish found an agent left stranded on its pillar when the
felling job ended up there (cancelled, replaced, timed out, failed: no walk comes down a pillar), the fall limit
checked only when a climb was planned and measured from whatever the agent stood on, cobblestone scaffold mined back
by hand (lost), a full bag digging every dirt block around, and a knocked-off climb giving its log up and planning
the next climb on top of its old pillar. Fixed (DEBT, "Found in the gathering polish review", for what stays open),
each with a GameTest that fails on the polish commit and passes now (`NavGameTests`, 38):

| GameTest | What it shows | Numbers (4 full runs) |
| --- | --- | --- |
| `nav_cancelled_climb_comes_down` | 14-log oak, job cancelled 5 blocks up the pillar: the PillarDown reflex (41) mines it away | down to the ground, unhurt, no scaffold left |
| `nav_hurt_climb_comes_down` | health set to 10 four blocks up (limit now 2) | never higher than 4, down to the ground |
| `nav_climb_builds_only_with_scaffold_it_mines_back` | 9-log oak, 16 cobblestone and no pickaxe | dirt dug, 9 of 9 kept, 16 cobblestone kept, 351-378 ticks |
| `nav_full_bag_digs_no_holes` | 9-log oak, bag with room for logs only | no hole dug; 6 low logs felled, 3 left high |
| `nav_climb_knocked_off_its_column` | 14-log oak, agent moved off its pillar 7 up | new climb beside it, 14 of 14 kept, old pillar cleared from a 1-block Tier-2 pillar, 720-737 ticks |

All 161 server GameTests passed in four full runs after the fixes, and the 423 unit tests (`TreeClimbTest`: 5).

## Water navigation (2026-10-09)

The fix for the live report of Ada (CEO) sitting silent in a small cave pool, its ledge a block over the water, with
no brain running (PLAN §7.2 "Water", §7.3 WaterEscape; DEBT "An agent in a water pocket under the ground drowns").
Vanilla lifts a swimmer only onto a bank level with the water line, so every walk toward the player on the ledge
failed, the follow reflex issued it again, and nothing ever said so.

**GameTests** (`WaterNavGameTests`, 13, a batch of their own on the 33x33 `nav_field`; numbers from the last full run;
every test also checks that the agent never mined while swimming, never lost health, and, but the flooded tunnel,
never had less than 200 of its 300 air):

| GameTest | What it shows | Numbers |
| --- | --- | --- |
| `water_pool_ledge_exit` | the live report: a stone cave, a pool one deep, the ledge a block over the water, ceiling 3 over it, nothing in the bag, the player on the ledge | WaterEscape digs a step into the ledge from the pool's bottom (head dry) and climbs out, then follows: 343 ticks, 1 block broken |
| `water_pocket_two_high_step` | an enclosed pocket two deep, walls two over the water line, 8 dirt | a block in the water, a pillar block, up: 120 ticks, 2 placed |
| `water_sealed_pocket_digs_out` | water two deep sealed in dirt (glass around), 2 dirt | a step, then a staircase up 8 blocks to the grass, from standing cells only: 408 ticks, 13 broken, 6 placed (with dirt it dug), air never below 300 |
| `water_flooded_tunnel_swims_to_air` | a tunnel flooded to its stone ceiling (no air over the agent), a cave pool 3 blocks on | no wait to surface where there is no air: swims under the stone and climbs out, 160 ticks, air 176 (Hazard takes over at 100) |
| `water_follows_player_through_lake` | the player wades into a lake and out on the far side | follows in, treads water beside the player (no escape: it is where it means to be), follows out; air 300 |
| `water_crosses_flowing_river` | `goto` across a stream one deep, flowing along the crossing | 105 ticks, 0.01 blocks off its line (0.34 without the upstream aim) |
| `water_goto_across_pond_high_bank` | `goto` across a pond two deep whose far bank is a block over the water line, 8 dirt | Tier 1 stops at the near bank (no dead-end swim), Tier 2 swims and puts a step in the water: 166 ticks, 1 placed |
| `water_pickup_across_pond` / `water_collect_tree_across_pond_high_bank` | a log across a pond; an oak across a pond with a high far bank | 141 ticks; 2 logs kept, 495 ticks, 1 step placed |
| `water_job_loop_fails_stuck_in_water` | a job that swims out into a moat again after every escape (a regression for the resume loop) | three escapes, then `STUCK_IN_WATER`, an urgency-2 `stuck` event with the stuck-in-water bark, and out of the water: 618 ticks |
| `water_stranded_treads_water_and_speaks_up` | a well three deep, walls three over the water, nothing in the bag | stranded: treads water at the surface (the `stranded_in_water` reflex), speaks up once, looks again silently; handed 2 dirt, out on the next look: 726 ticks, air 267 |
| `water_follow_stays_out_of_dead_end_pool` | the player on a ledge across a pool, out of every walk's reach | never sets foot in the water (Tier 1 cuts the path at the bank), speaks up after 5 failed walks (urgency 2, the stuck bark) |
| `water_planner_never_breaks_while_swimming` | the planner alone in DEBT's pocket under a dirt roof | no plan from water two deep (breaking the roof while swimming is gone); from water one deep only from the bottom with the head dry |

Tier-2 searches stayed within the budget (largest tick 1.60 ms in `water_sealed_pocket`; `nav_perf` 1.51 ms per agent
tick, 0 ticks over). All 175 server GameTests passed in the last full run, and the 174 before the flooded-tunnel test
in the two runs before it. Earlier full runs found a GameTest's office override saved into the GameTest world (every
later player stand-in was welcomed into it, away from where its test put it; fixed in `OfficeService`, DEBT), and one
hung for 10 minutes after a light-engine crash in vanilla's worker thread (DEBT; the re-run passed). The 1621 server
unit tests pass, `stuckWake.test.ts` among them (an urgency-2 `stuck` wakes the body's brain at P2 and Node says its
bark at once, with no "one sec" over it; `STUCK_IN_WATER` hints to ask, not retry), and so do typecheck and lint.

**Scripted runs at zero tokens** on three seeds with water near the office (`waterNearest`, new in the harness: the
nearest water blocks from the CEO before step 3; `waterEscapes`, `stuckInWater`, `navLoops` count the WaterEscape
takeovers and the stuck events during step 3):

```sh
node --conditions=source --import tsx scripts/e2e/run-scenario.ts --crew scripted --steps 1,2,3,8 --seed 42
```

| Seed | Water | 1 Cold boot | 2 CEO | 3: mined, kept, given up, time | Escapes, stuck | 8 Hardcore | 9 Quit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `42` | 5.7 m | PASS, world 13.6 s | PASS | PASS, 11, 11, 0, 49.1 s | 0, 0 | PASS, 2.8 s | PASS |
| `2368183124` | 17.2 m | PASS, world 13.4 s | PASS | PASS, 17, 14 (+ Bram), 0, 63.4 s | 0, 0 | PASS, 2.7 s | PASS |
| `3207449953` | 25.4 m | PASS, world 43.7 s | PASS | PASS, 27, 27, 2 (high), 172.1 s | 0, 0 | PASS, 2.7 s | PASS |

The three ran on the build before the last two changes (no surfacing wait where no air is above; the ashore goal
asks each dry region once); `42` again on the final build: PASS throughout, water 8.2 m, 12 mined, 12 kept, 54.0 s,
no escape. No regression against the gathering polish runs above (the same reach and kept rates; `3207449953` felled
its 29-log oak). No walk led into water it could not leave, so no escape was needed and nothing was said. The worktree
reused the main checkout's game downloads through a link to `.minevibe-dev/play` (the harness seeds its home from
there). Every run removed its own PC instance; no game, node or VM process is left.
