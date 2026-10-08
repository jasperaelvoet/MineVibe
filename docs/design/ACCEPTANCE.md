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
with the client snapshots, `server.log`, the game's logs, screenshots). `--crew scripted` runs boot, a chat and UI
smoke test, a seed scout (can a body mine oak here?), death and quit without spending tokens.

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

In [DEBT.md](DEBT.md), "Found in the live acceptance run": visible oak unreachable on most seeds (`mine`
`UNREACHABLE (no_path)`), no `/mnt/codex` in the PCs, the mod's `ok` replies drop nested nulls, plan cards without a
plan when the agent states its plan in prose, and throwaway homes leaking PC instances into the shared dev engine.

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
