# MineVibe

[![CI](https://github.com/jasperaelvoet/MineVibe/actions/workflows/ci.yml/badge.svg)](https://github.com/jasperaelvoet/MineVibe/actions/workflows/ci.yml)
[![Docs](https://github.com/jasperaelvoet/MineVibe/actions/workflows/docs.yml/badge.svg)](https://jasperaelvoet.github.io/MineVibe)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**A hardcore Minecraft world where Claude Code agents live, survive and work at real computers.**

Open `MineVibe.app` and you are standing in a Minecraft world with hardcore survival rules. No title screen,
no multiplayer, no menus: the app is either open (you're in) or closed (you're out). A crew of embodied Claude
Code agents lives there with you. They keep you and each other alive, talk in bubbles above their heads, and
sit down at in-game PCs that are real Linux containers and macOS VMs, to work on your real projects.

> [!WARNING]
> **Status: pre-alpha, under construction.** MineVibe is at milestone M0 (foundations and spikes). Nothing is
> playable yet and there are no releases. The docs describe the approved design; unbuilt features are marked
> as planned.

## How it works

- **One world, hardcore.** If you die, the world and its crew end and a new world begins. Your machines, your
  mounted folders (the Vault) and the shared Codex survive.
- **A crew led by a CEO.** The first agent, the CEO, follows you and listens. It can hire more agents (the
  crew is capped at 4 by default), but only after you approve each hire.
- **Your own Claude.** Every agent is a Claude Code session run through the Claude Agent SDK on your own
  `claude` login: Haiku 5.5 while it wanders, Opus 5.5 while it sits at a PC. Survival reflexes run in the
  mod at zero tokens, so the model is never on a life-or-death path.
- **Real computers in the world.** In-game PCs are Linux containers (Apple `container`) or macOS VMs (Lume)
  with their screens live on the monitors. You or an agent sit down and drive them with mouse and keyboard;
  all agent shell and file work happens inside the PC.
- **Talk in chat.** `@ada ...` reaches Ada, a message with no mention reaches everyone. Agents with a
  question, a plan or a hire walk over to you, and you answer in chat.
- **Shared tools.** A Codex (a library block where agents leave notes for each other), a Calendar for
  scheduled work, and meetings that gather the crew around a table.

## Requirements

- A Mac with Apple Silicon, running macOS 26 or later
- Your own copy of Minecraft: Java Edition (MineVibe never ships game files)
- A Claude subscription and the `claude` CLI **2.1.293 or newer**, logged in (`claude update`)
- Disk space for Minecraft (about 600 MB) and the Linux PC image (about 1.2 GB); a macOS PC needs about 24 GB
  more

Please read [Legal and licensing](https://jasperaelvoet.github.io/MineVibe/legal/) for the Minecraft EULA and
how your Claude login is used, and the
[security model](https://jasperaelvoet.github.io/MineVibe/pcs-and-vault/#security-model) before you mount
any folder.

## Development quick start

You need Node 24 (see `.nvmrc`) and a JDK to start Gradle (the mod builds with Java 25).

```sh
npm install                          # at the repository root
npm run dev                          # Node orchestrator on port 47800 (token in .dev-token)
cd apps/mod && ./gradlew runClient   # in a second terminal: Minecraft with the MineVibe mod
```

Tests: `npm run lint`, `npm run typecheck`, `npm test`, and `./gradlew build` in `apps/mod`. Server
GameTests start a Minecraft server and only run if you accept the Minecraft EULA explicitly with
`-Pminevibe.acceptMinecraftEula=true`. See [Development](https://jasperaelvoet.github.io/MineVibe/development/)
and [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

```text
apps/server/        Node 24 orchestrator (TypeScript): agents, bridge, PCs, Codex, Calendar, launcher
apps/mod/           Fabric mod for Minecraft 26.3 (Java 25)
apps/launcher-mac/  Swift stub for MineVibe.app
apps/docs/          Documentation site (Astro Starlight)
packages/protocol/  Mod ⇄ Node wire protocol: protocol.md, zod schemas, shared fixtures
images/linux-pc/    Linux PC image (cua base plus developer tools)
packaging/          App bundling, vendor and mod lock files
spikes/             Throwaway spikes, each with a result.md
docs/design/        The implementation plan and full design
```

## Documentation

**https://jasperaelvoet.github.io/MineVibe**

## Credits and licensing

MineVibe is released under the [MIT License](LICENSE). It includes code adapted from
[fabric-carpet](https://github.com/gnembon/fabric-carpet) (MIT); see [NOTICE](NOTICE). Third-party software
that MineVibe bundles, downloads or builds on is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MineVibe never redistributes Minecraft, Claude Code or third-party mods: Minecraft is downloaded from Mojang,
mods from Modrinth, and agents run on the `claude` you installed yourself.

Thanks to the projects MineVibe stands on: Fabric, Carpet, Sodium and the performance mod authors, cua and
Lume, Apple's `container`, Eclipse Temurin, Node.js, xmcl, and the Claude Agent SDK.

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT. MineVibe is not
affiliated with or endorsed by Anthropic or Apple.

Found a security issue? Please report it privately; see [SECURITY.md](SECURITY.md).
