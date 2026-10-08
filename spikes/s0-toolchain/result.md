# S0 toolchain: result

Date: 2026-10-08. Host: macOS 27.0.1 (Darwin 27.0.0), Apple Silicon (aarch64). The only system
JDK is Temurin 17.0.20.1 (`/Library/Java/JavaVirtualMachines/temurin-17.jdk`). Nothing was
installed system-wide.

## Verdict

| Question | Result |
|---|---|
| Can Gradle auto-provision JDK 25 for its daemon? | **Yes**, with one workaround (below) |
| Does `./gradlew build` (Loom 1.18.3, Gradle 9.7.1, MC 26.3) succeed? | **Yes**: compiles main, client, gametest and test source sets, runs the JUnit test, and skips GameTests without the EULA flag |
| Does `./gradlew genSources` work on unobfuscated 26.3? | **Yes**: Vineflower, 5037 common + 2264 client-only classes |
| Does an empty mod boot 26.3 via `runClient`? | **Not run.** The task said not to open a window. The user should run it once (see Open issues). |

The fallback (`brew install --cask temurin@25`) is **not needed**.

## Versions (verified, not assumed)

| Component | Planned | Verified | Source |
|---|---|---|---|
| Gradle | 9.7.1 | **9.7.1** (released 2026-08-19; not broken). Current is 9.8.1. | `services.gradle.org/versions/all` |
| Gradle 9.7.1 dist SHA-256 | - | `acd53f1e…f804d20a` (pinned as `distributionSha256Sum`) | `gradle-9.7.1-bin.zip.sha256` |
| Gradle wrapper jar | from fabric-example-mod@26.3 | SHA-256 `7a9ce74c…64262c5d` = official 9.7.1 wrapper checksum | `gradle-9.7.1-wrapper.jar.sha256` |
| Fabric Loom | 1.18.3 | **1.18.3** (latest release; plugin marker `net.fabricmc.fabric-loom`) | `maven.fabricmc.net/net/fabricmc/fabric-loom/net.fabricmc.fabric-loom.gradle.plugin/maven-metadata.xml` |
| Fabric Loader | 0.19.5 | **0.19.5** (latest) | `maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml` |
| Fabric API | 0.162.0+26.3 | **0.162.0+26.3** (newest `+26.3`; the overall latest is 0.162.2+26.4) | `maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml` |
| foojay-resolver-convention | - | 1.0.0 (latest) | Gradle plugin portal |
| fabric-loader-junit | - | 0.19.5 (JUnit BOM 5.10.0) | Fabric maven |
| Daemon JDK | 25 | **Temurin 25.0.4.1+1** (build 25.0.4.1+1-LTS, 2026-08-18) | provisioned (below) |
| Perf-mod versions for `recommends` | PLAN 10 | all 10 Modrinth version ids resolve to the plan's version numbers | `api.modrinth.com/v2/versions?ids=[…]` (metadata only, no jars downloaded) |

The fabric-example-mod `26.3` branch itself uses `loom_version=1.18-SNAPSHOT` and
`fabric_api_version=0.161.0+26.3`. We pin the plan's release versions (1.18.3 / 0.162.0+26.3)
instead. Everything else mirrors the example: plugin id, no `mappings` line, `implementation` (not
`modImplementation`) dependencies, `splitEnvironmentSourceSets()`, and `JAVA_25` mixin compatibility.

## How JDK 25 was provisioned

1. `apps/mod/settings.gradle.kts` applies `org.gradle.toolchains.foojay-resolver-convention` 1.0.0.
2. With only that settings file (no Loom yet, because Loom 1.18 is Java 25 bytecode and the first
   run was on JDK 17), we ran:
   `./gradlew updateDaemonJvm --jvm-version=25 --jvm-vendor=ADOPTIUM`.
   The task exists and succeeded, but it **wrote only `toolchainUrl.WINDOWS.X86_64`**. The next build
   then failed with: `Unable to download toolchain … No defined toolchain download url for MAC_OS on aarch64 architecture.`
3. Root cause: the foojay plugin queries
   `api.foojay.io/disco/v3.0/packages?jdk_version=25&distro=temurin&operating_system=<os>&latest=available&directly_downloadable=true`.
   That exact combination returns **0 packages for macos and linux** today, but works for windows.
   Dropping either `latest=available` or `directly_downloadable=true` returns the Temurin 25.0.4.1+1
   packages. This is a foojay API problem, not a Gradle or MineVibe one.
4. Workaround: we looked up the same foojay package ids by hand (Temurin 25.0.4.1+1, JDK, tar.gz,
   glibc on Linux) and added them to `gradle/gradle-daemon-jvm.properties`:
   `LINUX.AARCH64`, `LINUX.X86_64`, `MAC_OS.AARCH64`, `MAC_OS.X86_64` (plus the generated
   `WINDOWS.X86_64`), with `toolchainVendor=ADOPTIUM` and `toolchainVersion=25`. A comment in the
   file explains this. Each URL is a 301 redirect to
   `github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/…`.
5. The next `./gradlew help` downloaded and provisioned the JDK automatically (16 s total, about 136 MB):
   - **Path:** `~/.gradle/jdks/eclipse_adoptium-25-aarch64-os_x.2/jdk-25.0.4.1+1/Contents/Home`
     (438 MB unpacked).
   - The running daemon was confirmed with `ps` to be that `bin/java`.
   - `./gradlew --version` reports
     `Daemon JVM: Compatible with Java 25, Eclipse Temurin … (from gradle/gradle-daemon-jvm.properties)`.
     The launcher stays on JDK 17.

Notes:
- **CI:** with `actions/setup-java` Temurin 25, the launcher JVM already matches (vendor
  ADOPTIUM = Temurin), so nothing is downloaded. Any other vendor makes Gradle download Temurin
  from the `LINUX.X86_64` URL.
- **Regenerating:** running `updateDaemonJvm` again will drop the hand-added URLs until foojay fixes
  the query. Re-add them, or re-run the API query above to get fresh package ids.
- **Option not taken:** pointing `toolchainUrl.*` at `api.adoptium.net/v3/binary/latest/25/ga/<os>/<arch>/jdk/hotspot/normal/eclipse`
  would always fetch the newest 25.x. We chose pinned foojay ids instead, for reproducibility.

## Build timings (M5 Pro, warm network)

| Step | Time |
|---|---|
| `./gradlew --version` (Gradle 9.7.1 distribution download) | 4.5 s |
| First daemon start incl. JDK 25 download + unpack | 16 s |
| First `./gradlew build` (cold: MC 26.3 client+server jars, libraries, Loom setup, compile, test) | 37 s |
| `./gradlew genSources` (Vineflower, 7301 classes) | 24 s |
| `./gradlew clean build` (warm daemon) | ~2 s |
| `./gradlew build` no-op (configuration cache reused) | 0.3 s |
| `./gradlew build` after `--stop` (new daemon, config cache reused) | 2 s |

Disk:
- `~/.gradle/caches/fabric-loom`: 244 MB.
- `apps/mod/.gradle`: 85 MB, including the sources jars.
- `~/.gradle/jdks`: 438 MB.

## What was built (apps/mod)

- **Build files:** Kotlin DSL (`settings.gradle.kts`, `build.gradle.kts`).
  - Loom 1.18.3 with `splitEnvironmentSourceSets()`.
  - Mod `minevibe` = `main` + `client` source sets.
  - Java release 25, sources jar, LICENSE in the jar.
  - Configuration cache and build cache on.
- **GameTests:**
  - `fabricApi.configureTests { createSourceSet = true; modId = "minevibe-gametest"; enableGameTests = true; enableClientGameTests = true; eula = <minevibe.acceptMinecraftEula> }`.
  - `runGameTest` and `runClientGameTest` carry `onlyIf("the Minecraft EULA is accepted (-Pminevibe.acceptMinecraftEula=true)")`.
- **Verified gate behaviour:**
  - Default `./gradlew build` prints `runGameTest SKIPPED`.
  - `./gradlew runGameTest` alone is skipped with that reason.
  - No `eula.txt` and no `build/run/` is created.
  - With `-Pminevibe.acceptMinecraftEula=true`, Loom registers `acceptGameTestEula`. This was checked with `tasks --all` only. Nothing was run with the flag.
- **Why the gate matters:** Fabric's server GameTest `MainMixin` forces `hasAgreedToEULA()` to true. Without our gate, `build` would start a Minecraft server.
- **Sources:**
  - `dev.minevibe.MineVibeMod` (logs `MineVibe loaded`, `id()` helper).
  - `dev.minevibe.client.MineVibeClient` (logs `MineVibe loaded (client)`).
  - Empty mixin configs `minevibe.mixins.json` and `minevibe.client.mixins.json`.
  - `fabric.mod.json` per PLAN 10, with recommends, conflicts krypton, and `lithium:options`.
- **Tests:**
  - JUnit test `MineVibeModTest` (1 test, passes, runs under Knot via fabric-loader-junit).
    Its working directory is `build/junit-run`, because Knot creates `logs/` and `mods/` in the
    working directory.
  - Smoke GameTests `MineVibeServerGameTests` and `MineVibeClientGameTests`. These compile but have never been run.
- **API reference:** `apps/mod/docs/API_MAP_26.3.md`, built from the genSources jars and the Fabric API sources jars.

## Deviations from the plan

1. **Daemon JVM URLs added by hand** for Linux/macOS because of the foojay query problem (above).
2. **`toolchainVendor=ADOPTIUM`** was added (the plan only said `toolchainVersion=25`). This keeps
   the build JDK the same vendor as the bundled Temurin 25 JRE and CI's setup-java Temurin.
3. **EULA is property-driven.** PLAN 11 shows `eula = true` in `configureTests`. This scaffold uses
   `eula = minevibe.acceptMinecraftEula` (default false) and also skips the GameTest run tasks, as
   instructed. CI GameTests (PLAN 11 `mod` job) therefore need an explicit, owner-approved
   `-Pminevibe.acceptMinecraftEula=true`.
4. **Example-mod deviations:**
   - Loom and Fabric API are pinned to releases instead of `1.18-SNAPSHOT` and 0.161.0.
   - `maven-publish` was not carried over, since nothing is published.
   - No mod icon yet; the `icon` field is omitted.
5. **API surprises that change later code** (all detailed in `API_MAP_26.3.md`):
   - There is no `Minecraft#setScreen`; the choke point is `Gui#setScreen`.
   - There is no `getRenderBoundingBox` anywhere.
   - `levelExists` is on `LevelStorageSource`.
   - `LevelSettings` carries `DifficultySettings(difficulty, hardcore, locked)` and no game rules.
   - Day time is `Level#getOverworldClockTime()`.
   - Input is SDL scancodes/keycodes.
   - Blaze3D's command API now lives in `com.mojang.renderpearl.api.*`.

## Fallbacks, in order

1. **Current setup** (auto-provisioning with pinned foojay ids). Works today on macOS and Linux, aarch64 and x64.
2. **Point the URLs at the Adoptium API** if foojay ids ever break:
   `toolchainUrl.MAC_OS.AARCH64=https\://api.adoptium.net/v3/binary/latest/25/ga/mac/aarch64/jdk/hotspot/normal/eclipse`
   (and likewise for other OS/arch).
3. **Unpack a Temurin 25 tarball by hand** in a user-level directory (no sudo) and list it in
   `org.gradle.java.installations.paths` in `~/.gradle/gradle.properties`. Toolchain detection
   should then satisfy the daemon criteria without a download. Untested.
4. **Use the Mojang `java-runtime-epsilon` 25 runtime** that the launcher installs for the game.
   It is a JRE; whether it can host the Gradle daemon is untested.
5. **`brew install --cask temurin@25`.** This is system-wide, so it needs the user's confirmation (PLAN 14).

## Open issues

- **`runClient` boot (S0 acceptance) was not run** (it opens a window). The user should run
  `cd apps/mod && ./gradlew runClient` once and check:
  - the log shows `MineVibe loaded` and `MineVibe loaded (client)`, and Fabric lists `minevibe`;
  - the expected "recommended mod missing" warnings appear for the perf mods.

  The client itself does not need the EULA; that concerns servers and GameTests.
- **GameTests have never been executed.** They need the user's EULA decision. Running
  `runClientGameTest` will also need the TitleScreen redirect disabled under `-Dfabric.client.gametest`
  once BootScreen exists.
- **Fabric API sources jars** were downloaded by hand from maven.fabricmc.net into the session
  scratchpad. Loom does not fetch them on the CLI; an IDE sync does.
- **Report foojay quirk upstream?** It could be reported to foojay (disco API) or
  gradle/foojay-toolchains. Not done.
- **CI workflow not written.** `.github/workflows` is outside this task's scope. The `mod` job should
  use Temurin 25 and `./gradlew build`, with GameTests only behind the EULA flag.

## Follow-up (2026-10-08, after the EULA decision)
- The maintainer accepted the Minecraft EULA for dev and CI. Local opt-in is the gitignored `apps/mod/minevibe.local.properties`; CI passes `-Pminevibe.acceptMinecraftEula=true`.
- `./gradlew build` now also runs the server GameTests on a headless 26.3 server: "All 2 required tests passed", about 7 s warm.
- `./gradlew runClient` boots **Minecraft 26.3 with Fabric Loader 0.19.5**, logs `MineVibe loaded` and `MineVibe loaded (client)`, and uses the **OpenGL** backend ("4.1 Metal"). The only warnings are the expected "recommends sodium/lithium/…" notes, because the perf mods aren't installed in dev. **S0: PASS.**
