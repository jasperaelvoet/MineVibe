# Spike S4: monitor rendering and PC input

Date: 2026-10-08. Host: macOS 27.0 (Darwin 27.0.0), Apple M5 Pro, Temurin 25.0.4.1 (Gradle-provisioned), Node 24.
Minecraft 26.3 + Fabric Loader 0.19.5 + Fabric API 0.162.0+26.3 through `./gradlew runClient` (OpenGL), window
1708x960, vsync off. Performance mods: Sodium 0.9.2+mc26.3 and Entity Culling 1.11.2 from `packaging/mods.lock.json`
(sha512-verified, copied into the run's `mods/`); a second run had no performance mods. Nothing was installed
system-wide.

**Verdict: PASS.** 1280x800 frames at 30 fps, JPEG or raw BGRA8, reach the monitor quad and PcControlScreen with a
render-thread cost of about **0.6 ms at p95 per frame, and at most 1.85 ms in the worst single frame** (usually about
1 ms) with Sodium and Entity Culling, and the same without them, against a target of 2 ms. Every frame was decoded and acknowledged at 29.4-29.6 fps with no drops.
The monitor renders correctly under Sodium and Entity Culling. The SDL3 input path (key events by scancode and
keycode, text by `charTyped`, the reserved chords) works end to end into `pc.input`. The JPEG-only fallback is not
needed.

## How to run it

```bash
npm install                              # repo root, once
node spikes/s4-monitor/run.mjs           # Sodium + Entity Culling
node spikes/s4-monitor/run.mjs --vanilla # no performance mods
```

`run.mjs` starts the dev server in-process (random port, private `MINEVIBE_HOME`) and plays the PC manager's part
on the bridge: `pc.state` for one PC `s4-monitor` on MVF1 slot 7 (running, 1280x800), `budget.state`, `ok` replies
to `pc.action`, and the flow control of `FrameService` (at most 2 unacknowledged frames, an ack releases older
ones). It renders 30 test patterns (moving colour bars, a gradient, a frame counter) as BGRA8 and as JPEG q80
(`sharp`, about 60 KiB each), then launches the game with the mod's PC demo switched on through environment
variables:

| Variable | Effect |
|---|---|
| `MINEVIBE_PC_DEMO=<pcId>` | `PcDemo`: places a workstation bound to the PC 3 blocks ahead, looks at it, runs the phases |
| `MINEVIBE_PC_DEMO_PHASES` | the phases and their seconds (default `baseline:12,watch:50,seat:50,type:8,stand:6,config:6,watchscreen:6`) |
| `MINEVIBE_PC_STATS=1` (or `-Dminevibe.pcStats=true`) | one `[pc-stats]` line every 5 s: fps, uploads, upload ms, render-thread cost per frame (p50/p95/max), decode ms, received/decoded fps, drops |
| `MINEVIBE_PC_INPUT_LOG=1` (or `-Dminevibe.pcInputLog=true`; the demo turns it on) | `[pc-input]` lines: every SDL3 `KeyEvent` and `CharacterEvent` PcControlScreen gets, and every `pc.input` batch it sends |

Phases: `baseline` (no frames), `watch` (the monitor in the world; JPEG for the first half, BGRA for the second),
`seat` (PcControlScreen; BGRA, then JPEG), `type` (synthetic SDL3 key and text events pushed with `SDL_PushEvent`),
`stand` (a synthetic Shift+Esc), `config` and `watchscreen` (the two screens, for screenshots). F2 screenshots are
taken along the way. The runner streams frames whenever the mod's `pc.view` tier for the PC is not `none`,
attributes each `[pc-stats]` line to the phase and codec it covers, checks the protocol traffic, kills the game and
writes `out/<run>/{summary.md,result.json,client.log,devserver.log,*.png}` (gitignored).

## Results

Render-thread cost = all monitor work on the render thread in one frame: render-state extraction of the monitor
(including the texture upload), submitting its quads, and drawing the picture in a screen. Medians over the 5 s
samples of each 25 s window, maximum of the maxima.

### Sodium 0.9.2 + Entity Culling 1.11.2 (final run `s4-sodium-2026-10-08T20-00-25-232Z`)

| Window | Node fps | Game fps | Decoded fps | Upload avg / max ms | Cost p95 / max ms | Decode avg ms |
|---|---|---|---|---|---|---|
| baseline (status screen, no frames) | 0 | 368 | 0 | - | 0.04 / 0.08 | - |
| watch, JPEG 1280x800 | 29.5 | 422 | 29.4 | 0.64 / 0.93 | 0.61 / 0.93 | 2.93 |
| watch, BGRA8 1280x800 | 29.1 | 384 | 29.4 | 0.65 / 1.84 | 0.63 / 1.85 | 0.38 |
| seat (PcControlScreen), BGRA8 | 29.5 | 418 | 29.4 | 0.70 / 1.26 | 0.64 / 1.26 | 0.43 |
| seat (PcControlScreen), JPEG | 29.5 | 367 | 29.4 | 0.66 / 1.09 | 0.62 / 1.11 | 3.08 |

Two earlier runs with the same code (`…T19-47-00-913Z`, `…T19-56-12-138Z`) gave cost p95 0.60-0.70 ms and max
0.83-1.15 ms; the 1.84 ms upload above is a single outlier in 25 s.

### No performance mods (run `s4-vanilla-2026-10-08T19-49-25-472Z`)

| Window | Node fps | Game fps | Decoded fps | Upload avg / max ms | Cost p95 / max ms | Decode avg ms |
|---|---|---|---|---|---|---|
| baseline | 0 | 261 | 0 | - | 0.04 / 0.07 | - |
| watch, JPEG | 29.5 | 284 | 29.4 | 0.64 / 0.80 | 0.64 / 0.80 | 2.99 |
| watch, BGRA8 | 29.5 | 266 | 29.4 | 0.68 / 1.66 | 0.68 / 1.68 | 0.44 |
| seat, BGRA8 | 29.4 | 258 | 29.4 | 0.66 / 1.22 | 0.65 / 1.23 | 0.38 |
| seat, JPEG | 29.5 | 282 | 29.4 | 0.65 / 1.21 | 0.65 / 1.21 | 3.12 |

Each run sent about 2,940-2,950 frames (6.1 GB) and every one was acknowledged; the 2-unacked window held a frame
back 1-8 times per run; the bridge skipped none (it never buffered 8 MiB); the mod dropped, rejected or failed to
decode none. Game fps varies with the view (sky, terrain) and is not a controlled benchmark; streaming did not visibly
lower it.

### Checks (all PASS in the final runs)

- `pc.view` went `visible` (watching) > `focus` (seated) > `visible` (stood up); no frames were sent at tier `none`.
- `pc.seat{occupant: player}` when the demo sat down; `pc.unseat{reason: stand}` after the synthetic Shift+Esc.
- The synthetic typing reached `pc.input` in order: `'aHé AZERTY ü'`, `KEY_TAB` down/up, `KEY_CONTROL` + `KEY_C`,
  `KEY_ENTER`, `KEY_ARROW_UP`, then `release_all` when the screen closed.
- Watch mode sent `pc.action watch` / `unwatch`; PcConfigScreen and Watch mode were screenshotted for a visual check
  (the config screen's buttons were rearranged into rows of two after the first look clipped "Decommission").
- No game process was left behind.

### Input log (SDL3 events as PcControlScreen receives them)

Synthetic (pushed with `SDL_PushEvent`, delivered by vanilla's `SDLEventHandler`):

```
[pc-input] KeyEvent down scancode=4 keycode=97 mods=0x0
[pc-input] CharacterEvent codepoint=U+61 'a' mods=0x0
[pc-input] KeyEvent up scancode=4 keycode=97 mods=0x0
[pc-input] CharacterEvent codepoint=U+48 'H' ... U+e9 'é' ... U+fc 'ü'
[pc-input] KeyEvent down scancode=43 keycode=9 mods=0x0          Tab -> KEY_TAB
[pc-input] KeyEvent down scancode=6 keycode=99 mods=0x40         Ctrl+C -> KEY_CONTROL, KEY_C (no text)
[pc-input] KeyEvent down scancode=225 keycode=1073742049 mods=0x1, then scancode=41 keycode=27 mods=0x1   Shift+Esc -> stand up
```

During the first run a person used the game window with a physical (QWERTY) keyboard. The log shows real SDL3
events with the expected values: Esc `41/27` went to the guest as `KEY_ESCAPE` (the screen does not close on Esc),
Shift+Tab became `+KEY_SHIFT +KEY_TAB -KEY_TAB -KEY_SHIFT`, Shift+Esc stood up (`pc.unseat{stand}`),
Ctrl+Shift+Enter (`40/13`, mods `0x41`) opened the chat overlay and the PC screen came back when it closed;
right-clicking the monitor opened Watch mode (`pc.action watch`) and right-clicking the chair sat down
(`pc.seat`). That run's timings are not used above (the person was moving around during the measurement).

### Screenshots (kept here; the full set is in each run's `out/`)

- `monitor-in-world.jpg`: the monitor showing the JPEG stream, Sodium + Entity Culling.
- `monitor-status-screen.jpg`: the status screen of a running PC before its first frame ("Starting display…").
- `pc-control-screen.jpg`: PcControlScreen with the border strip, the self-drawn cursor and the hint bar.
- `pc-config-screen.jpg`: PcConfigScreen (sliders clamped to the budget, budget bars, Vault, lifecycle buttons).

## Findings

1. **No `getRenderBoundingBox` in 26.3**, so culling is vanilla's (and Sodium's): block entities of visible
   sections, no per-block-entity frustum test. The block entity lives in the monitor block (the main upper part of
   the 2x2 desk); the picture reaches 12 px into the side column. Under Sodium and Entity Culling the monitor
   rendered in every screenshot, from the side and from the front. `shouldRenderOffScreen` stays false.
2. **`RenderTypes.text` samples with the texture's own sampler**, so a clamped, linear `MonitorTexture` scales the
   1280x800 picture smoothly onto the small quad. The `TEXT` pipeline culls back faces: the quad is wound
   counter-clockwise for the viewer, and status-screen text is drawn with the sign pattern (rotate 180°, scale
   `(s, -s, s)`).
3. **Uploading a whole 1280x800 frame costs about 0.65 ms** (`CommandEncoder#writeToTexture(GpuTexture,
   ByteBuffer, ...)`, OpenGL on Apple Silicon), once per PC per rendered frame at most, so 30 fps costs about
   20 ms per second of render-thread time, spread over 1 frame in 10-15. No buffer-to-texture streaming
   (`copyBufferToTexture`) is needed at this size. The GL backend sets `UNPACK_ROW_LENGTH` to the upload width, so
   the mod uploads one band of full-width rows (the union of the changed rows) straight out of its CPU copy.
4. **Decoding is cheap enough off-thread.** STB decodes a 1280x800 JPEG (q80, ~60 KiB) in about 3 ms; the BGRA
   R/B swizzle into the CPU copy takes about 0.4 ms. Both run on the two decoder threads, frames of one PC in
   order, so a JPEG stream could go to about 300 fps per PC before decoding limits it.
5. **Flow control works as designed.** The mod acknowledges each frame after decoding; with at most 2 unacked frames
   Node waited for an ack 1-8 times in about 2,950 frames, and the bridge never hit its 8 MiB skip threshold, even
   with 4 MiB raw frames at 30 fps (about 120 MB/s over loopback).
6. **The block outline cut through the picture.** The monitor's selection box has its front edge in front of the
   screen and its side edge on the column boundary, so looking at the screen drew a black line down its middle.
   The mod now cancels the outline for the monitor blocks (`LevelRenderEvents.BEFORE_BLOCK_OUTLINE`); the desk
   below still has one.
7. **Input details found on the way** (now in PLAN 7.7 and API_MAP 7.4): `CharacterEvent` carries no modifiers
   (PcControlScreen reads `SDL_GetModState`); F2 and F11 are handled by `Minecraft#handleGlobalKeyPress` before the
   screen sees them (only their key-ups arrive); key repeats arrive as presses with action `-1` (not re-sent: the
   guest repeats a held key); when the window loses focus (Cmd+Tab) a held modifier's key-up may never come, so
   PcControlScreen sends `release_all` on focus loss.
8. **Measurement pitfall.** The first runs counted the upload twice (once as upload, once inside the extraction it
   happens in) and reported p95 1.2 ms / max 2.5 ms. The numbers above come from the corrected accounting, where
   every render-thread span is counted once.

## Open items

- A physical AZERTY (or other non-US) layout was not tried; it needs the macOS input source switched. The pipeline
  is layout-correct by construction (text from `charTyped`, chords mapped by SDL keycode, unit-tested in
  `PcInputTest`), and the synthetic run typed non-ASCII text.
- The frames here are generated; real guest frames come from `FrameService` once the PC manager is wired to the
  bridge. `InputRouter` still takes the earlier tuple format (`["kd","KEY_X"]`), not T0's `pc.input` event
  objects, so that wiring needs an adapter.
- Middle-mouse look-around and the Dynamic FPS flawless-frames switch were not exercised (Dynamic FPS was not
  installed).
- Entity Culling with globally rendered block entities is still untested (the monitor does not need it).
