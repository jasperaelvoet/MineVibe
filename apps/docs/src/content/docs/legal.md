---
title: Legal and licensing
description: The Minecraft EULA, how MineVibe uses your Claude login, and the licenses of the software it bundles or downloads.
---

:::note
This page explains how MineVibe is put together so you can make informed choices. It is not legal advice.
:::

**MineVibe is not an official Minecraft product. It is not approved by or associated with Mojang or
Microsoft.** It is also not made, endorsed or supported by Anthropic or by Apple.

## Minecraft

- **You need to own Minecraft: Java Edition.** MineVibe is a launcher and a mod; it is not a copy of the game.
- **MineVibe never redistributes Minecraft.** The [Minecraft EULA](https://aka.ms/MinecraftEULA) does not
  allow distributing Mojang's game files, so the client, its libraries and its assets are downloaded from
  Mojang's own servers on your Mac on first run, and checked against Mojang's hashes. The MineVibe mod is
  written so that it contains no substantial part of Mojang's code.
- **Sign-in.** Today MineVibe launches the game with an offline profile, for development and personal use by
  people who own the game. Signing in with a Microsoft account needs an application ID approved by Mojang.
  **Public binary releases wait for Microsoft sign-in**; until then MineVibe is source-only.
- **GameTests.** Running Minecraft's server, which the mod's automated GameTests do, requires accepting the
  EULA. The build never accepts it on your behalf: you opt in with `-Pminevibe.acceptMinecraftEula=true`
  (see [Development](/MineVibe/development/#gametests-and-the-minecraft-eula)).
- "Minecraft" is a trademark of Mojang Synergies AB.

## Claude

- **MineVibe never ships Claude Code.** Each agent runs on the `claude` CLI that **you** installed and logged
  into, through the Claude Agent SDK. The SDK's own bundled `claude` binary is removed from release builds.
- **Your usage, your terms.** Everything your agents do counts against your own Claude plan, and your use is
  governed by your agreement with Anthropic and its usage policies.
- **Your credentials stay yours.** MineVibe never reads, stores or forwards your Claude credentials. It starts
  `claude` with an allowlisted environment and lets the CLI use its own login.
- **Same model as T3 Code.** MineVibe has no Claude login of its own: it drives the CLI you installed and
  logged into yourself, on your own Mac, so your plan's terms apply as usual. An optional **API-key mode**
  (planned) runs agents on an Anthropic API key instead, billed per token.
- The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is proprietary software © Anthropic PBC, installed
  from npm and subject to Anthropic's legal agreements. It is not covered by MineVibe's MIT license.
- "Claude" and "Claude Code" are trademarks of Anthropic PBC.

## Mods

The performance mods (Sodium, Lithium, FerriteCore, ImmediatelyFast, Entity Culling, More Culling, Dynamic
FPS, BadOptimizations, Sodium Extra, plus Fabric API and Cloth Config) are **downloaded from Modrinth** on
your Mac, pinned by version and verified by sha512. MineVibe **never rehosts** them. Each one is under its own
license; notably **Sodium** uses the Polyform Shield license and **Entity Culling** uses a custom license, and
both forbid rehosting.

## Software in the app

The planned `MineVibe.app` bundles, byte-identical to their official releases:

| Component | License |
| --- | --- |
| Node.js 24 | MIT |
| Eclipse Temurin 25 JRE | GPLv2 with the Classpath Exception |
| Apple `container` 1.5.0 | Apache-2.0 |
| Lume (`lume.app`) | MIT |

The PC images come from [cua](https://github.com/trycua/cua). They contain cua's `spacesd` daemon, licensed
under FSL-1.1-MIT, and operating system packages under their own licenses. macOS PCs run Apple's macOS, which
is why at most 2 macOS VMs can run at once.

The full list, including the parts MineVibe borrows from other open-source projects, is in
[THIRD_PARTY_NOTICES.md](https://github.com/jasperaelvoet/MineVibe/blob/main/THIRD_PARTY_NOTICES.md) and
[NOTICE](https://github.com/jasperaelvoet/MineVibe/blob/main/NOTICE).

## MineVibe's own license

MineVibe is open source under the
[MIT License](https://github.com/jasperaelvoet/MineVibe/blob/main/LICENSE). It includes code adapted from
[fabric-carpet](https://github.com/gnembon/fabric-carpet) (MIT), credited in `NOTICE`.

Apple, Mac, macOS and Apple Silicon are trademarks of Apple Inc. Other names belong to their owners.
