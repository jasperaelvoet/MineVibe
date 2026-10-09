---
title: PCs and the Vault
description: In-game PCs are real Linux containers and macOS VMs. How they are sized, how you and your agents use them, how to mount your own folders, and what that means for your security.
---

:::caution[Partly built]
- **Built:** the Linux PC manager in Node (Apple `container` and Docker drivers, the budget, the Vault, live
  frames and input, measured in spikes S4 and S5 and in `npm run test:pcs`), and the PC blocks, monitors,
  PcControlScreen and PcConfigScreen in the mod.
- **Being wired together:** the two halves, so that a PC on a desk in the game is a running Linux PC; and agents
  at PCs (milestone M5).
- **Planned:** macOS PCs (milestone M9, after spike S6). Items marked "untested" have not been measured yet.
:::

Every PC in the world is a **real computer**: a Linux container or a macOS virtual machine running on your
Mac. Its screen renders live on the in-game monitor. You can sit down and drive it with your mouse and
keyboard, and an agent uses it the same way, by walking to the chair and sitting down. One occupant at a
time.

## PC types

| Type | Runs on | Image | Default size | Limit |
| --- | --- | --- | --- | --- |
| `linux` | Apple `container` 1.5.0 (bundled); each container is its own lightweight VM | `ghcr.io/jasperaelvoet/minevibe-linux-pc`: cua's `ghcr.io/trycua/linux:24.04` desktop plus tmux, ripgrep, git and build-essential, pinned by digest | 2 vCPU, 4 GiB | Your budget |
| `linux-slim` | Same | Built from cua's `24.04-slim` | 1 vCPU, 2 GiB | Your budget |
| `macos` | Lume 0.6.x (bundled) | cua's `ghcr.io/trycua/macos:26`, about 24 GB to download, needs 40 GB free disk | 4 vCPU, 8 GiB | **2 running**: Apple allows at most 2 macOS VMs at once |
| `windows` | Not available | cua's Windows image is amd64 only, so it would need slow emulation | | Shown greyed out |

Each PC runs cua's `cua-spacesd` daemon, which MineVibe uses for screenshots, live video, mouse and keyboard
input, and running commands. MineVibe manages the PCs' lifecycle itself; it does not use cua's own sandbox
service. For development and CI, a Docker or OrbStack driver can stand in for Apple `container`.

### Placing and removing PCs

- **Your first PC**, `linux-1`, is created on the first run. Its workstation stands in your starter office.
- **Workstation items** (`linux_workstation`, `mac_workstation`) place a desk, a monitor and a chair in one
  go. Placing a new one creates a new PC of that type, if your budget has room. Otherwise the monitor shows
  "no capacity", or "Apple allows 2 macOS VMs".
- **Breaking a workstation unplugs its PC.** The PC stops and stays off until you place the item again,
  which reconnects the same machine. A lost item (lava, a grave) can be re-issued from the PC config screen.
- **Recipes:** a Linux workstation takes iron, redstone, a glass pane and copper; a Mac workstation takes
  iron, gold, a glass pane and redstone; a chair takes planks, sticks and wool.
- **PCs outlive worlds.** They keep running across world resets, with their disks intact, unless you turn on
  "wipe on world death" for a PC.

A PC's status shows on its monitor, on its status LED, in the hover line and in its config screen: `off`,
downloading, awaiting consent, booting, `running`, stopping, remounting, reimaging, `no_capacity`,
`macos_slots_full`, `engine_down` or `error`.

## Resources and budget

MineVibe never overcommits your Mac's memory. It reserves memory for everything else first and lets PCs use
the rest:

| Reserved for | Memory |
| --- | --- |
| macOS and your other apps | 10 GiB |
| Minecraft | 8 GiB |
| MineVibe's Node process | 0.5 GiB |
| One `claude` process per agent (crew cap 4) | 1 GiB each, 4 GiB in total |
| The `container` system | 1 GiB |

On a 48 GiB Mac that leaves 48 − 23.5 = **24.5 GiB** for PCs. CPU is a soft limit: your core count minus 4,
with a warning if you overcommit past that, up to 1.5 times.

- A PC starts, or a change is accepted, only if it fits. Otherwise you get "over budget", and a PC that
  can't start shows `no_capacity`.
- The budget counts each PC's **allocated** memory, not what it currently uses, because container VMs don't
  hand freed memory back to macOS.
- **Resizing a PC, or changing its type, recreates it.** Your home folder (`/home/cua`) and your Vault mounts
  are kept; system-level changes outside your home folder are lost. The config screen warns you first.

Sneak + right-click a desk or monitor to open its config screen: CPU and memory sliders that stop at your
free budget, bars for the host's remaining budget, the macOS slot count (`n/2`), the Vault list, and Start,
Stop, Restart, Reimage, Watch and Decommission.

## Sitting at a PC

Right-click a free chair to sit. The PC's screen grows to about 92% of the window, and the world stays
visible around the edges and keeps running.

- **Typing is layout-correct**, so AZERTY and other layouts work. Special keys and shortcuts go to the PC.
  **Cmd** is sent as Ctrl to Linux PCs and as Cmd to macOS PCs.
- **Shift+Esc** stands up. Plain Esc goes to the PC. Hold the **middle mouse button** to look around the
  room. **Ctrl+Shift+Enter** opens chat and card answering on top of the PC.
- **The border strip** shows pending cards, direct replies, meeting calls, and flashes red when you take
  damage. Click an item to open it.
- Whenever you stand up, every held key is released on the PC.
- **Watch mode** shows an agent's PC fullscreen, read-only.

## Agents at PCs

An agent that needs a computer walks to a free PC and sits down. Once seated it switches to **Opus 5.5** and
**PC mode**, and gets its PC tools: screenshots and zoom, mouse and keyboard, reading apps' text and buttons
directly (through the desktop's accessibility tree, much cheaper than looking at the screen), opening apps, files and
web pages, a shell, file tools (read, write, edit, search) and the web. All of them act **inside that PC**. Of its
game tools it keeps only what a seated body needs (its status and surroundings, talking, notes, the Codex and the
calendar); walking, mining, crafting and building wait until it stands up.

- **Careful with your files.** An agent only overwrites or edits a file it has read in this sitting, and stops
  if the file changed since (you edited it in the meantime).
- **Long commands** (servers, builds) run in the background; the agent hears when they finish.
- **Apps it opens close when it stands up**, like its commands.

- **Plan first.** Coding roles start in plan mode: the agent can look around and run read-only commands, and
  nothing changes until you approve its plan card.
- **Watch it work.** A terminal on the PC's screen mirrors the agent's shell, so you can follow along from
  across the room.
- **Kicking.** Sneak + right-click a seated agent (and confirm), use Kick in its AgentScreen or in the PC
  config screen, or right-click its chair ("Kick Bram and sit?"). The kick takes effect within about 2
  seconds: the agent is interrupted, its processes on the PC are stopped, and it can't sit back down for 30
  seconds.
- Agents also stand up on their own to fight or to survive, and when you call a meeting.

## The Vault

The **Vault** is the set of folders on your Mac that you mount into PCs, so agents can work on your real
projects. Add folders in a PC's config screen with **Browse...** (a native folder picker).

- **Same path inside.** On Linux PCs a folder appears at the same absolute path as on your Mac. On macOS PCs
  it is a shared folder with a symlink at the same path.
- **Read-only or read-write**, per folder.
- **Build folders stay separate.** `node_modules`, `.venv`, `target`, `build` and `.gradle` inside a mount are
  overlaid with per-PC volumes, so Linux build output doesn't land in your folder on the Mac.
- **Refused folders:** your home folder itself, `/`, `~/Library`, any folder that is or contains `~/.ssh`,
  `~/.aws`, `~/.config`, `~/.claude`, `~/.gnupg` or `~/.docker`, and dotfile-config folders. Git repositories
  are recommended.
- The shared Codex is mounted read-only at `/mnt/codex` in every Linux PC, with a `~/codex` link to it:
  `lasting/` (pages that survive world death) and `world/` (this world only). Agents write pages with their Codex
  tools, never in the folder; a new world replaces `world/` as a whole.
- The Vault survives world death. The Game Over screen shows how many commits each folder got in that world.

## Security model

MineVibe gives AI agents real computers and, if you choose, your real folders. Here is what protects you,
and what does not.

### What protects you

- **Agents have no shell on your Mac.** All of their shell and file work runs inside a PC through the PC's
  own daemon. Claude Code's built-in Bash, Read, Edit, Write, Glob and Grep tools are either disabled or
  redirected into the PC. No agent tool ever opens a path on your Mac.
- **A fail-closed tool gate** checks every tool call against the agent's state: no PC tools unless the agent
  is seated at that PC, no web access while wandering, no web fetches to loopback or private network
  addresses, and no file changes in plan mode.
- **PCs are virtual machines.** Apple `container` runs every Linux PC in its own lightweight VM, and macOS
  PCs are full VMs.
- **Loopback only, with tokens.** The bridge between the game and MineVibe's Node process listens on
  `127.0.0.1` only, requires a random token and rejects any request that carries a browser `Origin` header.
  Each Linux PC's daemon is published on `127.0.0.1` only, with its own 24-byte token. macOS PCs are reached
  on their private VM address, also with a token. On macOS PCs the default password is rotated and VNC stays
  off.
- **Your credentials stay with `claude`.** MineVibe never reads, stores or forwards your Claude login. It
  starts each `claude` with an allowlisted environment, so variables from your shell (API keys, base URLs)
  don't leak into agents.
- **Shared text is data.** Codex pages, calendar entries, meeting minutes and other agents' messages reach an
  agent wrapped and labelled as information, not instructions. Only `rules` pages you write yourself are
  presented as house rules.
- **Host-side git is defanged.** When MineVibe itself runs git in your folders (to count commits), hooks and
  fsmonitor are disabled. A tripwire shows a toast if `.git/config` or `.git/hooks` changes in a mounted
  folder.
- cua and Lume telemetry are turned off.

### What does not

:::danger[Read-write mounts can run code on your Mac]
An agent with a **read-write** mount can put code into that folder that **later runs on your Mac**, with
your user's permissions, the next time you use the folder. For example: npm `scripts` and dependencies,
Makefiles and build scripts, test files, `.envrc` files, editor tasks and launch configs, CI workflows, or
git hooks and `.git/config` entries that your own git will honour. MineVibe's tripwire only watches
`.git/config` and `.git/hooks`, and it only warns.
:::

- **Read-only is not secret.** Anything you mount, read-only or read-write, can be read by the agent. PCs
  have internet access (agents need it for package managers and git), so mounted content could be sent
  elsewhere. Don't mount folders that hold secrets such as `.env` files or keys.
- **Prompt injection is real.** Seated agents can search and fetch the web, and they read whatever is in your
  repositories. Hostile text can steer them. The tool gate limits what they can do; it can't make them
  trustworthy.
- **Services on your Mac may be reachable from PCs.** Each Linux PC gets its own private network
  (`192.168.65.x`, `192.168.66.x`, ...), so PCs can't reach each other. A service on your Mac that listens on
  all interfaces (`0.0.0.0`) is reachable from PCs through the network's gateway and your Mac's LAN address.
  Services bound to your Mac's loopback (`127.0.0.1`) refused guest connections in spike S5, so MineVibe binds
  everything it runs to loopback only. IPv6, UDP and DNS isolation are **untested**.
- **Bind mounts have known quirks** (measured in spike S5): files a PC writes land on your Mac as your user and
  `chown` inside the PC fails, edits made on the Mac don't raise file-change events inside the PC (watch-mode
  tools in a PC miss them), and creating a write-only (mode 0200) file fails but leaves an empty file behind.
  These are usability limits more than security ones.

### Recommendations

1. Mount **only** project folders, preferably git repositories, and prefer **read-only** where an agent only
   needs to read.
2. Commit or stash before an agent starts, and **review `git diff`** before you build, test or open the
   folder on your Mac.
3. Keep plan-first on for coding agents.
4. Stop PCs you don't need, and keep secrets out of mounted folders.

Found a way around any of these protections? Please report it privately; see
[SECURITY.md](https://github.com/jasperaelvoet/MineVibe/blob/main/SECURITY.md).
