# S8 launcher: result

Date: 2026-10-08. Host: macOS 27.0.1 (Darwin 27.0.0), Apple M5 Pro, IPv4-only network. Node 24.20.0.
Run from a clean, temporary `MINEVIBE_HOME` with `npm run play` (the M1 launcher in `apps/server/src/launcher/`
and `apps/server/src/orchestrator/play.ts`).

## Verdict

| Question | Result |
|---|---|
| A clean dir becomes playable with one command | **Yes.** `npm run play` installs Java 25, Minecraft 26.3, Fabric 0.19.5 and the 11 locked mods, seeds options and configs, and launches the game in 15.5 s. |
| All 11 default mods + minevibe loaded by Fabric | **Yes** (`latest.log`, list below) |
| OpenGL backend forced | **Yes**: `Graphics backend forced to opengl by launch argument`, then `Using graphics backend OpenGL, using drivers: 4.1 Metal - 91.7` |
| `-XstartOnFirstThread` from the version JSON rule | **Yes** (an `os: osx` rule in 26.3's `arguments.jvm`; the launcher refuses to start without it on macOS) |
| options.txt keys effective | **Yes**: Minecraft rewrote options.txt on load and kept every MineVibe key |
| Quitting leaves no orphans | **Yes** for all three stop paths (below) |
| Re-run is fast and offline | **Yes**: installs verified in 92 ms, 0 network requests, game spawned 0.96 s after start |
| `@xmcl/installer` + `@xmcl/core` | **Partly.** The current releases are mis-published; the last consistent pair works for resolution, Fabric and arguments, but its downloader is not usable (see "xmcl findings"). The PLAN fallback ("hand-built classpath") was **not** needed. |

## Numbers

### Run 1: clean home

| Phase | Time | Downloaded |
|---|---|---|
| Bridge on a random loopback port + world loop | 16 ms | – |
| Java: Mojang `java-runtime-epsilon` 25.0.1, mac-os-arm64, 155 files sha1-checked, 205 links | 4.3 s | 104.7 MiB |
| Minecraft 26.3: version JSON, client jar, libraries, logging config, asset index 34, 5147 assets, all sha1-checked | 14.0 s | 588.7 MiB |
| Fabric 0.19.5 profile + 7 libraries (sha1-checked) | 0.4 s | 3.7 MiB |
| Mods: one `GET /v2/versions?ids=[…]`, 11 jars sha512-checked | 0.39 s | 8.0 MiB |
| Seed options.txt + configs | 0.44 s | – |
| **Start → JVM spawned** | **15.5 s** | **~706 MiB** |
| JVM spawned → resources loaded (title screen) | ~6 s | – |

Java, Minecraft+Fabric and the mods install in parallel, so the install phase is the slowest branch (14.6 s).

Disk after run 1: `game/` 643 MB (assets 474 MB, libraries 91 MB, versions 60 MB, mods 8.1 MB), `runtime/` 106 MB,
`Caches/mods` 8.1 MB (APFS clones of the same jars). JVM RSS at the title screen: 2.2 GB.

### Run 2: same home (idempotent fast path)

```
"timingsMs":{"bridge":9,"java":63,"minecraft+fabric":78,"mods":92,"install":92,"seed":430}
java.downloaded 0, minecraft.installed false, fabric.installed false, mods.downloaded 0, apiCalls 0,
options changed: [], configs: dynamic_fps.json:unchanged, entityculling.json:unchanged
```

Every check is a stat of the expected size against a completed-install marker (Java manifest, version JSONs,
asset index); mods are re-hashed (sha512 of 8 MB, cheap). No network at all. The 430 ms `seed` was reading
`world_version` out of the 41 MB client jar; it is now read only when options.txt does not exist yet, which brought
`seed` to 1 ms (third run, from the esbuild bundle: install 117 ms, seed 1 ms).

## latest.log (run 1)

```
[main/INFO]: Loading 67 mods:
	- badoptimizations 2.4.1
	- cloth-config 26.3.159
	- dynamic_fps 3.11.10
	- entityculling 1.11.2
	- fabric-api 0.162.0+26.3
	- fabricloader 0.19.5
	- ferritecore 9.0.0
	- immediatelyfast 1.17.1+26.3
	- java 25
	- lithium 0.26.2+mc26.3
	- minecraft 26.3
	- minevibe 0.1.0
	- moreculling 1.9.0
	- sodium 0.9.2+mc26.3
	- sodium-extra 0.9.4+mc26.3
	(+ 52 jar-in-jar children: fabric-api modules, mixinextras, cloth-basic-math, trender, …)
[main/INFO]: Loaded configuration file for Sodium: 37 options available, 0 override(s) found
[main/INFO]: Force-disabling mixin 'entity.framed_maps.MapItemSavedDataMixin' as rule 'mixin.entity.framed_maps' (added by mods [minevibe]) disables it and children
[Render thread/INFO]: Setting user: Player
[Render thread/INFO]: MineVibe loaded (client)
[Render thread/WARN]: Graphics backend forced to opengl by launch argument, in-game preferred graphics backend setting is ignored
[Render thread/INFO]: Initializing ImmediatelyFast 1.17.1+26.3 on Apple M5 Pro (Apple) with OpenGL 4.1 Metal - 91.7
[Render thread/INFO]: Using graphics backend OpenGL, using drivers: 4.1 Metal - 91.7
```

Expected noise with the offline profile (`--accessToken 0`): `Failed to fetch user properties` (HTTP 401) and
Realms `Failed to parse into SignedJWT: 0`. Both are harmless; multiplayer and Realms are disabled anyway.

The Lithium `framed_maps` override from our `fabric.mod.json` (Lithium#791 workaround) is confirmed active.

## The launch command (macOS, run 1)

```
<home>/runtime/java-runtime-epsilon/mac-os-arm64/jre.bundle/Contents/Home/bin/java
  -Xdock:name=MineVibe -XstartOnFirstThread -XX:StackShadowPages=32 --enable-native-access=ALL-UNNAMED …
  -Djava.library.path=<game>/versions/26.3-fabric0.19.5/26.3-fabric0.19.5-natives/java … -cp <114 libs + Fabric + client.jar>
  "-DFabricMcEmu= net.minecraft.client.main.Main "
  -XX:+UseCompactObjectHeaders -XX:+AlwaysPreTouch -XX:+UseStringDeduplication -XX:+UseZGC   (26.3 "default-user-jvm")
  -Xmx6144M -Dminevibe.bridgeFile=<home>/run/bridge.json -Dminevibe.parentPid=<node pid>
  net.fabricmc.loader.impl.launch.knot.KnotClient
  --username Player --version 26.3-fabric0.19.5 --gameDir <game> --assetsDir <game>/assets --assetIndex 34
  --uuid a01e3843e5213998958af459800e4d11 --accessToken 0 --versionType release --width 1280 --height 800
  --disableMultiplayer --graphicsBackend opengl
cwd = <game> (checked with lsof), stdin = an open pipe (lifeline)
```

- **`--graphicsBackend`** is the verified 26.3 flag: `net.minecraft.client.main.Main` declares
  `parser.accepts("graphicsBackend").withRequiredArg().withValuesConvertedBy(new EnumConverter<PreferredGraphicsApi>…)`
  (jopt-simple's `EnumConverter` matches enum names case-insensitively, so `opengl` → `OPENGL`).
  The options.txt key is `preferredGraphicsBackend`, saved as JSON (`"opengl"`).
- In 26.3, `PreferredGraphicsApi.DEFAULT.getBackendsToTry()` is `{gl, vulkan}`: unlike the third-party 26.2
  decompile cited in the research, the default already prefers OpenGL. MineVibe still forces it.
- 26.3's version JSON has a new `arguments.default-user-jvm` block (the vanilla launcher's default JVM flags).
  The launcher evaluates its rules and passes it, minus `-Xms2G -Xmx4G`; the heap is `-Xmx` from settings (6 GiB).
- `--clientId ${clientid}` and `--xuid ${auth_xuid}` have no value for an offline profile and are dropped.
- The 26.3 asset index has no `icons/minecraft.icns`, so no `-Xdock:icon`.
- Offline UUID = `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)` (checked against jshell).

## Shutdown and orphans

| Stop path | What happened | Exit | Left behind |
|---|---|---|---|
| Game closed (`kill -TERM <java>`, run 1) | JVM ran its shutdown hook and exited; Node closed the bridge, removed `run/bridge.json` and `run/lock` | 143 (the JVM's code, propagated) | no java, no node; `run/` empty |
| `SIGINT` to Node while playing (run 2) | `stopping the game (SIGTERM; it saves the world)` → JVM exit → bridge closed | 130 | no java, no node; `run/` empty |
| `SIGINT` to Node during a clean install | installs aborted through one `AbortController` | 130 after 28 ms | no `.part` files, `run/` empty |

A second stop request more than 2 s after the first escalates to SIGKILL; a duplicate Ctrl+C from the process group
plus tsx's relay is ignored. A `process.on('exit')` hook SIGKILLs the JVM whatever else happens to Node. No `claude`
process is started by `play` in M1 (the `claude` processes on the host were the user's own sessions).

## xmcl findings

1. **The current releases are broken on npm.** `@xmcl/installer@6.3.5` / `@xmcl/core@2.16.2` (and every 6.3.x)
   depend on `@xmcl/unzip@^2.2.0`, which was published with `"@xmcl/yauzl": "workspace:^*"` and `"main": "./index.ts"`
   (npm refuses to install it: `EUNSUPPORTEDPROTOCOL`). Even with that overridden, `@xmcl/installer` 6.3.x does
   `require("@xmcl/core/utils")`, which no published `@xmcl/core` 2.16.x ships. So the pins are the last consistent
   set: **`@xmcl/installer` 6.1.2, `@xmcl/core` 2.15.1, `@xmcl/unzip` 2.1.2** (2025-08), exact versions.
2. 6.1.2 pins `undici` 7.2.3 exactly, which has a high-severity advisory list. A scoped npm override moves it to
   **7.30.0** (`overrides["@xmcl/installer"].undici`), which makes `npm audit` clean for the launcher.
3. **xmcl's downloader is not used for files.** With undici 7.30, `@xmcl/file-transfer` 2.0.3 throws
   `errors.ResponseStatusCodeError is not a constructor` inside a `setImmediate` on any non-2xx response, which
   kills the Node process (it happened in the first attempt). Diagnosed further, its undici Agent also hit 10 s
   connect timeouts to `resources.download.minecraft.net` on this IPv4-only host (the name has AAAA records;
   `curl -6` fails, `curl -4` is fine), followed by `ChecksumNotMatchError`s. Every file is therefore streamed by
   MineVibe's own downloader on Node's built-in `fetch` (`.part` + size + sha1/sha512, retries, stall timeout),
   which installed all 5147 assets without a single failure.
4. What xmcl **is** used for: Mojang's version list (`getVersionList`, v2 manifest for the JSON's sha1), version
   resolution (`Version.parse`: inheritance, OS rules, natives, library paths), the Fabric profile
   (`installFabric`, Fabric's official `/profile/json`), and the command line (`generateArguments`, rule evaluation,
   classpath). The Fabric version id is xmcl's `26.3-fabric0.19.5`, not the official installer's
   `fabric-loader-0.19.5-26.3`.
5. Fabric's profile lists `sha1`+`size` for its libraries, but `@xmcl/core` ignores checksums on url-style entries,
   and the profile has **no checksum at all for `fabric-loader` itself**. The launcher rewrites the entries into
   Mojang's `downloads.artifact` form and fills the loader's sha1 from the Maven `.sha1` sidecar (HTTPS, same repo).

## Mods lock

`packaging/mods.lock.json` was filled from one `GET https://api.modrinth.com/v2/versions?ids=[16 ids]` (primary
file only). The 11 defaults match PLAN §10 version ids, all `release`. Opt-ins: Iris 1.11.7 (vTN4NRGW), C2ME
0.4.2-alpha.0.90 (ODMLK8M9, alpha), Chunky 1.5.3 (4Eotm6ov), spark 1.10.187 (e3hsPc1o), Mod Menu 21.0.0 (kyy7dbrZ).
Double-checked afterwards: every jar's size and sha512 match the lock, and each `modId` equals the `id` in the jar's
`fabric.mod.json` (all 16, opt-ins downloaded to a scratch dir for this). Seven sha512s also match the research
notes. Mod Menu's Modrinth dependency `eXts2L7r` (Text Placeholder API) is bundled jar-in-jar.

## Seeded configs (after the game loaded them)

- `config/dynamic_fps.json`: `{"ignore_initial_click":"disabled","idle":{"timeout":0,"condition":"none"},"states":{"unfocused":{"frame_rate_target":30}},"download_natives":false}`.
  Dynamic FPS stores only fields that differ from its defaults and fills the rest from its
  `default_config.json` on load (`Serialization.addMissingFields`), so a partial file is its native format.
- `config/entityculling.json`: `{"configVersion": 9}`. Its `Config` class has field initialisers, so Gson keeps
  the defaults for missing fields. An existing file with an older `configVersion` is left alone for its upgrader.
- Merge rule: write when absent; otherwise add missing keys only (deep), never replace a value; unparseable files
  are left untouched.
- options.txt: forced every launch `pauseOnLostFocus:false`, `preferredGraphicsBackend:"opengl"`,
  `onboardAccessibility:false`, `tutorialStep:none`, `skipMultiplayerWarning:true`, `joinedFirstServer:true`,
  `realmsNotifications:false`; seeded only when absent `narrator:0`, `autoJump:false`. A new file starts with
  `version:<world_version>` (5023 for 26.3, read from the client jar's `version.json`) so Minecraft's options
  datafixers do not run over our values. Every other line is kept byte for byte.

## Open issues

- The mod does not yet watch `-Dminevibe.parentPid` or stdin EOF. If Node is SIGKILLed, the JVM survives until it
  is closed (Node's exit hook cannot run on SIGKILL). The lifeline is in place on the Node side.
- With the M0 mod skeleton the game stops at the vanilla title screen; "lands in the world" needs BootScreen.
- The Mojang runtime is never refreshed once installed (the fast path makes no network call); a newer 25.x from
  Mojang is picked up only after deleting `runtime/`.
- `dist/main.mjs` grew to 4.3 MB because the bundle includes `@xmcl/installer` (Forge/Optifine code, an HTML parser,
  undici) even though only a few functions are used.
