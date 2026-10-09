# S9: PC tools V2, P0 probe (2026-10-09)

The probe the PC tools V2 design asked for before any code (its §9), run against a real `linux-pc` (spacesd 0.5.3,
Ubuntu 24.04, X11/XFCE, 1280×800) booted through PcManager on Apple `container`.

```
node --conditions=source --import tsx spikes/s9-pc-tools-v2/boot.ts <outDir>          # one labelled PC, kept up
node --conditions=source --import tsx spikes/s9-pc-tools-v2/client.ts <outDir> <probe.ts>
node --conditions=source --import tsx spikes/s9-pc-tools-v2/measure.ts                  # tool definition sizes
```

`boot.ts` writes `endpoint.json` (the token stays in its 0600 file) and removes everything it created when
`<outDir>/stop` appears. The probes are `p1-…p13-*.ts`.

## Findings

1. **Methods and features.** `jsonMethods()` lists 85 JSON methods, among them `AccessibilityService/{GetTree,Find,Act}`,
   `WindowsService/{ListWindows,GetWindow,ActivateWindow,SetWindowBounds,Minimize,Maximize,Restore,CloseWindow,LaunchApp,Open}`,
   `ComputerService/{Screenshot,Pointer,Keyboard,GetCursorPosition,ListDisplays}` and `DriverService/{ListTools,CallTool}`.
   `capabilities().features` reports `a11y`, `windows`, `launch_app`, `driver`, `background_input` (XSendEvent, which
   GTK and Chromium ignore: AUTO falls back to foreground XTest), `clipboard.*`, `pty` and `fs_watch` as supported.
2. **Request fields** (from serde's "unknown field … expected one of" errors):
   - GetTree `{window:{id,epoch}, maxDepth, includeHidden, maxNodes}`; Find `{window, query:{role, name,
     nameContains, valueContains, states}, maxResults}`; Act `{element:{snapshotId, elementId}, action, value,
     customAction, delivery}`.
   - Pointer `{target, click{position, button, count, modifiers}, move{position, duration}, down/up{position?,
     button}, drag{from, to, path, button, duration, modifiers}, scroll{position, deltaX, deltaY, unit}}`;
     Keyboard `{target, type{text, mode, delay}, press{key{named|character}, modifiers, repeat}, hotkey{keys},
     down, up}`. Modifiers are `KEY_*` names (`["KEY_CONTROL"]`).
   - Screenshot `{region{x,y,width,height}, format, quality, maxDimension, includeCursor, displayId, window}`
     answers `{image (base64), imageSize, nativeSize, scale, logicalBounds, screenshotId, …}`; a region is never
     scaled up (200×100 with maxDimension 800 stays 200×100).
   - LaunchApp `{app{appId|executable|name}, args, env, cwd, delivery, waitForWindow (a duration string, "5s")}`;
     Open `{url|path, withApp, delivery}`.
   - The full `KEY_*` enum (KEY_A…Z, KEY_DIGIT_*, KEY_NUMPAD_*, KEY_MEDIA_*, KEY_BROWSER_*, KEY_VOLUME_*, …) and
     `MOUSE_BUTTON_{LEFT,RIGHT,MIDDLE,BACK,FORWARD}`.
3. **Accessibility works on GTK apps and Firefox.** Nodes come flat in document order: `elementId`, `parentId?`,
   `depth`, a normalized `role` (`button`, `text_field`, `menu`, `table_cell`, `paragraph`, `link`, `heading`, …), the
   toolkit's `nativeRole`, `name`, `value`, `description` (spacesd's own hints: "closed menu with 7 items",
   "off-screen: scroll it into view before a pixel action; element actions still reach it"), `bounds`, `states`,
   `actions`. GetTree and Find default to the focused window; Find matches names case-insensitively and roles in
   both spellings (`button` / `push button`). Firefox pages expose their text (paragraphs, headings, links), with
   U+FFFC placeholders in container values. **Chromium exposes only its window node** (no
   `--force-renderer-accessibility`), and **a terminal exposes no text** (only a `terminal` node).
4. **Act works in the background**: SET_VALUE on Thunar's location bar navigated to `/tmp` without focusing the window;
   PRESS on "Home" went back. **spacesd keeps one live snapshot per window**: an older snapshot of the same window is
   `FailedPrecondition: a newer accessibility snapshot of this window exists`; a snapshot of another window does not
   expire it, and 30 s do not either. Element ids differ between snapshots. → refs are found again by role and name
   when their snapshot was replaced.
5. **Windows.** Ids are stable across title changes; a handle without its epoch works; a gone window is `NotFound`, a
   stale epoch `FailedPrecondition`. `zOrder`: lower is closer to the front. LaunchApp by `executable` waits its
   whole `waitForWindow` for single-instance apps (xfce4-terminal hands the window to its server process); by
   `appId`/`name` it answers at once with the app's windows. `Open {path}` of a `.md` file opened nothing (no handler);
   `Open {url}` used Firefox; `.html` files go to Chromium.
6. **Input.** `typeText` presses Enter for `\n`; 1,000 characters type in about 16 ms. Click `count:3`, click and down/up
   without a position, `press{modifiers, repeat}` all work. Scroll `deltaY > 0` scrolls down; the default unit equals
   `SCROLL_UNIT_LINE`.
7. **Settling.** 320 px JPEG thumbnails without the cursor were identical 20 times in a row over 2.4 s with a blinking
   terminal caret (no tolerant compare, no `sharp`, needed); one takes about 6 ms.
8. **Guest tools.** `xdotool`, `wmctrl`, `xdg-open`, `firefox`, `chromium`, `thunar`, `xfce4-terminal`, `python3` (with
   GTK bindings) and ImageMagick (`import`, `convert`) are there; `pdftotext`, `tesseract`, `gtk-launch`, `mousepad`
   and `code` are not. ImageMagick captures and scales a region to 1280×800 in about 48 ms (zoom). The display cannot
   be made larger than 1280×800 (`xrandr --fb` refuses), so scaled coordinates are covered by unit tests.
9. **The SDK path** (read from the 2.1.293 binary and the SDK): Claude Code puts `{"claudecode/toolUseId": id}` into
   every MCP `tools/call` request's `_meta`, for SDK servers too, and the SDK hands the JSON-RPC message to the
   in-process server unchanged, so a handler finds its tool_use id in `extra._meta`. MCP tools without `readOnlyHint`
   run one at a time, in order.

## Measured through the `pc` tools (`npm run test:pcs`, guestApi.int.ts)

| Step | Result |
|---|---|
| A batch `left_click` + `type` + `key Return`, settled screenshot at the end | 302 ms |
| `open` Firefox on a local page (cold start) to its window | 1.2–1.6 s |
| `wait_for` text on that page | 0.2 s |
| `ui text` of the page | 839 characters (vs 1,334 image tokens for a screenshot) |
| `ui tree` of Thunar (interactive) | 2,703 characters |
| Background job exit to `onJobExit` | 1,008 ms for a `sleep 1` job |

## Tool definitions

`measure.ts`: 31 tools, 20.5k characters of name, description and JSON schema, about 5.7k tokens at 3.6 characters a
token (V1: 20 tools, about 2.6k). The biggest are `grep` (≈580), `bash` (≈530), `ui` (≈440) and `read` (≈360).
