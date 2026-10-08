# Spike S7: boot and hardcore reset

Date: 2026-10-08. Host: macOS 27.0 (Darwin 27.0.0), Apple M5 Pro, Temurin 25.0.4.1 (Gradle-provisioned), Node 24.20.
Minecraft 26.3 + Fabric Loader 0.19.5 + Fabric API 0.162.0+26.3 via `./gradlew runClient` (OpenGL, no
performance mods). Nothing was installed system-wide.

**Verdict: PASS.** The game never shows the title screen, the Esc menu never pauses, death leads to Game Over in
well under 3 s, Begin lands in a new hardcore world in about 3-5 s (budget 20 s), and killing the game on Game
Over comes back to Game Over and then the new world. The fallback (seed the world folder + Quick Play) is not
needed.

## How to run it

```bash
npm install                         # repo root, once
node spikes/s7-boot/run.mjs         # re-execs itself with tsx and the `source` export condition
```

`run.mjs` starts the dev server in-process (`startDevServer`, E2E mode, random port, a private `MINEVIBE_HOME` and
`savesDir`), then starts the game with `./gradlew runClient` and these environment variables, which the Loom run
config turns into `-D` properties of the game JVM (`apps/mod/build.gradle.kts`, documented in `apps/mod/README.md`):

| Variable | Game JVM | Value in the run |
|---|---|---|
| `MINEVIBE_BRIDGE_FILE` | `-Dminevibe.bridgeFile` | the run's `home/run/bridge.json` |
| `MINEVIBE_E2E` | `-Dminevibe.e2e` | `true` (enables `debug.*`) |
| `MINEVIBE_DEV` | `-Dminevibe.dev` | `false` (so the world must have commands off) |
| `MINEVIBE_PARENT_PID` | `-Dminevibe.parentPid` | a `sleep 900` stand-in parent (lifeline test, and a bound on the game's life) |
| `MINEVIBE_RUN_TAG` | `-Dminevibe.runTag` | unique per run, for `pgrep`/`pkill -f` cleanup |
| `MINEVIBE_RUN_DIR` | game directory | `apps/mod/build/s7/<run>` (fresh, gitignored) |

The fresh game directory gets the `options.txt` keys the M1 launcher will seed (`onboardAccessibility:false`,
`pauseOnLostFocus:false`, `tutorialStep:none`, quiet sound, render distance 6). The script drives the game only
through the bridge (`debug.state`, `debug.kill_player`, `debug.open_menu`, `debug.click_begin`) and reads the
`[screen] <shown> (requested <asked>)` lines the mod logs for every `Gui#setScreen`. Output goes to
`spikes/s7-boot/out/<run>/` (gitignored): `summary.md`, `result.json`, one `client-*.log` per launch and
`devserver.log`. Every game it starts is killed before it exits (also on Ctrl-C), and it checks that none is left.

## Scenario and results (final run `s7-2026-10-08T16-56-42-072Z`: 29/29 checks PASS)

| # | Step | Result |
|---|---|---|
| 1 | Boot: BootScreen replaces TitleScreen, waits for `world.open{world-1, fresh}`, creates the world | **PASS**: hardcore=true, difficulty=hard, mode=survival, allowCommands=false; `world.state{ready, fresh:true}` reached Node |
| 2 | Esc menu: `debug.open_menu` -> `Minecraft#pauseGame` -> MineVibeMenuScreen | **PASS**: 60 server ticks in 3 s with the menu open, `isPaused()=false`, `IntegratedServer#isPaused()=false` |
| 3 | `debug.kill_player` -> Game Over | **PASS**: GameOverScreen (requested DeathScreen); Node marked world-1 dead and allocated world-2 before acking `player.died` |
| 4 | `debug.click_begin` -> new world | **PASS**: standing in world-2 (hardcore HARD survival); `saves/world-1` moved to `saves/_graveyard/world-1` |
| 5 | Die in world-2, `SIGKILL` the game on Game Over, relaunch | **PASS**: screens `BootScreen (requested TitleScreen) > GameOverScreen` with no world loaded (from Node's `world.next`), then Begin -> world-3; world-2 buried |
| 6 | Dead-marker recovery: die in world-3, kill the game, rewind Node's record to "world-3 alive", restart Node, relaunch | **PASS**: `world.open{world-3}` -> the save's dead marker -> GameOverScreen without loading the world; `player.died` re-sent and acked; Begin -> world-4 |
| 7 | Lifeline: the parent process exits | **PASS**: "Parent process exited: saving and quitting", `client.stopping` reached Node, world-4 saved, JVM gone |
| - | Screen log of all three launches | **PASS**: TitleScreen never shown (it is requested once per launch and replaced) |

### Timings (four complete runs of the final code; the budget column is PLAN §7.9 / §12.1)

| Measure | Runs (ms) | Budget |
|---|---|---|
| `runClient` start -> standing in World #1 (includes Gradle and game startup) | 13902, 16443, 12213, 12405 | - |
| Server ticks in 3 s with the menu open | 60, 60, 60, 60 | > 0 (not paused) |
| `debug.kill_player` sent -> GameOverScreen seen | 26, 22, 21, 20 | < 3000 |
| Death -> Begin accepted (Node's `world.next` arrived) | 100, 50, 50, 66 | Begin enables on `world.next` or after 10 s |
| Begin -> standing in the new world | 3470, 3149, 2433, 2616 | < 20000 |
| Relaunch after `SIGKILL` -> GameOverScreen (includes game startup) | 9095, 7783, 8632, 7964 | - |
| Begin after relaunch -> standing in the new world | 4715, 3766, 4017, 4363 | < 20000 |
| Begin after dead-marker recovery -> standing in the new world | 4512, 4050, 4733, 4149 | < 20000 |
| Parent process exits -> game JVM gone (world saved) | 1623, 1335, 1602, 1299 | - |

Earlier runs of the final code had two harness-only failures, both fixed in `run.mjs` (the game was right in
both): the screen order was read before Gradle had piped the `[screen] GameOverScreen` line through, and the
first `debug.state` showing GameOverScreen once still had `dead=false` (the death screen packet can arrive a tick
before the health update).

## Findings

1. **Inject `Gui#setScreen` at HEAD and STORE, not at the PUTFIELD.** The first version used
   `@ModifyVariable(at = @At(value = "FIELD", opcode = PUTFIELD))`. That compiles and runs, but at that point
   `aload_1` has already pushed the original screen for `this.screen = screen`, so the field kept the TitleScreen
   while `init()` ran on the replacement. The game sat on an invisible TitleScreen and BootScreen never ticked.
   The working mixin rewrites the argument at `HEAD`, rewrites vanilla's own substitutes for `setScreen(null)`
   (TitleScreen with no level, DeathScreen when dead) at `STORE`, and logs the real field at `TAIL`.
2. **`world.open` can arrive before BootScreen exists.** The bridge connects during client init and Node answers
   at once, while the loading overlay and startup screens are still up. BootScreen therefore peeks the pending
   request in `ClientSession` and only claims it when it acts; a BootScreen that is replaced (e.g. by the startup
   chain's TitleScreen -> BootScreen) never loses it. It also waits for the loading overlay to finish.
3. **World loads run as queued tasks**, never inside a screen's `tick()`: BootScreen and GameOverScreen call
   `Minecraft#schedule(...)`, the way vanilla's `WorldOpenFlows` opens worlds from `minecraft.execute`.
   `Minecraft#disconnect` blocks until `IntegratedServer#isShutdown()`, then `world.state{closed}` is sent, so Node
   only moves the save to the graveyard after the server has released it.
4. **Crash on Game Over needs Node to keep the dead world current.** Previously `hello{boot}` on a dead world
   made Node advance at once and send `world.open` for the next world, so a restart skipped Game Over. Node now
   re-sends `world.next` and advances only on the mod's `world.state{closed}` (protocol §6.6 updated). When Node
   never heard of the death, the save's dead marker (`<save>/data/minevibe/hardcore.dat`, saved data written and
   flushed in `AFTER_DEATH`) takes the mod to Game Over and `player.died` is re-sent until acked (step 6).
5. **The client can only close with 1008, not 1009.** `java.net.http.WebSocket#sendClose` rejects 1009 from a
   client, so an oversize message from Node closes the socket with 1008 (protocol §9 notes it).
6. **Focus loss:** `pauseOnLostFocus` is seeded false in `options.txt` and also forced false at client start
   (not saved). Even when focus loss opens the menu, the menu does not pause (step 2). Focus loss itself was not
   tested separately.
7. Unrelated noise in the logs: Realms authorisation fails in dev (offline `Player###` profile), and Fabric warns
   that the recommended performance mods are missing (they are installed by the M1 launcher, not by `runClient`).

## Not covered here

- The real launcher path (`npm run play`, xmcl, seeded configs, `--disableMultiplayer`) is M1 launcher work (S8).
- A screen recording (`screencapture -v`, PLAN §13.7) was not made; the `[screen]` log is the record.
- Client GameTests (`./gradlew runClientGameTest`) still pass and still end on TitleScreen: under
  `-Dfabric.client.gametest` the redirects are off and no bridge is started. A GameTest that drives BootScreen
  against an in-JVM fake bridge (PLAN §11 `mod-client`) is still to be written.
