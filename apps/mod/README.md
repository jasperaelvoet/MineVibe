# MineVibe mod (`apps/mod`)

The Fabric mod for Minecraft Java **26.3**: agent bodies, reflexes, PCs, monitors, screens and the
bridge client. Package `dev.minevibe`, mod id `minevibe`. See `docs/design/PLAN.md` section 7.

| | Version |
|---|---|
| Minecraft | 26.3 (unobfuscated, Mojang names; no mappings) |
| Fabric Loader | 0.19.5 |
| Fabric API | 0.162.0+26.3 |
| Fabric Loom | 1.18.3 (`net.fabricmc.fabric-loom`) |
| Gradle | 9.7.1 (wrapper) |
| Java | 25 (`options.release = 25`) |

The versions live in `gradle.properties`.

## Java 25 without installing anything

You do not need JDK 25 on your `PATH`. Any Java 17+ can start `./gradlew`; Gradle then runs the
build daemon on **Temurin 25**, as required by `gradle/gradle-daemon-jvm.properties`. If no
matching JDK is installed, Gradle downloads one once into `~/.gradle/jdks/`. The download URLs in
that file are foojay redirects to Adoptium's GitHub releases.

Regenerating that file needs care. `./gradlew updateDaemonJvm --jvm-version=25 --jvm-vendor=ADOPTIUM`
currently writes only a Windows URL, because of a foojay API quirk (see
`spikes/s0-toolchain/result.md`). Keep the hand-added `LINUX.*` and `MAC_OS.*` entries.

## Commands

```bash
./gradlew build          # compile, unit tests, jar -> build/libs/minevibe-<version>.jar (no GameTests)
./gradlew test           # JUnit 5 under Fabric Loader's Knot (fabric-loader-junit)
./gradlew genSources     # decompiled Minecraft sources for the IDE (Vineflower)
./gradlew runClient      # dev client in ./run (opens a window)
```

`docs/API_MAP_26.3.md` lists the verified 26.3 / Fabric API names and signatures that the mod
relies on. Check there before guessing a name.

## Running the client against Node

The game never shows the title screen: BootScreen waits for Node's `world.open` over the bridge
(`dev.minevibe.bridge.BridgeClient`). For the dev loop (PLAN §9.4):

```bash
npm run dev                      # repo root: bridge on 127.0.0.1:47800, writes .minevibe-dev/run/bridge.json
cd apps/mod && ./gradlew runClient
```

`runClient` reads `npm run dev`'s bridge file only. `npm run play` keeps everything (bridge file, run lock, world
record, game install) in `.minevibe-dev/play/` and hands its own bridge file to the game it launches, so the two can
run side by side. The dev server writes a fresh token on every start; the mod re-reads the file before every
connection attempt and refuses one whose `pid` is not running.

`runClient` passes these to the game JVM as `-D` system properties. Each comes from a Gradle property
(`-Pminevibe.e2e=true`) or, failing that, an environment variable:

| Gradle property | Environment variable | Game JVM | Default |
|---|---|---|---|
| `minevibe.bridgeFile` | `MINEVIBE_BRIDGE_FILE` | `-Dminevibe.bridgeFile` (Node's `run/bridge.json`; the token never goes on a command line) | `<repo>/.minevibe-dev/run/bridge.json` |
| `minevibe.e2e` | `MINEVIBE_E2E` | `-Dminevibe.e2e` (enables the `debug.*` bridge requests) | unset |
| `minevibe.dev` | `MINEVIBE_DEV` | `-Dminevibe.dev` (new worlds allow `/` commands) | `true` |
| `minevibe.parentPid` | `MINEVIBE_PARENT_PID` | `-Dminevibe.parentPid` (save and quit when that process exits) | unset |
| `minevibe.runTag` | `MINEVIBE_RUN_TAG` | `-Dminevibe.runTag` (a marker to find the process with `pgrep -f`) | unset |
| `minevibe.runDir` | `MINEVIBE_RUN_DIR` | game directory, relative to `apps/mod` | `run` |

The dev server moves dead worlds from `apps/mod/run/saves` to `saves/_graveyard` (`MINEVIBE_SAVES_DIR`
overrides the folder). `spikes/s7-boot/run.mjs` drives the whole boot and hardcore loop this way.

Screens: `GuiSetScreenMixin` (the one `Gui#setScreen` choke point) shows BootScreen instead of TitleScreen
and DisconnectedScreen, GameOverScreen instead of DeathScreen, and the non-pausing MineVibeMenuScreen
instead of PauseScreen. Every change is logged as `[screen] <shown> (requested <asked>)`. Under client
GameTests (`-Dfabric.client.gametest`) the redirects are off, because Fabric's runner expects TitleScreen.

## GameTests and the Minecraft EULA

Running GameTests starts Minecraft. That is covered by the
[Minecraft EULA](https://aka.ms/MinecraftEULA), and this build never accepts it for you.

- The only switch is the Gradle property `minevibe.acceptMinecraftEula`, which defaults to `false`.
- Pass it on the command line, or put it in your own `~/.gradle/gradle.properties`. **Never** set
  it in the committed `gradle.properties`.

With the property unset or `false`:
- `runGameTest` (server GameTests, which Loom wires into `check` and `build`) is **skipped**.
- `runClientGameTest` (client GameTests) is also skipped.
- Loom's `acceptGameTestEula` task is not registered, so no `eula.txt` is written.

Fabric's server GameTest runner ignores `eula.txt`, so this property is the only thing that stops
`./gradlew build` from launching a Minecraft server. Keep the gate in place.

When you accept the EULA:

```bash
./gradlew build -Pminevibe.acceptMinecraftEula=true              # + headless server GameTests
./gradlew runClientGameTest -Pminevibe.acceptMinecraftEula=true  # client GameTests (opens a window)
```

CI can only run GameTests if the repository owner explicitly decides to pass this flag in the
workflow.

## Layout

```
build.gradle.kts            Loom setup, split client/common source sets, GameTest gate
settings.gradle.kts         plugin repos, foojay toolchain resolver
gradle.properties           versions (+ EULA note)
gradle/gradle-daemon-jvm.properties   daemon JVM = Temurin 25 (auto-provisioned)
gradle/wrapper/             Gradle 9.7.1 wrapper, from FabricMC/fabric-example-mod@26.3
src/main/                   common + server code (dev.minevibe), fabric.mod.json, minevibe.mixins.json
src/client/                 client-only code (dev.minevibe.client), minevibe.client.mixins.json
src/gametest/               mod "minevibe-gametest": server (fabric-gametest) and client
                            (fabric-client-gametest) GameTests, never shipped
src/test/                   JUnit tests
docs/API_MAP_26.3.md        verified API reference
```

Where code goes:
- Client-only classes (`net.minecraft.client.*`) go in `src/client` only. Loom's split source sets
  make the compiler enforce this.
- Mixin classes go only in `dev.minevibe.mixin` (common) or `dev.minevibe.client.mixin` (client).
  List each one in the matching `*.mixins.json`.

## Provenance

The wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`,
`gradle-wrapper.properties`) were copied from
`raw.githubusercontent.com/FabricMC/fabric-example-mod/26.3/`. The jar's SHA-256 is
`7a9ce74cff467ca1bf60a4fcd9f05185acceda4d0f382434d393e17864262c5d`, which matches Gradle's
published checksum for the 9.7.1 wrapper. `distributionSha256Sum` pins the Gradle 9.7.1
distribution.
