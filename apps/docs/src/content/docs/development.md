---
title: Development
description: Repository layout, the dev loop, tests, spikes, CI, and the Minecraft EULA rule for GameTests.
---

:::caution[Pre-alpha]
Milestones M0 and M1 are done, and the parts of M2 to M8 and M10 are built on their own (see the status table on
the [home page](/MineVibe/#status)); they are being composed into one runtime now. Commands below that are not
there yet are marked as such.
:::

## Repository layout

```text
MineVibe/
├─ package.json          npm workspaces, .nvmrc (24), biome.json, LICENSE (MIT), NOTICE, THIRD_PARTY_NOTICES.md
├─ apps/server/          TypeScript orchestrator → esbuild dist/main.mjs; vitest
│   src/{main.ts, orchestrator/, launcher/, bridge/, world/, agents/, ui/, org/, pcs/, app/, contracts/, config/}
│   test/{unit, contract, pcs, live, helpers}
├─ apps/mod/             Fabric mod: Gradle 9.7.1 wrapper, Loom 1.18.3, Java 25, package dev.minevibe
│   src/{main,client,gametest,test}/… + resources (fabric.mod.json, mixins, assets, data)
│   docs/                API_MAP_26.3.md (verified 26.3 APIs), SKILLS.md (the skill layer)
├─ apps/launcher-mac/    MineVibe.swift (the stub, built with swiftc), Info.plist, entitlements
├─ apps/docs/            this site (Astro Starlight)
├─ packages/protocol/    protocol.md, zod schemas, fixtures/<group>/*.json (parsed by vitest and JUnit)
├─ images/linux-pc/      Containerfile: the pinned cua Linux image plus tmux and ripgrep, and the boot hook
├─ packaging/            build-app.ts, vendor.lock.json, mods.lock.json, seed configs
├─ spikes/s0…s8/         throwaway spike code, plus a result.md each
├─ docs/design/          the plan (PLAN.md), the full design, fact-checks, critiques, and DEBT.md
└─ .github/              workflows (ci, docs, release), issue templates, dependabot
```

## Prerequisites

- An Apple Silicon Mac on macOS 26 or later (the server, docs and mod also build on Linux, which is what CI
  uses).
- **Node 24** (see `.nvmrc`).
- **JDK 25** for the mod's Gradle daemon. Gradle can provision it automatically through its daemon JVM
  criteria (spike S0 verifies this); the Gradle wrapper itself needs some JDK on your `PATH` to start.
  Temurin 25 is the fallback.
- **`claude` 2.1.293 or newer**, logged in, for anything that runs real agents.
- For PCs: Apple `container` (bundled in the app; for development you can also use Docker or OrbStack, see
  below).

## Dev loop

There are two ways to run MineVibe from a checkout. Both start Node directly (`node --import tsx`, no wrapper
process), so a Ctrl+C in the terminal runs the normal shutdown: the game gets SIGTERM and saves the world, and
`run/lock` and `run/bridge.json` are removed.

**`npm run dev`** is for working on the mod: Node runs the bridge, and you start Minecraft from Gradle.

```sh
npm install                          # once, at the repository root
npm run dev                          # Node: the bridge on the fixed port 47800, a fresh token every run
cd apps/mod && ./gradlew runClient   # in a second terminal: Minecraft with the mod, connected to Node
```

- Add `-- --scripted-crew` (or set `MINEVIBE_SCRIPTED_CREW=1`) to get a scripted, zero-token crew (Ada and Bram)
  that answers chat, cards and AgentScreen commands, so the in-game UI can be exercised without Claude.
- `runClient` keeps the game in `apps/mod/run/`, with dev worlds that allow commands (the `/mv` dev commands in
  [`apps/mod/docs/SKILLS.md`](https://github.com/jasperaelvoet/MineVibe/blob/main/apps/mod/docs/SKILLS.md)).
  Dead worlds move to `apps/mod/run/saves/_graveyard/` (the last 5 are kept). A move that a crash interrupted is
  finished on the next start.

**`npm run play`** runs MineVibe the way the app will, without the Swift stub: it installs or verifies Java 25,
Minecraft 26.3, Fabric and the locked mods (sha1 and sha512) in its own game directory, seeds the configs, and
launches the game on a random bridge port. A re-run with everything in place only re-checks the files, with no
network, and launches at once.

### Data homes

The two never share state:

| | `npm run dev` | `npm run play` |
| --- | --- | --- |
| Data home | `<repo>/.minevibe-dev/` | `<repo>/.minevibe-dev/play/` |
| Bridge file | `.minevibe-dev/run/bridge.json` (what `runClient` reads) | `.minevibe-dev/play/run/bridge.json` |
| Run lock | `.minevibe-dev/run/lock` | `.minevibe-dev/play/run/lock` |
| World record | `.minevibe-dev/state/current-world.json` | `.minevibe-dev/play/state/current-world.json` |
| Game install and saves | `apps/mod/run/` (Gradle's) | `.minevibe-dev/play/game/` |

`.minevibe-dev/` is gitignored, and every checkout (worktrees too) has its own. `MINEVIBE_HOME` replaces the data
home of either command; the run lock then refuses a second process on the same home ("MineVibe is already running",
see [Troubleshooting](/MineVibe/troubleshooting/#running-from-source)). PC container roots are the exception:
they live under `~/Library/Application Support/MineVibe-dev/`, outside the repository, because Apple `container`
fails in folders macOS privacy protection guards (`~/Documents`, `~/Desktop`, `~/Downloads`).

### Environment variables

| Variable | Effect |
| --- | --- |
| `MINEVIBE_HOME` | Replaces the data home (see above) |
| `MINEVIBE_BRIDGE_PORT` | The dev server's port (default 47800) |
| `MINEVIBE_SCRIPTED_CREW=1` | The scripted crew, as `--scripted-crew` |
| `MINEVIBE_E2E=true` | E2E mode: the `debug.*` helpers. Set it for both `npm run dev` and `./gradlew runClient` (the game reads only `true`); `npm run play` passes `-Dminevibe.e2e=true` to the game itself. |
| `MINEVIBE_SAVES_DIR` | Where the dev server looks for saves to bury (default `apps/mod/run/saves`) |
| `MINEVIBE_PLAYER_NAME` | The offline player name |
| `MINEVIBE_WORLD_SEED` | Development and E2E only: the level seed of every fresh world, for repeatable terrain (MineVibe.app ignores it) |
| `MINEVIBE_PC_RUNTIME=docker` or `container` | Picks the Linux PC driver. Docker (OrbStack, Colima) is the development and CI fallback. |
| `MINEVIBE_CLAUDE=bundled` | Development only: use the Claude Agent SDK's own `claude` binary instead of yours. Release builds never ship it. |
| `MINEVIBE_LOG_LEVEL`, `MINEVIBE_LOG_JSON=1` | Log level, and JSON logs instead of the pretty terminal format |

`node --conditions=source --import tsx apps/server/src/main.ts help` lists the server's commands (`dev`, `play`,
`app`, `doctor`).

## Tests

| Command | What it runs | Where |
| --- | --- | --- |
| `npm run lint` | Biome | CI and local |
| `npm run typecheck` | `tsc --noEmit` in every workspace | CI and local |
| `npm test` | vitest in every workspace: unit tests, the protocol fixtures, contract tests against a fake mod over a real socket, the agent runtime with a fake SDK, the org services, the packaging tests (on macOS they compile the Swift stub). Uses zero tokens. | CI and local |
| `cd apps/mod && ./gradlew build` | JUnit (protocol fixtures, key map, JPEG decode, fragmented WebSocket receive, ...) and, only with the EULA accepted, the server GameTests | CI and local |
| `cd apps/mod && ./gradlew runClientGameTest` | Client GameTests (screens, UI), with the EULA accepted. Opens a game window. | Local |
| `npm run test:pcs -w apps/server` | Real PC drivers: create, health, frames, input, mounts, budget refusal, guest isolation | Local only |
| `npm run test:live` | A small live smoke test of the Claude Agent SDK. **Uses a little of your subscription quota.** | Local only |
| `node spikes/s7-boot/run.mjs` | The end-to-end scenario (E2E mode): boot, death, Begin, a Node restart, a kill on Game Over | Local only |

The last three need this Mac, real VMs or a Claude subscription, so they never run in CI.

### GameTests and the Minecraft EULA

Server and client GameTests start a real Minecraft, and running one requires accepting the
[Minecraft EULA](https://aka.ms/MinecraftEULA). The build **never accepts it for you**: by default
`./gradlew build` skips the GameTests. If you have read the EULA and accept it, opt in explicitly, either per
command:

```sh
cd apps/mod
./gradlew build -Pminevibe.acceptMinecraftEula=true
```

or once per checkout, in a gitignored `apps/mod/minevibe.local.properties`:

```properties
# I have read and accept the Minecraft EULA (https://aka.ms/MinecraftEULA).
minevibe.acceptMinecraftEula=true
```

The file belongs to one checkout: a fresh clone or a new git worktree has none, so its GameTests are skipped until
you add (or copy) one. The maintainer accepted the EULA for this repository's CI, which passes the flag in the
`mod` job; forks don't inherit that.

### Linting inside a git worktree

`biome.json` excludes `.claude/` (`"!!**/.claude"`), so that the agent worktrees under `.claude/worktrees/` are
never linted from the main checkout. The flip side: inside such a worktree, `npm run lint` reports success
**without checking a single file**. Lint there with a copy of the config that drops that one entry. Biome resolves
`files.includes` relative to the config file, so the copy has to sit at the worktree's root:

```sh
sed '/"!!\*\*\/.claude"/d; s/"!\*\*\/.astro",/"!**\/.astro"/' biome.json > biome.worktree.json
npx biome check --config-path=./biome.worktree.json apps/server packages
rm biome.worktree.json
```

Or patch `biome.json` the same way for the run and don't commit the change.

## Spikes

Before milestone M1, each risky assumption got a throwaway **spike** in `spikes/sN/`. Every spike ends with
a `result.md` that records what was measured, and the design was updated from it (the results log is
Appendix A of `docs/design/PLAN.md`). Spike code is never imported by the apps. S6 (Lume) still comes before
milestone M9; the packaging checks of S9 became the app shell and its CI job.

| Spike | Proves |
| --- | --- |
| S0 toolchain | JDK 25 for Gradle; an empty mod boots Minecraft 26.3 with `runClient` |
| S1 fake player | Agent bodies spawn, walk, swim, mine, eat, fight, sit, persist, die with a grave; under 0.5 ms per tick per agent |
| S2 SDK routing and auth | A subscription session with an allowlisted environment; tool aliasing into the PC; plan mode and questions round-trip |
| S3 model and effort | Switching Haiku/`xhigh` ↔ Opus/`medium` at turn boundaries; compaction before switching down |
| S4 monitor and input | 30 fps frames on a monitor in under 2 ms per frame; QWERTY and AZERTY input; chat interception |
| S5 Apple container PC | The bundled `container` runtime, the cua image, frames, input, mounts, and that guests **can't** reach host loopback services |
| S6 Lume | macOS PCs: clone, shared folders, `spacesd` with our token, the 2-VM limit |
| S7 boot and reset | Never showing the title screen; Esc not pausing; death to a new world in under 20 s |
| S8 launcher | Installing Minecraft 26.3 + Fabric and the locked mods into a clean directory, then launching |
| S9 packaging | The Swift stub with bundled Node, JRE and `container`; signing and the Local Network grant survive a rebuild |

The order is S0 → S2 → S3 → S1 → S5 → S4 → S7 → S8 → S9, with S6 before milestone M9.

## Continuous integration

| Job | Runs | Status |
| --- | --- | --- |
| `server` | `npm ci`, lint, typecheck, `npm test` on Node 24 | Active |
| `mod` | `./gradlew build` with Temurin 25, server GameTests included (the maintainer accepted the EULA for CI) | Active |
| `docs` | Builds this site; the build fails on broken internal links | Active |
| `app` | Compiles the Swift stub, assembles `dist/MineVibe.app` from `vendor.lock.json`, verifies its signature, runs the `--selftest` handshake | Active (macOS 26) |
| `mod-client` | Client GameTests under Xvfb | Disabled: the tests exist, the job is not switched on yet |
| `pc-image` | Builds and publishes `ghcr.io/jasperaelvoet/minevibe-linux-pc` | Disabled until publishing to GHCR is approved |

`docs.yml` publishes this site to GitHub Pages from `main`. `release.yml` stays disabled until Microsoft
sign-in ships, because public binaries need it.

## Working on the docs

```sh
npm run dev -w apps/docs       # live preview at http://localhost:4321/MineVibe/
npm run build -w apps/docs     # production build into apps/docs/dist, with link validation
```

Pages are Markdown files in `apps/docs/src/content/docs/`. Internal links must include the base path, for
example `/MineVibe/playing/`; relative links are rejected by the link validator.

## Contributing

See [CONTRIBUTING.md](https://github.com/jasperaelvoet/MineVibe/blob/main/CONTRIBUTING.md) for the
workflow and commit conventions, and
[SECURITY.md](https://github.com/jasperaelvoet/MineVibe/blob/main/SECURITY.md) for reporting
vulnerabilities.
