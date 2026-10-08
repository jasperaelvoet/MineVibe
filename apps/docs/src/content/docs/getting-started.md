---
title: Getting started
description: What you need to run MineVibe, and what the first run downloads.
---

:::caution[Planned]
There is no MineVibe release yet. Until Microsoft sign-in ships, MineVibe is **source-only**: you build and
run it yourself from the repository (see [Development](/MineVibe/development/)). This page describes the
planned first-run experience of `MineVibe.app`.

**What works from source today:** `npm run play` already does steps 2, 3 and 6 below (Minecraft, Fabric and the
mods, checked by sha1 and sha512, plus the seeded configs) and drops you into a fresh hardcore world with its
starter office. `npm run build:app` assembles a local `MineVibe.app` bundle. The first-run window's prerequisite
check (step 1), starting the `container` system and pulling the PC image (steps 4 and 5) are being built.
:::

## Requirements

| You need | Why |
| --- | --- |
| A Mac with **Apple Silicon** | Linux PCs run on Apple's `container` runtime and macOS PCs on Lume. Both need Apple Silicon. |
| **macOS 26** or later | The minimum system version of the app and of the bundled `container` runtime. |
| Your own copy of **Minecraft: Java Edition** | MineVibe never ships Minecraft. Game files are downloaded from Mojang on first run. |
| A **Claude subscription** and the **`claude` CLI 2.1.293 or newer**, logged in | Every agent is a Claude Code session that runs on your own `claude` login. MineVibe needs 2.1.293 or newer for the Haiku 5.5 effort setting it uses. |
| Free disk space | About 600 MB for Minecraft, about 1.2 GB for the Linux PC image, plus room for your PCs. A macOS PC needs about 24 GB more and at least 40 GB free. |
| Enough memory for your PCs | MineVibe sizes PCs from a fixed budget. See [Resources and budget](/MineVibe/pcs-and-vault/#resources-and-budget). |

Read [Legal and licensing](/MineVibe/legal/) too: it covers the Minecraft EULA and how your Claude login is used.

### Check your Claude CLI

```sh
claude --version   # must print 2.1.293 or newer
claude update      # if it is older
claude             # then run /login inside it if you are not logged in yet
```

MineVibe never updates `claude` for you and never reads, stores or forwards your credentials. It starts your
`claude` binary with a minimal, allowlisted environment and lets the CLI use its own login from the macOS
keychain.

## What the first run does

The first launch (and the first launch after an update) shows a small progress window. Nothing else outside
Minecraft has a window, apart from the native folder picker you use to add Vault folders.

1. **Checks prerequisites:** Apple Silicon, macOS 26 or later, and `claude` installed, logged in and at
   2.1.293 or newer. If a check fails you get a one-line instruction, such as "run `claude update`".
2. **Downloads Minecraft 26.3** from Mojang: the client, libraries and assets, about 600 MB, each file
   checked against Mojang's sha1. Then the Fabric loader.
3. **Downloads the mods** listed in `mods.lock.json` from Modrinth: Fabric API, Sodium and the rest of the
   performance stack. Each file is verified by sha512. MineVibe never rehosts mod jars.
4. **Starts the `container` system.** This downloads Apple's Linux kernel and init image the first time.
5. **Pulls the Linux PC image** (`ghcr.io/jasperaelvoet/minevibe-linux-pc`, pinned by digest, about 1.2 GB)
   and creates your first PC, `linux-1` (2 vCPU, 4 GiB).
6. **Seeds `options.txt`** and the mod configs. Existing settings are merged, never overwritten.
7. **Hands off to the game.** You wake up in a fresh hardcore world, next to a small office with your first
   PC and your CEO.

macOS PCs are not downloaded during the first run. You add one later from inside the game, after a consent
screen that shows the download size (about 24 GB) and your free disk space.

macOS may ask whether MineVibe can find devices on your local network. Allow it: see
[Local Network prompt](/MineVibe/troubleshooting/#local-network-prompt).

## Where MineVibe keeps things

Nothing is ever written inside `MineVibe.app`, because that would break its code signature. Everything lives
in your user Library:

| Path | What | Lifetime |
| --- | --- | --- |
| `~/Library/Application Support/MineVibe/state/` | Settings, PC list, Chronicle, per-PC tokens | Lasting |
| `~/Library/Application Support/MineVibe/codex/` | The shared Codex (a git repository) | Lasting pages survive world death |
| `~/Library/Application Support/MineVibe/calendar/` | Real-clock calendar events | Lasting |
| `~/Library/Application Support/MineVibe/worlds/<id>/` | Game-clock events, agent memory and chat logs | One world |
| `~/Library/Application Support/MineVibe/game/` | Minecraft install, mods, saves, `saves/_graveyard/` | Kept |
| `~/Library/Caches/MineVibe/` | Download caches | Disposable |
| `~/Library/Logs/MineVibe/` | Logs | Disposable |

## Next steps

- Learn the controls and how the crew works in [Playing MineVibe](/MineVibe/playing/).
- Mount a project folder into a PC in [PCs and the Vault](/MineVibe/pcs-and-vault/), and read its
  security section first.
- If something goes wrong, see [Troubleshooting](/MineVibe/troubleshooting/).
