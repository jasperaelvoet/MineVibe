---
title: Development
description: Repository layout, the dev loop, tests, spikes, CI, and the Minecraft EULA rule for GameTests.
---

:::caution[Early days]
The repository is at milestone M0: the monorepo scaffold, CI, these docs and the spikes. Commands below
that belong to later milestones are marked as such.
:::

## Repository layout

```text
MineVibe/
├─ package.json          npm workspaces, .nvmrc (24), biome.json, LICENSE (MIT), NOTICE, THIRD_PARTY_NOTICES.md
├─ apps/server/          TypeScript orchestrator → esbuild dist/main.mjs; vitest
│   src/{main.ts, orchestrator/, launcher/, bridge/, agents/{tools/,prompts/}, pcs/{drivers/}, world/, config/}
│   test/{unit, contract, sim/bridgeSim.ts (fake mod), scripted brain}
├─ apps/mod/             Fabric mod: Gradle 9.7.1 wrapper, Loom 1.18.3, Java 25, package dev.minevibe
│   src/{main,client,gametest}/java/dev/minevibe/… + resources (fabric.mod.json, mixins, assets, data)
├─ apps/launcher-mac/    MineVibe.swift (the stub, built with swiftc), Info.plist, entitlements
├─ apps/docs/            this site (Astro Starlight)
├─ packages/protocol/    protocol.md, zod schemas, fixtures/*.json (round-tripped by vitest and JUnit)
├─ images/linux-pc/      Containerfile: the pinned cua Linux image plus tmux, ripgrep, git, build-essential
├─ packaging/            build-app.ts, vendor.lock.json, mods.lock.json, seed configs
├─ spikes/s0…s9/         throwaway spike code, plus a result.md each
├─ docs/design/          the plan, the full design, fact-checks and critiques
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

```sh
npm install                       # once, at the repository root
npm run dev                       # Node orchestrator on the fixed port 47800, token in .dev-token
cd apps/mod && ./gradlew runClient   # in a second terminal: Minecraft with the mod, connected to Node
```

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `MINEVIBE_PC_RUNTIME=docker` or `container` | Picks the Linux PC driver. Docker (OrbStack, Colima) is the development and CI fallback. |
| `MINEVIBE_CLAUDE=bundled` | Development only: use the Claude Agent SDK's own `claude` binary instead of yours. Release builds never ship it. |

`npm run play` (milestone M1) installs Minecraft 26.3, Fabric and the mods into a clean game directory and
launches the game the way the app will, without the Swift stub.

## Tests

| Command | What it runs | Where |
| --- | --- | --- |
| `npm run lint` | Biome | CI and local |
| `npm run typecheck` | `tsc --noEmit` in every workspace | CI and local |
| `npm test` | vitest: unit tests, protocol contract tests, and the brainless integration suite (`bridgeSim`, a fake mod, plus a scripted brain). Uses zero tokens. | CI and local |
| `cd apps/mod && ./gradlew build` | JUnit (protocol fixtures, key map, JPEG decode, fragmented WebSocket receive) and, only with the EULA flag, the server GameTests | CI and local |
| `npm run test:pcs` | Real PC drivers: create, health, frames, input, mounts, budget refusal, guest isolation | Local only |
| `npm run test:live` | A small live smoke test of the Claude Agent SDK. **Uses a little of your subscription quota.** | Local only |
| `MINEVIBE_E2E=1` scenario | The recorded end-to-end run, from boot to a new world | Local only |

The last three need this Mac, real VMs or a Claude subscription, so they never run in CI.

### GameTests and the Minecraft EULA

Server GameTests (and, later, client GameTests) start a real Minecraft server, and running one requires
accepting the [Minecraft EULA](https://aka.ms/MinecraftEULA). The build **never accepts it for you**: by
default `./gradlew build` skips the GameTests. If you have read the EULA and accept it, opt in explicitly:

```sh
cd apps/mod
./gradlew build -Pminevibe.acceptMinecraftEula=true
```

CI runs without the flag until the maintainer accepts the EULA for the project's CI runs.

## Spikes

Before milestone M1, each risky assumption gets a throwaway **spike** in `spikes/sN/`. Every spike ends with
a `result.md` that records what was measured, and the design is updated before M1 starts. Spike code is never
imported by the apps.

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
| `mod` | `./gradlew build` with Temurin 25 (GameTests skipped until the EULA is accepted) | Active |
| `docs` | Builds this site; the build fails on broken internal links | Active |
| `mod-client` | Client GameTests under Xvfb | Disabled until M1 |
| `pc-image` | Builds and publishes `ghcr.io/jasperaelvoet/minevibe-linux-pc` | Disabled until `images/linux-pc` exists |
| `app` | Builds and self-tests `MineVibe.app` on macOS 26 | Disabled until the Swift stub exists (M10) |

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
