# S5: Apple `container` PC: result

Run on 2026-10-08. The verdict is **go, with changes**. Apple `container` 1.5.0 runs `ghcr.io/trycua/linux:24.04` on macOS 27.0.1 with XFCE and spacesd. Frames, input, spawn, Vault mounts, volumes and recreate all work. The guest cannot reach host loopback. Six findings change PLAN §8, §9 and §12:

1. The install root must not sit in a TCC-protected folder.
2. Fresh named volumes must be seeded and chowned before use.
3. `-v …:ro` is broken.
4. `health()` must be checked for `SERVING`.
5. The cursor is not composited into frames.
6. Guest-to-guest traffic is open.

apple/container#2275 did not occur on this machine. The one hang I hit had a different, deterministic cause (item 1).

## Environment

- macOS 27.0.1 (26A434), Apple M5 Pro, 18 cores, 48 GiB. The host was under heavy memory pressure during the run: about 17 GB in the compressor and under 1 GB free.
- Firewall on, stealth mode off. `com.apple.pfd` last exit was 0 and InternetSharing was running. That is the healthy state for #2275.
- Network: OrbStack <other-bridge> on <other-subnet>. The Mac's default route is <lan-if>, <lan-ip>. VPN tunnel interfaces are up.
- Node v24.20.0 (Homebrew). `@trycua/cua` 0.4.1 is pinned exactly, with `@trycua/cua-darwin-arm64` 0.4.1 and `@ubjs/*` 0.31.0-3; see `package-lock.json`.
- No `container` was installed beforehand. No apiserver was registered: `launchctl print gui/501/com.apple.container.apiserver` returned "Could not find service", and `which container` found nothing.

## Steps and outcomes

### 1. Pre-check
There was no `com.apple.container.apiserver` in `gui/501`, no `container` on PATH, no `/usr/local/bin/container`, no pkg receipt and no `~/Library/Application Support/com.apple.container`. It was safe to proceed.

### 2. Obtaining 1.5.0
- The GitHub API exposes a digest per asset. `container-1.5.0-installer-signed.pkg` is 118,045,087 bytes with digest `sha256:a24808cb202318fa1c3bbee0c6c6887fe1225fe899d7b687a0ddd939bd6573f8`. The download (3 s) matched it. **Put this in `packaging/vendor.lock.json`.**
- `pkgutil --check-signature`: "Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)", notarized, with a trusted timestamp.
- `pkgutil --expand-full`: the payload root is `Payload/` (`install-location="/usr/local"`, 34 files, 423 MB):
  - `bin/{container, container-apiserver, uninstall-container.sh, update-container.sh}`
  - `libexec/container/plugins/{container-core-images, container-network-vmnet, container-runtime-linux, machine-apiserver, k8s}/{bin/*, config.toml, resources/*}`
- I copied it with `ditto`. The per-file sha256 values match byte for byte (`out/container-root.sha256`).
- `codesign -dv`: **every Mach-O is signed with Developer ID Application: Apple Inc. - Containerization (UPBK2H6LZM), with hardened runtime (`flags=0x10000(runtime)`) and a secure timestamp. None are ad hoc.** Only `container-network-vmnet` and `container-runtime-linux` carry entitlements, and both have just `com.apple.security.virtualization`. `codesign --verify --strict` passes on all of them.
- `container --version` reports 1.5.0, release build, commit d265d66.

### 3. Start: blocker in the dev home, then success
- **First attempt (roots in `~/Documents/MineVibe/.minevibe-dev`): hung.** `system start … --timeout 120` printed "Testing access to container-apiserver..." and never returned. The outer 300 s timeout killed it, and `system stop` then hung at "checking if APIServer is alive" (killed after 60 s). Both are in `out/timeouts.log`.
- **Diagnosis: not #2275.** pfd and InternetSharing were healthy. The OS log shows the actual cause:
  - InternetSharing (a root daemon) has to read the client binary to compute the vmnet "security domain". It is denied by TCC, as `kTCCServiceSystemPolicyDocumentsFolder` with a forward error, because a root daemon cannot get a user prompt.
  - InternetSharing then logs `mis_network_get_security_domain: failed to get xpc client attributes`.
  - `container-network-vmnet` reports `failed to create vmnet network with status vmnet_return_t(rawValue: 1001)` and launchd restarts it every 10 s.
  - The apiserver's health ping never answers, so `--timeout` does not bound it.
  - Details are in `out/oslog-start-filtered.txt` and `out/diag-start-timeout.txt`.
- **Recovery:** I checked each `com.apple.container.*` label's `program` path with `launchctl print` (all under `.minevibe-dev`, so ours), then ran `launchctl bootout gui/501/<label>` on each. Everything was gone after that.
- **Second attempt (deviation from the brief):** both roots went into this session's scratchpad (`<session-scratchpad>/c/{root,app}`), with a byte-identical copy of the payload. That location is not TCC-protected. `system start` succeeded in **32 s**, including the first-time Kata 3.32.0 kernel download (vmlinux 6.18.35). `system status --format json` returned:
  - `paths.appRoot` = `<session-scratchpad>/c/app/`
  - `paths.installRoot` = `<session-scratchpad>/c/root/`
  - Both paths are realpaths with a **trailing slash**, so normalize before comparing.
  - `server.version` was 1.5.0. The default network is `192.168.64.0/24` with gateway `.1` and mode `nat`.
- From then on, every call got `CONTAINER_APP_ROOT`/`CONTAINER_INSTALL_ROOT` (`ct.sh` and `src/lib.mjs`). Every CLI call had a hard timeout. Only the two calls above timed out.

### 4. Image, vault and token
- `image pull --platform linux/arm64 ghcr.io/trycua/linux:24.04` took **124 s**: 1.11 GB fetched at 5–26 MB/s, then 2.8 GB unpacked (65,168 entries).
  - Index digest: `sha256:71dbd9f077adcbe5e27f2041391bac69afce8093f1ce757e02c9167495ac7dc4`.
  - arm64 manifest: `sha256:69fad5f0565e70d5c786d8f7d6c5175ca93c92eb5f1d538b9057db45f3714d01`, 1,188,080,636 bytes compressed, created 2026-10-06.
  - The app root took 5.3 GB after the pull, 4.1 GB of it the unpacked snapshot.
  - Cmd is `/opt/cua/desktop/entrypoint.sh`, with no ENTRYPOINT and no User.
- The vault is `spikes/s5-container/out/vault`, mounted path-identically.
- The token is `openssl rand -hex 24` in `out/token` (0600). It was never printed and was passed only through `CUA_ENV_TOKEN` in the environment, never in argv.

### 5. Run and boot
Working command (token in env only):
```sh
CUA_ENV_TOKEN=<token> container run -d --name mv-pc-s5 --cpus 2 --memory 4G --shm-size 2G -e CUA_ENV_TOKEN \
  -p 127.0.0.1:43211:3211 -v "$VAULT:$VAULT" -v mv-pc-s5-home:/home/cua -l minevibe=pc ghcr.io/trycua/linux:24.04
```
- **First run: the desktop never came up.** The volume `mv-pc-s5-home` was auto-created as an **empty, root-owned ext4 (with `lost+found`) that hides the image's `/home/cua`**. Unlike Docker, Apple `container` does not copy image content into new named volumes.
  - supervisord marked `desktop` (XFCE) and `audio` FATAL.
  - spacesd answered with `HEALTH_STATUS_NOT_SERVING`: filesystem DEGRADED ("/home/cua/.cua/spacesd is not writable") and desktop NOT_SERVING.
  - **`health()` resolves successfully even when the status is NOT_SERVING.**
- **Fix:** seed the volume once. This takes **about 1 s**, the time of one full VM run:
  ```sh
  container run --rm -v mv-pc-s5-home:/mnt/home ghcr.io/trycua/linux:24.04 \
    sh -c 'cp -a /home/cua/. /mnt/home/ && rm -rf /mnt/home/lost+found && chown 1000:1000 /mnt/home'
  ```
- **Warm boot with the seeded home:** `run` returns in **634 ms** and spacesd reports `HEALTH_STATUS_SERVING` (process, filesystem and desktop all SERVING) **2.9 s after `run` starts**. That run had the image, kernel and vminit cached.
  - The first-ever run took 13.4 s. It included a one-time vminit 0.47.0 fetch (66 MB, about 6 s) and about 4.6 s waiting on the TCC prompt below.
  - Display: 1280×800, scale 1. spacesd 0.5.3, transport `grpc-web`, protocol 1 rev 8.
- Loopback `-p 127.0.0.1:43211:3211` worked. `container-runtime-linux` listens on 127.0.0.1:43211 only. I did not need the container-IP fallback and did not try it, to avoid a Local Network prompt for this app.
- **Prompts I triggered** (the user allowed all of them; the OS log shows `authReason=2`, user consent):
  - TCC "Documents folder" for `container-apiserver` and for `container-network-vmnet` (first attempt, roots in `~/Documents`).
  - TCC "Documents folder" for `container-runtime-linux`, from the Vault under `~/Documents`. `container run` blocks until the user answers.
  - Local Network: "Allow “container-runti” to find devices on local networks?". It appeared at the first connection to the published port, even though no app was in the foreground. nehelper keys the grant by bundle id `com.apple.container.container-runtime-linux` plus the Mach-O UUID.
  - These grants are path- or UUID-based entries under System Settings > Privacy & Security (Files and Folders, Local Network). The user may want to remove the ones for `.minevibe-dev/container-root/…` and `<session-scratchpad>/…`.
  - The denied cases were not tested.

### 6a. Unary screenshots (`pc.screenshot`, 50 sequential calls after one warm-up)
| Format | p50 | p95 | Sequential fps | Bytes |
|---|---|---|---|---|
| JPEG q75 max 1280 (1280×800) | 8.9 ms | 12.6 ms | 106 | 36.8 KB |
| JPEG q75 max 960 | 6.0 ms | 8.8 ms | 160 | 22.2 KB |
| JPEG q75 max 640 | 4.3 ms | 6.5 ms | 209 | 11.2 KB |
| PNG native (20 calls) | 4.7 ms | 6.5 ms | 191 | 40.6 KB |
| JPEG 1280 + cursor, pointer moving | 8.9 ms | 10.8 ms | 110 | 36.8 KB |

Four parallel loops of 640 JPEGs reached **514 fps** in aggregate. Unary JPEG is cheap enough to serve as a 30 fps focus fallback.

### 6b. `openMedia`
- Options were `{maxFps:30, maxDimension, audio:false, disableVideo:false, requestJson:'{"codecs":["MEDIA_CODEC_BGRA"]}'}`. `MEDIA_CODEC_BGRA` is the right proto3 name; `codec()` then returns `"bgra"`.
- Session open took 8–30 ms and the first frame arrived 12–32 ms after open. Events were `hello` (rcdp v2, with capabilities including `frame_ack.v1` and `keyframe_on_attach.v1`) and `session_opened`.
- **BGRA, 1280×800:** every frame is a keyframe of 4,096,000 B (1280×800×4).
  - **Damage-driven.** Idle gave one frame on attach and then 0 fps. **Pointer movement alone gave 0 frames, because the cursor is not composited.**
  - Continuous damage (an xfce4-terminal printing in a loop) gave **29.0–29.4 fps** at the 30 cap, with a frame gap p50 of 34.5 ms and p95 of 36.6 ms. That is **about 119 MB/s** over the loopback forward.
  - At `maxDimension:640` (640×400, scale 0.5) it delivered 29.2 fps at 1,024,000 B per frame, about 30 MB/s.
- **Acks:** the guest viewer acks each frame with `send('frame_ack', {session_id, sequence, decode_queue})`. In the SDK that is `session.sendControl(JSON.stringify({type:"frame_ack", payload:{…}}))`. Without acks the rate was the same 29 fps, so acks aren't required at 30 fps, but sending them as the viewer does seems wise for backpressure.
- **H.264 (default):** software OpenH264 at 4000 kbps gave 29.4 fps under damage, about 7.8 KB per frame and 0.2 MB/s. A keyframe arrives about every 3 s when idle.
- **Cost, measured with continuous damage running.** The damage generator alone uses 1.10 guest cores; the extra cost of each consumer is shown below.

  | Consumer | Extra guest cores |
  |---|---|
  | BGRA 1280 @30 | +0.04 |
  | BGRA 640 @30 | +0.03 |
  | H.264 @30 | +0.20 |
  | JPEG 1280 @30 | +0.14 |
  | JPEG 960 @8 | +0.02 |
  | JPEG 640 @4 | +0.01 |
  | Idle desktop, no consumer | 0.01 cores total |

  On the host, BGRA 1280 @30 costs about 13% of a core in Node, about 4% in the `container-runtime-linux` port forwarder and about 2% extra in the VM. H.264 adds about 21% CPU in the VM.

### 6c. Input: 10 of 10 verified by effect (`src/input.mjs`, `out/input.json`)
- Spawning xfce4-terminal as `cua` produced a window (found via `WindowsService/ListWindows`), and the screenshot hash changed.
- `pointerJson({move:{position:{x,y}}})` moved the pointer, confirmed with `cursorPosition()`.
- Click to focus, then `keyboardJson({type:{text}})` plus `{press:{key:{named:"KEY_ENTER"}}}`. The shell wrote `s5-typed-42`.
- `{down:{key:{named:"KEY_SHIFT"}}}`, press `a`, `{up:…}`, press `b` gave "Ab".
- `hotkey(["ctrl","c"])` interrupted `sleep 20`.
- `{scroll:{position, deltaY:-10}}` then `+10`: the screen hash changed, then returned to the original.
- `{down:{button:"MOUSE_BUTTON_LEFT"}}`, 10 moves, then `{up:…}` on the title bar moved the window by exactly the drag delta (105,129 → 255,229).
- `rightClick` opened a context menu and `press("escape")` closed it. The clipboard round-trip worked.
- Delivery is reported as `DELIVERY_FOREGROUND` ("x11 XTest into the focused window").

### 6d. Spawn and exec in the Vault (`src/spawn.mjs`, `out/spawn.json`)
- `run({program, args, env: Map, stdin:false, user:"cua", cwd: VAULT, timeoutMs})` gave uid 1000(cua) with cwd at the path-identical vault. A file written there **appears on the host immediately, owned by the host user (501:staff) with mode 644**.
- **spacesd runs as `cua` and refuses `user:"root"` with `CuaError.PermissionDenied`.** `sh()` runs as `cua`. However, **`cua` has passwordless sudo** in the image.
- **Bind-mount behaviour:**
  - Ownership is synthetic: whatever uid asks sees itself as owner. `cua` sees 1000:1000 and root (via `container exec`) sees 0:0. That differs from the "root:root" claim in the docs.
  - `chmod` works and propagates (600 on the host). `chown` fails with EPERM.
  - Symlinks work, and so do `git init` and `git commit`.
  - `O_CREAT` with mode 0200 fails with EACCES but **still leaves a 0-byte `--w-------` file** on the host (#1344).
  - Host edits are visible in the guest, but **guest inotify gets no event for them** (#141 confirmed; nothing within 4 s).
- **Spawn API surface:**
  - `spawn(cmd)` returns a `SpacesdProcess` with `pid()`, `tag()`, `nextEvent()` (kind, offset, data, exit), `detach()`, `wait()`, `signal("term")`, `kill()` (SIGKILL), `writeStdin`, `writePty`, `resize` and `closeStdin`.
  - `attach(pid | undefined, tag, ReplayMode.All.new())` reattached by tag and replayed the output.
  - `timeoutMs` ends a process with SIGTERM and sets `exit.timedOut = true`.
  - `pty: {cols, rows}` plus `writePty` gives an interactive bash. `cd /tmp` inside one PTY persists for that session only.
  - Exit info has the shape `{code?, signal?, timedOut, error?, success}`.

### 6e. Read-only mounts (`out/readonly.txt`)
- **`--mount type=bind,source=$V,target=$V,readonly` works:** the guest mount shows `ro` and writes fail with EROFS. A nested rw bind inside a ro bind also works.
- **`-v SRC:DST:ro` is broken in 1.5.0 when DST has more than one path component.** It silently creates a **read-write** mount at `DST` + `"o"`; for example `-v $V:$V:ro` mounted rw at `…/vaulto`. A write there landed in the host folder.
  - It works only for single-component targets such as `/data`.
  - `-v SRC:DST:readonly` is silently ignored and gives rw.

### 6f. Named volumes and recreate (`persist.sh`, `out/persist.txt`)
| Step | Time | Result |
|---|---|---|
| Write `/home/cua/persist.txt`, then stop | 1.56 s | — |
| Start | 0.68 s | spacesd SERVING 1.8 s after start |
| Check marker after stop/start | — | present |
| Stop + delete | 0.34 s | — |
| Seed the overlay volume `mv-pc-s5-nm` (chown 1000) | 1.15 s | — |
| Re-run with the same home volume, plus `-v mv-pc-s5-nm:$V/node_modules` | 0.68 s | SERVING at 2.97 s, **marker present** |

- **Recreate keeps volumes.**
- The overlay mounts as ext4 over the virtiofs path. Writes by `cua` stay in the volume, and **the host only gets an empty `node_modules/` directory** as the mountpoint.
- Named volumes default to **512 GiB sparse ext4** (`sizeInBytes 549755813888`). The root filesystem is also 504G sparse. The IP changes on recreate (.4 → .18).

### 7. Isolation (`src/isolation.mjs`, `out/isolation.json`; probes run from the guest as `cua`)
The guest is 192.168.64.18/24, its gateway and DNS server are 192.168.64.1, and the host bridge is bridge101 = 192.168.64.1.

| Target | Result |
|---|---|
| 192.168.64.1:47999 (host server bound to 127.0.0.1) | **refused** |
| 192.168.64.1:47998 (host server bound to 0.0.0.0) | **reachable**; the host saw the peer as 192.168.64.18 |
| host LAN <lan-ip>:47998 (0.0.0.0) | **reachable** |
| host LAN <lan-ip>:47999 | timed out |
| 192.168.64.1:43211 and LAN:43211 (our published spacesd, bound to 127.0.0.1) | refused / timed out |
| 192.168.64.1:22 | refused |
| `host.docker.internal`, `host.containers.internal`, `gateway.docker.internal`, `host.lima.internal` | do not resolve |
| a second container's IP, 192.168.64.19:8080 | **reachable (guest to guest)** |
| https://example.com | reachable |

Node was already allowed by the application firewall, so this run did not cover a firewall-blocked app. The servers were closed afterwards and the peer container was deleted.

### 8. Resources
- `inspect` shows `resources: {cpus: 2, cpuOverhead: 1, memoryInBytes: 4 GiB}`. **The guest sees 3 vCPUs** (`nproc` = 3) and 4047 MiB of RAM.
- `container stats`: about 1% CPU, 612–765 MiB used of 4 GiB, and 89–91 pids when idle.
- On the host, the `com.apple.Virtualization.VirtualMachine` XPC process had a **`phys_footprint` of 1.22–1.26 GB** (top MEM about 1.2 GB) for an idle XFCE PC. Stopping the PC raised host free memory from 651 MB to 2088 MB.
- Service processes: apiserver 24 MB, network-vmnet 11 MB, core-images 22 MB, machine-apiserver 10 MB, runtime-linux 22 MB RSS. The apiserver also listens on UDP 127.0.0.1:2053 for DNS.

### 9. Cleanup (`out/cleanup.txt`)
- `mv-pc-s5` was stopped and deleted. Kept: the volumes `mv-pc-s5-home` and `mv-pc-s5-nm`, and the image `ghcr.io/trycua/linux:24.04` (71dbd9f077ad).
- These live in the scratchpad app root, which is temporary, about 5.3 GB.
- `system status` showed our appRoot, so I ran `system stop` (0 s). Afterwards `launchctl print gui/501/com.apple.container.apiserver` reported "Could not find service", no `com.apple.container.*` agents remained, no container processes were running, and `system status` said "not running and not registered".
- The other VZ VirtualMachine process (pid 92724, 2.5 h old) is not ours and was not touched.
- `@trycua/cua`'s `embedded()` printed a telemetry notice and created `~/.cua/telemetry/notice_shown`. I removed that directory, since it held only that marker. Later runs used `CUA_HOME=out/cua-home`, `CUA_TELEMETRY=0` and `DO_NOT_TRACK=1` (`src/env.mjs`).

## Leftovers to know about
- `.minevibe-dev/container-root/` is the byte-identical install root, 423 MB. It is unusable in place because of the TCC issue, so move it out of `~/Documents` to reuse it.
- `.minevibe-dev/container/` is the stale app root from the failed start. It holds only plists.
- `.gitignore` already covers `.minevibe-dev/` and `spikes/**/out/`, so I did not change it.
- The TCC and Local Network grants listed in step 5 remain in System Settings.

## Files
- `ct.sh`: the timeout-wrapped CLI. Roots can be overridden with `MV_CT_INSTALL_ROOT`/`MV_CT_APP_ROOT`; the defaults point at this session's scratchpad.
- `src/lib.mjs`: Node `ct()` (spawn plus SIGKILL timeout) and `connectPc()`.
- `src/env.mjs`: cua env.
- Test scripts: `src/boot.mjs`, `frames.mjs`, `input.mjs`, `spawn.mjs`, `isolation.mjs`, `cost.mjs`, `hostcost.mjs`, `probe-*.mjs`, `persist.sh`.
- Raw results are in `out/`.

## `@trycua/cua` 0.4.1 API as used
```js
import { embedded, ImageFormat, ReplayMode } from "@trycua/cua";      // set CUA_HOME / CUA_TELEMETRY=0 first
const pc = await embedded().spacesd("http://127.0.0.1:43211", token, { signal });   // SpacesdClientLike
JSON.parse(await pc.health())        // {status:"HEALTH_STATUS_SERVING", components:[process, filesystem, desktop]}; resolves when NOT_SERVING too
await pc.capabilities(); JSON.parse(await pc.displays()); pc.transport() /* "grpc-web" */; pc.jsonMethods()
await pc.screenshot({ format: ImageFormat.Jpeg, quality: 75, maxDimension: 1280, includeCursor: false }) // {image: ArrayBuffer, width, height, scale, screenshotId}
const s = await pc.openMedia({ maxFps: 30, maxDimension: 0, audio: false, disableVideo: false,
  requestJson: '{"codecs":["MEDIA_CODEC_BGRA"]}' }, { onFrame(f /* {sequence, codec, keyframe, width, height, data, ...} */) {}, onEvent(e /* {kind, json} */) {} });
s.codec(); s.sessionId(); s.sendControl(JSON.stringify({ type: "frame_ack", payload: { session_id, sequence, decode_queue: 0 } })); s.stats(); await s.close();
await pc.pointerJson(JSON.stringify({ click: { position: { x, y }, button: "MOUSE_BUTTON_LEFT", count: 1 } }));  // also move{position,duration}, down/up{position?,button}, drag, scroll{position,deltaX,deltaY,unit}
await pc.keyboardJson(JSON.stringify({ down: { key: { named: "KEY_SHIFT" } } }));  // type{text}, press{key:{named|character},modifiers,repeat}, hotkey{keys:[Key]}, up{key}
await pc.moveTo(x, y); pc.click/doubleClick/rightClick/drag/scroll(dx,dy); pc.typeText(t); pc.press("enter"); pc.hotkey(["ctrl","c"]); pc.cursorPosition(); pc.get/setClipboard()
await pc.run({ program, args, env: new Map(), stdin: false, user: "cua", cwd, timeoutMs, tag, pty: { cols, rows } }) // {exit:{code,signal,timedOut,error,success}, stdout, stderr, pty}
const p = await pc.spawn(cmd); p.pid(); p.tag(); await p.nextEvent(); await p.detach(); await pc.attach(undefined, tag, ReplayMode.All.new());
await p.signal("term"); await p.kill(); await p.wait(); await p.writePty(buf); await p.writeStdin(buf);
await pc.callJson("/cua.env.v1.WindowsService/ListWindows", "{}");  // any unary RPC (85 listed by jsonMethods())
```

## Recommended changes to PLAN (not applied)

**§8.1 `container` handling**
1. **Keep both roots out of TCC-protected folders**: `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive and removable volumes.
   - InternetSharing (root) must read `container-network-vmnet` to create the vmnet network, and TCC blocks it there. The result is `vmnet_return_t 1001`, and the apiserver ping hangs past `--timeout`.
   - `/Applications/MineVibe.app/Contents/Helpers/container` and `~/Library/Application Support/MineVibe/container` are fine.
   - The stub should refuse to run, or offer to move the app, when the bundle sits in a protected folder.
   - Add this to the `engine_down` diagnosis (log line `mis_network_get_security_domain failed`), next to #2275 (pfd).
2. **Seed every new named volume before first use**, for `-home` and for every overlay: `cp -a` the image's `/home/cua` (home only), `rm -rf lost+found`, then `chown 1000:1000`.
   - Apple `container` neither copies image content into volumes nor sets their ownership.
   - It's cheaper to do this in our own image: add an `/opt/cua/entrypoint.d` hook that seeds `/home/cua` from a skeleton when it is empty and chowns the overlay mountpoints. That avoids an extra seed run (about 1 s each) and covers volumes created later.
3. **Readiness means `health().status === "HEALTH_STATUS_SERVING"`**, not "health resolved". Map the per-component details (filesystem, desktop) to `booting%` and `error`.
4. **Fallback for a wedged apiserver:** `system stop` hangs too. Use `launchctl print gui/$UID/<label>` to check that the `program` is under our install root, then `launchctl bootout` each `com.apple.container.*` label. That is what fixed the hang here. Never boot out a label whose program is elsewhere.
5. **Normalize `paths.appRoot`/`installRoot`** before comparing them (realpath, strip the trailing `/`). `/tmp` comes back as `/private/tmp/…`.
6. **Read-only mounts: never use `-v …:ro`.** Always use `--mount type=bind,source=…,target=…,readonly`. After `run`, assert the mount table from `inspect` (or guest `mount`), because the CLI silently produces rw mounts at wrong paths.
7. **Run timeout:** the first `run` of a PC whose Vault is in `~/Documents`, `~/Desktop` or `~/Downloads` blocks on a TCC prompt ("container-runtime-linux would like to access…"). Give `run` at least 120 s and say in the UI why it's waiting.
8. **Timings for UX:**
   - Cold `system start` 32 s (kernel download). First `run` adds vminit (66 MB). Image pull 124 s.
   - Warm: `run` 0.6 s, SERVING at about 3 s. `stop` 1.6 s. `start` 0.7 s, SERVING at about 1.8 s. `delete` 0.3 s.
   - Recreate (resize) is therefore about 3–4 s.

**§8.2 Budget**
- Each container gets **`--cpus` + 1 vCPU** (`cpuOverhead: 1`). Count cpus + 1 against the CPU pool, or pass `--cpus` one lower.
- An idle 4 GiB PC already has a host footprint of about 1.2 GB, which grows to whatever the guest has touched and isn't returned. Keep budgeting by limits.
- Add a live check of free memory and compressor size: this host was at about 0.6 GB free with 17 GB compressed during the spike.

**§8.3 Vault**
- Replace the quirks line with what was measured:
  - Guest ownership is synthetic: each user sees itself as owner.
  - Files the guest creates are owned by the host user with the requested mode. `chmod` propagates; `chown` fails with EPERM.
  - Mode-0200 creates fail but leave a 0-byte file.
  - Host edits fire no inotify events.
  - git works on the mount.
- Overlay volumes leave an empty mountpoint directory on the host (`node_modules/`, `.venv/`, and so on), which is fine when those are gitignored.
- A Vault under `~/Documents`, `~/Desktop` or `~/Downloads` triggers a one-time TCC prompt attributed to `container-runtime-linux`. The grant is path-based, so a moved or updated app re-prompts.

**§8.4 Frames and input**
- The focus tier's BGRA path works: 29–30 fps, 4,096,000 B per frame, about 120 MB/s, about 13% of a core in Node, and almost no guest cost.
  - Frames are **damage-driven**: no frames when idle, and **no frames for pointer motion**.
  - MineVibe must draw the cursor itself, from `cursorPosition()` or pointer echo, and must not assume a frame cadence.
  - Send `frame_ack` per frame, as the guest viewer does.
- JPEG fallbacks are cheaper than expected (1280 q75 p50 is 8.9 ms), so the `sharp` fallback is likely unnecessary: unary JPEG at 1280 can feed 30 fps for about 0.14 guest cores.
- Use the measured input shapes: `position:{x,y}` and `key:{named|character}`, as listed above.

**§8.5 Security**
- **Proven:** guests cannot reach host loopback services, including the published spacesd ports. Services on 0.0.0.0 are reachable through 192.168.64.1 and the host LAN IP, so the bridge, `lume serve`, and anything else of ours must bind to 127.0.0.1. Verify `lume serve`'s bind address in S6.
- **New:** guest-to-guest traffic is open on 192.168.64.0/24, so every PC can reach every other PC's spacesd at :3211 and any dev servers.
  - Per-PC tokens are the only barrier, so keep them unique.
  - If cross-PC isolation matters, evaluate one `container network create` per PC (not tested here).
- `cua` has **passwordless sudo** in `trycua/linux:24.04`. spacesd refuses `user:"root"`, but agents can `sudo`. Decide whether the MineVibe image drops this.
- cua telemetry: set `CUA_TELEMETRY=0`, `DO_NOT_TRACK=1` and `CUA_HOME=<App Support>/MineVibe/cua` in Node's environment before loading `@trycua/cua`. Otherwise `embedded()` writes `~/.cua`.
- `-e CUA_ENV_TOKEN` keeps the token out of argv, but **`container inspect` shows it in plaintext** under `configuration.initProcess.environment`, and it sits in the container's config under the app root for as long as the container exists. Nothing was left in the app root after `delete`. Never log raw `inspect` output: redact `CUA_ENV_TOKEN`, as was done for `out/inspect-first-run.json`. A rotated token requires a recreate.

**§9.1 Bundle and vendor lock**
- The signed-pkg binaries are Apple **Developer ID with hardened runtime, not ad hoc**. Ship them byte-identical and never re-sign them. Local Network grants are keyed to bundle id plus Mach-O UUID, and Documents grants to the path.
- Bundle `bin/container`, `bin/container-apiserver` and `libexec/container/plugins/*`. Leave out `bin/uninstall-container.sh` and `bin/update-container.sh`. The k8s plugin was present but never exercised; whether `system start` works without it wasn't tested.
- Lock values: pkg sha256 `a24808cb…73f8`, plus the per-file sha256 values in `out/container-root.sha256`.

**§9.3 First run**
- Expect up to three prompts, attributed to Apple's helpers rather than MineVibe: Local Network for "container-runti", Documents for `container-runtime-linux` when the Vault is in a protected folder, and possibly the firewall.
- Pre-explain them in the progress window.

**§9.4 Dev loop**
- This repo lives in `~/Documents`, so in-repo `.minevibe-dev` cannot host `container` roots. Use `~/Library/Application Support/MineVibe-dev/{container,container-root}` (or similar) for `MINEVIBE_PC_RUNTIME=container`.

**§12.1 S5 row**
- Mark as done: bundled-root start and status, cua image boot, frames, input, spawn, mounts, volumes and recreate, and loopback isolation.
- Still open:
  - #2275 itself (not reproduced; pfd was healthy).
  - Behaviour when the Local Network or TCC prompt is denied.
  - Firewall-blocked apps bound to 0.0.0.0.
  - Per-PC networks for guest-to-guest isolation.
  - Starting without the k8s plugin.
