# S6: Lume macOS PCs (2026-10-09)

**Result: PASS with changes.** A notarized Lume 0.6.1 runs as MineVibe's own `lume serve` child (loopback only), pulls
`macos:26` once into MineVibe's storage, clones it per PC in under a second, and boots clones with a read-only `setup`
share carrying our token, read-write Vault shares, VNC off. spacesd answers on `<vm-ip>:3211` with our token only.
Screenshots, input, spawn, the BGRA stream and path-identical Vault symlinks work. A third macOS VM is refused by
Virtualization. Two surprises change the design: the guest's virtio-fs client **caches host files** (host edits are
stale or unreadable in the guest until a purge or remount), and Lume's **VM status is stale after a guest-side
shutdown** and never reports why a start failed. Both are handled in the driver (below and PLAN §8.7).

Host: MacBook Pro M5 Pro, 18 cores, 48 GiB, macOS 27.0.1 (26A434). Guest: macOS 26.5.2 (25F84).

## Setup

| Step | Result |
|---|---|
| Lume release | `lume-0.6.1-darwin-arm64.tar.gz`, 6 112 964 B, sha256 `2675b798…f1bad8`, equal to the GitHub asset digest and the release's `release-manifest.json`. Pinned in `packaging/vendor.lock.json` (`lume`). |
| Signature | `lume.app`: `Developer ID Application: Cua AI, Inc. (YCK386LBJ7)`, hardened runtime, **notarization ticket stapled**; `codesign --verify --deep --strict` valid; `spctl -a -t exec`: accepted, `source=Notarized Developer ID`. Entitlements: `com.apple.security.virtualization`, `com.apple.vm.networking` (+ `embedded.provisionprofile`). Never re-signed. |
| Install | Extracted byte-identical to `~/Library/Application Support/MineVibe-dev/lume/install/0.6.1/lume.app` (outside `~/Documents`, TCC). Every file compared with the tarball: identical. |
| `lume serve` | `serve [--port] [--mcp]` only: no `--storage`, no host option. It **binds 127.0.0.1** (`lsof`). Storage, cache and telemetry come from `$XDG_CONFIG_HOME/lume/config.yaml` (`vmLocations: [{name: minevibe, path: …/lume/vms}]`, `cachingEnabled: false`, `telemetryEnabled: false`) plus `LUME_TELEMETRY_ENABLED=0`; every API call passes `storage: "minevibe"`. |
| Serve output | Must go to a **file**, not a pipe: with a pipe Node stopped draining, the serve blocked on a log write and stopped answering (first attempt). |
| Image | `macos:26-20261003-a7b1e34` (= `macos:26` today), manifest `sha256:d6d864fe6bba6ada8b2e5cd9d7f1ba4f64b1e5ca8a2ef7edc1d1530e356437df`. Lume writes the pulled digest to `<vm>/.manifest-digest`, so the pin is checked locally after a pull. |

## Numbers

| Step | Result |
|---|---|
| Pull (`POST /lume/pull`, async) | 23 825 217 508 B (22.2 GiB) in **314 s** (avg 76 MB/s, peak 114 MB/s); 300 chunks reassembled into `disk.img` (150 GiB sparse, 28.6 GiB allocated). Progress is visible with `GET /lume/vms/<name>`: `status: "pulling"`, `downloadProgress` (%), `downloadedBytes`, `totalBytes`. |
| Clone (`POST /lume/vms/clone`) | < 1 s (APFS clonefile); a clone gets a new `machineIdentifier` and MAC address. |
| Configure (`PATCH /lume/vms/<name>`, stopped) | cpu 4, memory 8 GB, display 1280x800: instant. The VM's display is then 1280x800, but a fresh clone's guest starts in a 1024x768 mode (seen in M9); the driver switches it once (it persists). |
| First boot of a fresh clone | IP after 10.4 s, spacesd SERVING after **26.8 s**. |
| Warm start (`POST /lume/vms/<name>/run`) | answers 202 at once; IP after 4.2 s; SERVING after **16.7–18.3 s**. |
| Stop (`POST …/stop`) | **6.3 s**: a hard power-off (VZ `stop`) plus Lume's fixed 5 s "lock clearing" wait. |
| Graceful stop | `sudo shutdown -h now` in the guest: the VM ends 12 s later. |
| Disk | Base 28.6 GiB allocated; clones share its blocks (du counts each clone as ~29 GiB). The whole spike (base + three booted clones) used 31.6 GiB of real disk (`df`). |
| Host RAM | a running 8 GiB guest: 3.4 GB RSS after boot (lazily allocated). |
| spacesd | transport `grpc` (Linux: `grpc-web`); features include `a11y`, `windows`, `desktop_stream`, `pty`. |
| JPEG screenshot | **p50 282 ms** at 1280, 277 ms at 640 (Linux: 9 ms): capture-bound, so the visible tier gets ≈ 3 fps at most. |
| BGRA stream | `openMedia` 111 ms; **23.6 fps** while typing, 4.1 MB per 1280x800 frame. |
| Input | `typeText` of 24 characters incl. `é à #$%`: 1.1 s, typed back exactly; Enter works; `hotkey(KEY_META, q)` quits Terminal (Cmd = `KEY_META`). |
| Auth | our token: SERVING; a wrong or missing token: `CuaError.Unauthenticated` (same as Linux). |

## The guest

- User `lume` (uid 501, admin), home `/Users/lume`, autologin; spacesd is a LaunchAgent (`com.trycua.spacesd`) in the
  GUI session. `start-spacesd.sh` takes the token from `/Volumes/My Shared Files/setup/env-token` **at every start**
  (then `/etc/cua/env-token`, then the kept `~/.cua/spacesd/token`), so a per-start token works. Without any token it
  would start in `--insecure-bootstrap`; the setup share always exists, so that never happens.
- `sudo` needs the default password `lume`; the driver installs `/etc/sudoers.d/minevibe` once (NOPASSWD for `lume`,
  `env_keep` of `MV_TAG MV_CALL MV_MIRROR`), checked with `visudo -c`. Remote Login is off, nothing but spacesd listens
  (`*:3211`), screen saver off, display sleep off; automatic update checks are on and stay on
  (`softwareupdate --schedule off` exits 0 without effect on macOS 26, and the preference file needs Full Disk Access;
  DEBT).
- Tools: `/bin/bash` 3.2, BSD userland (`stat -f`, no `/proc`, no `setsid`), `sha256sum` (GNU format), `jq`, git, Python
  3.9 and Swift from the Command Line Tools. No Homebrew, Node or ripgrep: the driver installs a pinned ripgrep
  (15.2.0, `vendor.lock.json`) from the setup share.
- spacesd's children run with **umask 077**: files an agent creates are 0600 on the host unless the PcApi prefix sets
  `umask 022` (it does).
- `ps -axwwE` shows the environment of the user's processes (and of every process as root), which replaces Linux's
  `/proc/<pid>/environ` for the tag sweep. `sudo --preserve-env=…` works.

## Shares (the Vault, the Codex, `setup`)

- Every share appears at `/Volumes/My Shared Files/<name>`, where `<name>` is the **last path component of the host
  path as given**. Two folders with the same basename become `dup` and `dup (2)`. A **symlink** given as the host path
  names the share and serves its target, so the driver passes `<lume>/shares/<vm>/links/<unique name>` links and never
  depends on Lume's de-duplication.
- Read-only shares refuse writes as `lume` and as root (`Operation not permitted`). Guest writes land on the host at
  once, owned by the host user; `chmod` carries over. A share under `~/Documents` (TCC-protected) worked when the serve
  ran under this terminal's TCC grant; inside MineVibe.app that is still to be checked (DEBT).
- **Path identity**: `sudo mkdir -p <parent>` + `sudo ln -s "/Volumes/My Shared Files/<name>" <host path>` gives agents
  the host's paths; `pwd -P` (and anything that resolves links) shows `/Volumes/My Shared Files/<name>`.
- **Host edits are not coherent in the guest** (AppleVirtIOFS caches them):

  | Host change after the guest read the file | Guest view |
  |---|---|
  | rewrite in place, same size | old content for > 20 s |
  | rewrite in place, longer | new size, old bytes plus NULs |
  | replace by rename (new inode), or delete + create | `No such file or directory` although `ls` lists it |
  | new file | visible at once |
  | `sudo purge` in the guest (0.18–0.22 s) | repairs in-place rewrites, not renames |
  | unmount + `mount_virtiofs com.apple.virtio-fs.automount` (0.29 s) | repairs everything |

  Host edits also fire no kqueue events in the guest. So MineVibe watches each macOS PC's Vault folders on the host
  (FSEvents) and, before the next PcApi file or shell call, refreshes the guest's view: `purge`, then a remount when
  nothing holds the share busy (PLAN §8.7).

## Lifecycle and limits

- **Third VM**: `POST …/run` still answers 202; `GET` shows `running` for a moment, then `stopped`. The reason appears
  **only in the serve log**: `Failed in VM.run … The number of virtual machines exceeds the limit. The maximum
  supported number of active virtual machines has been reached.` The driver reads its serve log after a failed start
  and maps that line to `macos_slots_full` (another app's macOS VMs count against Apple's limit too).
- **Stale status**: after a guest-side shutdown (or crash) the serve logs `VM lifecycle ended name=<vm>`, but `GET`
  keeps saying `running` (minutes, until a `POST …/stop`, which answers 400 "not running" and resets it). `GET` can
  also take seconds while a VM starts (4.1 s seen) and once took 10 minutes after such a shutdown, so every API call
  has a deadline and the driver treats the log line as the truth.
- `lume serve` on SIGTERM exits within 3 s and its VMs die with it (hard). VMs started through the API live in the serve,
  so they never outlive it; MineVibe stops them gracefully first.
- Isolation: the guest cannot reach the 127.0.0.1-bound serve (via its gateway 192.168.65.1 nor otherwise); host ports
  bound to `0.0.0.0` stay reachable (as in S5). The NAT subnet was 192.168.65.0/24 here; vmnet allocates it next to
  the `container` networks.
- `sessions.json` in the VM folder records the serve pid, start time and the shared directories of the run (Lume's own
  status source); `config.json` holds cpu, memory, display, MAC.

## ShellMirror on macOS

A `.terminal` settings document (`CommandString`, `RunCommandAsShell`, `shellExitAction 0`, `WindowTitle "Shell: ada"`)
opened with `open` gives a titled Terminal window running the tail in 0.7 s. Killing the tail (found by its
`MV_MIRROR` environment with `ps -E`) closes the window by itself, with no Apple events. A `.command` file instead
leaves a `[Process completed]` window, and `osascript` from spacesd's processes would need an Automation consent.

## Scripts

`lib.mjs` (paths, serve API), `serve.mjs` (the serve child, log to a file), `vm.mjs` (clone/set/run/wait/stop/get),
`probe.mjs` (auth, caps, screenshots, input, media, loopback, shell, sudo), `type.mjs`, `g.mjs`, `coherence*.mjs`
(share coherence), `shares.mjs` (share names, symlink roots, stop/start timing), `third.mjs` (Apple's limit),
`shutdown.mjs`, `mirror*.mjs` (ShellMirror), `tools.mjs` (BSD tool checks), `lume.sh` (the dev Lume CLI).

M9 debugging tools on the server's own code: `m9-hold.ts` boots one macOS PC through PcManager and holds it until
`out/m9-hold.stop` exists; `vmsh.mjs <vm> '<script>'` runs a script in any running MineVibe VM; `m9-input.mjs`,
`m9-ops.mjs`, `m9-router.ts`, `m9-mirror.ts`, `m9-open.ts`, `m9-display.ts`, `m9-shot.mjs` probe input, ShellMirror,
`open`, the display switch and the screen of the held PC; `m9-api.ts` makes raw serve API calls; `m9-clean.ts` removes
the VMs those tools and test runs left (`minevibe=pc-hold`, `pc-dbg`, `pc-test-*`); `setup-check.ts` runs the guest
setup and refresh scripts on a spike VM; `display.js` is the JXA display switch.

## Found while building M9 (2026-10-09)

These follow-ups came out of the driver and `npm run test:pcs` (`macPc.int.ts`); PLAN §8.7 has the design.

- **No key or button down/up on macOS.** spacesd's macOS driver answers `CuaError.Unsupported` ("separate key down/up
  is not available through the macOS driver tools; use press or hotkey", and the same for buttons: "use click or
  drag"). `press` with modifiers, `hotkey`, `typeText`, pointer `move`, `click` (with a count), `scroll` and `drag`
  (any button, modifiers) work. The InputRouter turns a macOS PC's downs and ups into presses, clicks and drags.
- **`GET /lume/vms?storage=…` answers 404.** The list takes no query and spans every location of the config; the
  driver lists `/lume/vms` and keeps `locationName == minevibe`. `GET /lume/vms/<name>?storage=…` works.
- **Display.** A fresh clone's guest starts at 1024x768 although its VM display is 1280x800. A Swift script switched
  it, but its first run in a fresh clone builds the Clang module cache (tens of seconds; the first boot took 66 s to
  `running`). JavaScript for Automation calling CoreGraphics through the ObjC bridge (`osascript -l JavaScript`, no
  Apple events, so no Automation consent) does the same in 0.35 s; create to `running` dropped to about 20 s.
- **Terminal keeps a closed window** in spacesd's window list as `WINDOW_STATE_HIDDEN` without `onScreen`: the
  ShellMirror window is gone from the screen once its tail dies, but `ListWindows` still names it. PcApi now treats
  hidden windows as off the screen.
- **`open --env`** gives an app MineVibe launches `MV_TAG`/`MV_CALL` (the seat's sweep kills TextEdit at stand-up),
  but only when `open` launches it: a window opened in an app that already runs (Terminal, Finder) is untagged.
- **The lifeline.** With MineVibe killed (`kill -9`), a supervised `lume serve` stopped itself 9 s later (no lease
  named a live process) and its VM with it.
