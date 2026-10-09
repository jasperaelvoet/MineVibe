---
title: PCs and the Vault
description: In-game PCs are real Linux containers and macOS VMs. How they are sized, how you and your agents use them, how to mount your own folders, and what that means for your security.
---

:::caution[Partly built]
- **Built:** the PC manager in Node for Linux PCs (Apple `container` and Docker drivers) and macOS PCs (Lume), the
  budget, the Vault, live frames and input, agents at PCs (measured in spikes S4, S5 and S6 and in
  `npm run test:pcs`), the Android phone and nested virtualization for Linux PCs (spike S9-android), and the PC
  blocks, monitors, PcControlScreen, PcConfigScreen and the download prompt in the mod.
- **Not yet:** MineVibe.app does not bundle Lume yet, so it downloads MineVibe's pinned copy (6 MB) the first time
  you start a macOS PC. Items marked "untested" have not been measured yet.
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
| `macos` | MineVibe's own Lume 0.6.1 (notarized by its maker, never modified), as a full macOS VM | cua's `ghcr.io/trycua/macos:26` (macOS 26.5), pinned by digest: a 24 GB download once, about 29 GB on disk, shared by every macOS PC; needs 40 GB free disk to create one | 4 vCPU, 8 GiB | **2 running**: Apple allows at most 2 macOS VMs at once, and other apps' macOS VMs count too |
| `windows` | Not available | cua's Windows image is amd64 only, so it would need slow emulation | | Shown greyed out |

Each PC runs cua's `cua-spacesd` daemon, which MineVibe uses for screenshots, live video, mouse and keyboard
input, and running commands. MineVibe manages the PCs' lifecycle itself; it does not use cua's own sandbox
service. For development and CI, a Docker or OrbStack driver can stand in for Apple `container`.

### Placing and removing PCs

- **Your first PC**, `linux-1`, is created on the first run. A new world has no desk for it: craft a Linux
  Workstation and place it, and that desk shows `linux-1`.
- **Workstation items** (`linux_workstation`, `mac_workstation`) place a desk, a monitor and a chair in one
  go. A fresh item first takes a PC of its kind (Linux or macOS) that has no desk in this world yet, so no PC is
  duplicated; only when every one already has a desk does it create a new PC, if your budget has room. Otherwise the
  monitor shows "no capacity", or "Apple allows 2 macOS VMs".
- **Breaking a workstation unplugs its PC.** The PC stops and stays off until you place the item again,
  which reconnects the same machine. A lost item (lava, a grave) can be re-issued from the PC config screen.
- **Recipes:** a Linux workstation takes iron, redstone, a glass pane and copper; a Mac workstation takes
  iron, gold, a glass pane and redstone; a chair takes planks, sticks and wool.
- **PCs outlive worlds.** They keep running across world resets, with their disks intact, unless you turn on
  "wipe on world death" for a PC.

A PC's status shows on its monitor, on its status LED, in the hover line and in its config screen: `off`,
downloading, awaiting consent, booting, `running`, stopping, remounting, reimaging, `no_capacity`,
`macos_slots_full`, `engine_down` or `error`.

### macOS PCs

- **The download asks first.** The first macOS PC needs cua's macOS image, a 24 GB download. Its monitor shows
  "Download needs your OK" until you sneak + right-click the desk and choose **Download** in the prompt (it shows the
  size and your free disk space). The monitor then shows the download's progress, and every macOS PC you make later
  starts from the same image without asking again. **Not now** leaves the PC off; starting it asks again.
- **Fast after the download.** A new macOS PC is a copy-on-write clone of the image: it is ready 20 to 30 seconds
  after you place it, and a stopped one starts again in 20 to 30 seconds.
- **Apple's limit.** macOS allows two macOS virtual machines at a time on one Mac. A third shows "Apple allows 2
  macOS VMs" (`macos_slots_full`), also when another app (another VM tool, a second MineVibe) runs one.
- **Inside**, the user is `lume` (home `/Users/lume`), with the command-line developer tools (git, Python, Swift,
  `jq`) and ripgrep, but no Homebrew. Agents work there as they do on Linux, with Cmd as `cmd` in key names.
- **Resizing restarts it**; nothing is lost, because a macOS PC's disk is the PC. **Reimage** gives it a fresh copy of
  the image (everything on it is lost, your Vault folders on the Mac are not).
- **Keys and mouse.** Cmd is sent as Cmd. macOS's PC daemon cannot hold a key or a button down, so MineVibe presses a
  key each time your keyboard repeats it, clicks where you pressed the button (double clicks by timing) and drags when
  you release after moving: you see a drag happen when you let go.
- **The PC stops with MineVibe.** macOS PCs run inside MineVibe's own `lume serve`, which quits within about 10 s of
  the last MineVibe that uses it, even if MineVibe crashed.

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
free budget, the **KVM** and **Android** switches of a Linux PC (see [Running Android apps](#running-android-apps)),
bars for the host's remaining budget, the macOS slot count (`n/2`), the Vault list, and Start, Stop, Restart,
Reimage, Watch and Decommission.

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

An agent that needs a computer walks to a free PC and sits down. Once seated, its **desk session** for that PC
takes over (on **Opus 5.5**, in **PC mode**), with a handoff of the task, what you said to it lately, its notes and
the notes left at that PC. The next time it sits at the same PC, that desk session picks up where it left off. It
has its PC tools: screenshots and zoom, mouse and keyboard, reading apps' text and buttons
directly (through the desktop's accessibility tree, much cheaper than looking at the screen), opening apps, files and
web pages, a shell, file tools (read, write, edit, search) and the web. All of them act **inside that PC**. Of its
game tools it keeps only what a seated body needs (its status and surroundings, talking, notes, the Codex and the
calendar); walking, mining, crafting and building wait until it stands up.

- **Careful with your files.** An agent only overwrites or edits a file it has read in this sitting, and stops
  if the file changed since (you edited it in the meantime).
- **Long commands** (servers, builds) run in the background; the agent hears when they finish.
- **Apps it opens close when it stands up**, like its commands.
- **It knows what its PC can do:** its handoff and its `info` tool list the PC's CPU (64-bit ARM), memory, free
  disk, network, KVM, the Android phone and the installed tools. When something needs a switch only you can flip
  (Android, KVM), it tells you plainly which one instead of giving up.

- **Plan first.** Turn on Plan-first in an agent's AgentScreen (it is off for every role) and its PC sessions
  start in plan mode: the agent can look around and run read-only commands, and nothing changes until you approve
  its plan card.
- **When it stands up** (done, kicked, attacked, called to a meeting), its body gets a short report: how the
  sitting ended, what it said last, the files it changed and how its last commands exited.
- **Watch it work.** A terminal on the PC's screen mirrors the agent's shell, so you can follow along from
  across the room.
- **Kicking.** Sneak + right-click a seated agent (and confirm), use Kick in its AgentScreen or in the PC
  config screen, or right-click its chair ("Kick Bram and sit?"). The kick takes effect within about 2
  seconds: the agent is interrupted, its processes on the PC are stopped, and it can't sit back down for 30
  seconds.
- Agents also stand up on their own to fight or to survive, and when you call a meeting.

## Running Android apps

A Linux PC can have an **Android phone** next to it: a real Android 15 device (Redroid, 64-bit ARM) that you and
your agents use from the PC. Turn on **Android** in the PC's config screen and press **Apply**.

- **The first time** on your Mac, MineVibe asks before it downloads anything: a **Download needed** window says
  what (Android 15 and the Linux kernel source), how big (about 0.9 GB) and how much disk is free. **Download**
  turns Android on; **Not now** leaves it off. It then builds its Android kernel (a few minutes) and the config
  screen shows the progress ("Android phone: preparing 42% · building the Android kernel"). After that the phone
  starts in about 10 seconds whenever the PC starts. (A later MineVibe update that needs a new kernel or image
  fetches it without asking again.)
- **On the PC**, run `android install game.apk && android open`. The phone appears in a window called
  "Android phone" on the PC's desktop: click to tap, right-click for back. An agent does the same from its shell.
  `android status`, `android apps`, `android launch <package>`, `android screenshot` and `android adb …` do the
  rest. The first `android open` installs adb and builds scrcpy inside the PC (about a minute).
- **Apps and saves are kept** across PC restarts (the phone's storage is an 8 GiB volume). Turning Android off,
  Reimage and Decommission delete the phone's apps and data.
- **Budget:** the phone takes 4 vCPUs and 4 GiB of the PC pool whenever its PC runs. Turning it on is refused when
  that does not fit.
- **Limits:** 64-bit ARM apps only (`arm64-v8a`; Apple silicon runs no 32-bit ARM or x86 code, so an APK built only
  for those fails with a clear message), no Google Play services (apps that need a Google sign-in or Play
  Integrity refuse to run), and software graphics (2D and light 3D games are fine; heavy 3D games are slow).
- **Why not the Android emulator?** Google publishes no Android SDK emulator for ARM Linux, and a full Android VM
  inside a PC (Cuttlefish on nested virtualization) took over 30 minutes to boot in our tests. The phone runs as
  its own lightweight VM instead, next to the PC, on the PC's private network; nothing else can reach it.

### Nested virtualization (KVM)

Turn on **KVM** in a Linux PC's config screen to give it `/dev/kvm`, for QEMU and other virtual machines inside the
PC. It needs a Mac with an **M3 or newer** chip (the toggle says why when your Mac cannot), uses MineVibe's Android
kernel (built on first use after a **Download needed** window, as above), and **recreates the PC** when you change it
(your home folder and the Vault are kept). You don't need it for Android apps, so leave it off unless a PC must run
its own virtual machines (see [Nested virtualization and the Android phone](#nested-virtualization-and-the-android-phone)).

## The Vault

The **Vault** is the set of folders on your Mac that you mount into PCs, so agents can work on your real
projects. Add folders in a PC's config screen with **Browse...** (a native folder picker).

- **Same path inside.** On Linux PCs a folder appears at the same absolute path as on your Mac. On macOS PCs
  it is a shared folder (`/Volumes/My Shared Files/<name>`) with a symlink at the same path as on your Mac.
- **Read-only or read-write**, per folder.
- **Build folders stay separate on Linux PCs.** `node_modules`, `.venv`, `target`, `build` and `.gradle` inside a
  mount are overlaid with per-PC volumes, so Linux build output doesn't land in your folder on the Mac. A macOS PC
  shares the folder as it is: what it builds there is a Mac build anyway.
- **Edits on your Mac reach a macOS PC with a delay.** The macOS PC's view of a shared folder caches files, so
  MineVibe watches your Vault folders and refreshes that view before an agent's next file or shell command. Apps
  running inside the PC may show the old version of a file you changed on the Mac until then.
- **Refused folders:** your home folder itself, `/`, `~/Library`, any folder that is or contains `~/.ssh`,
  `~/.aws`, `~/.config`, `~/.claude`, `~/.gnupg` or `~/.docker`, and dotfile-config folders. Git repositories
  are recommended.
- The shared Codex is mounted read-only at `/mnt/codex` in every Linux PC (`/Volumes/My Shared Files/codex` on
  macOS PCs), with a `~/codex` link to it:
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
  addresses, no network scans from a PC at private addresses (nmap and the like at the PC's network, your Mac or
  your LAN), and no file changes in plan mode. The scan check is a backstop for agents that mean well; it reads
  the command line and can be worked around.
- **PCs are virtual machines.** Apple `container` runs every Linux PC in its own lightweight VM, and macOS
  PCs are full VMs.
- **Loopback only, with tokens.** The bridge between the game and MineVibe's Node process listens on
  `127.0.0.1` only, requires a random token and rejects any request that carries a browser `Origin` header.
  Each Linux PC's daemon is published on `127.0.0.1` only, with its own 24-byte token. macOS PCs are reached
  on their private VM address (only your Mac can reach it), with a new token at every start, handed over in a
  read-only shared folder. On macOS PCs VNC, Remote Login and sharing stay off; MineVibe's `lume serve` listens on
  `127.0.0.1` only, where the PCs cannot reach it. The image's well-known password (`lume`) is not changed: nothing
  that could use it from outside is on, and agents in the PC have `sudo` anyway.
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
  On macOS PCs (spike S6) files the PC writes also land as your user, and edits made on the Mac raise no
  file-change events inside the PC and are cached until MineVibe refreshes the PC's view (see the Vault above).
  These are usability limits more than security ones.

### Nested virtualization and the Android phone

Both are off by default and only the player can turn them on (agents can only ask you to).

- **KVM weakens nothing inside the PC, but exercises more of your Mac's hypervisor.** With KVM on, the PC's VM
  starts at a virtual EL2 so that it can run virtual machines of its own. Apple's hypervisor still separates the PC
  from your Mac, but nesting runs code paths a plain VM never uses (Apple added nested virtualization in macOS 15),
  so a hypervisor bug would be easier to reach. Turn it on only for PCs that need it. VMs inside the PC share its
  CPUs, memory and network, so they can reach nothing the PC itself can't.
- **`/dev/kvm` is opened to every user in the PC.** The PC has one user, who already has passwordless `sudo`, so
  this gives an agent nothing it didn't have.
- **The phone is its own VM** next to the PC, on the PC's private network, with MineVibe's kernel. Android runs
  with full privileges inside that VM (it needs them), and its `adb` has no authentication, but it publishes no
  port: only the PC can reach it. Like the PC, it can reach the internet and services on your Mac that listen on
  all interfaces.
- **What MineVibe downloads for them** is pinned: the Linux kernel source by sha256 and the Android image by
  digest. The kernel is built on your Mac in a throwaway container from that source; scrcpy, inside the PC, is
  built from a sha256-pinned release.

### Recommendations

1. Mount **only** project folders, preferably git repositories, and prefer **read-only** where an agent only
   needs to read.
2. Commit or stash before an agent starts, and **review `git diff`** before you build, test or open the
   folder on your Mac.
3. Keep plan-first on for coding agents.
4. Stop PCs you don't need, and keep secrets out of mounted folders.

Found a way around any of these protections? Please report it privately; see
[SECURITY.md](https://github.com/jasperaelvoet/MineVibe/blob/main/SECURITY.md).
