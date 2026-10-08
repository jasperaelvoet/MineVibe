---
title: Troubleshooting
description: Fixes for an outdated claude CLI, a container engine that won't start, the macOS Local Network prompt, and other common problems.
---

:::note[Mostly planned behaviour]
MineVibe is pre-alpha. [Running from source](#running-from-source) covers what you can hit today; the rest of
the messages and recovery paths below are the planned ones, and this page will grow with real reports.
:::

Logs are in `~/Library/Logs/MineVibe/`. Include them (with anything private removed) when you open an
[issue](https://github.com/jasperaelvoet/MineVibe/issues).

## Running from source

### "MineVibe is already running (pid ...)"

`npm run dev` and `npm run play` each take a single-instance lock, `run/lock`, in their own data folder
(`.minevibe-dev/` and `.minevibe-dev/play/`, or `MINEVIBE_HOME`). A second one on the same folder refuses to start
and names the process that holds the lock.

- Stop that process (Ctrl+C in its terminal runs a clean shutdown and removes the lock), or give the second one
  its own folder with `MINEVIBE_HOME`.
- A lock left behind by a process that no longer runs is taken over automatically. So is one whose pid now belongs
  to a different process (after a reboot): the lock records the owner's start time, in UTC, and compares it.
- A lock written within the last 2 seconds counts as taken while its process exists, because its owner is still
  starting up.

### The game says "Waiting for MineVibe…"

`./gradlew runClient` connects to the dev server through `.minevibe-dev/run/bridge.json`. Start `npm run dev`
first, in the same checkout. The game re-reads the file before every attempt, so it also reconnects after you
restart the dev server. It never connects while the file's `pid` is not running.

## claude is too old or not logged in

**Symptoms:** the first-run window stops with a one-line instruction such as "run `claude update`", or an
in-game toast says the brains can't start. Agents stay asleep, but their reflexes keep them alive.

MineVibe needs your own `claude` CLI at **2.1.293 or newer**, logged in with a Claude subscription.

```sh
claude --version   # check the version
claude update      # update it
claude             # run /login inside if you are not logged in
```

Then restart MineVibe. MineVibe never updates `claude` itself.

When agents start, MineVibe also checks that:

- the session is using your subscription login, not an API key from your environment (MineVibe strips
  `ANTHROPIC_*` and `CLAUDE_CODE_*` variables before starting `claude`, unless you turned on API-key mode);
- your account reports a subscription type;
- `claude-haiku-5-5` (with `xhigh` effort) and `claude-opus-5-5` are available to you;
- the built-in Bash, Read and Agent tools are really disabled.

If any check fails, a toast explains which one, and the brains stay asleep while the reflexes keep running.

## Agents show Zz

A blue **Zz** above an agent means one of:

- **Out of usage.** Your Claude usage limit was reached. Agents pause until it resets, and the chat echo
  tells you when ("Ada is out of usage until 14:05").
- **Sign-in problem.** An authentication error also puts agents to sleep. Check `claude` as above; MineVibe
  retries, and an agent whose brain keeps crashing shows a "brain offline" icon with a **Retry** button.
- **Agent server offline.** The mod lost its connection to MineVibe's Node process. It reconnects on its own;
  if it doesn't, quit and relaunch.

## Container engine down

**Symptoms:** PC monitors show `engine_down`, and Linux PCs never boot.

MineVibe runs Linux PCs on Apple's `container` runtime, which it bundles and starts with its own data folder.
Every `container` command runs with a timeout, and a hang is reported as `engine_down` instead of freezing
the game.

### Another container install is running

Apple's `container` uses one shared system service. If you installed `container` yourself (Homebrew or
Apple's installer) and it is running, MineVibe **never stops it** and shows `engine_down` ("another
`container` install is running"), with an offer to use it. Either accept the offer, or stop your own copy
(`container system stop`) and restart MineVibe.

### macOS 27: container hangs on start (apple/container#2275)

On macOS 27, `container system start` can hang forever: see
[apple/container#2275](https://github.com/apple/container/issues/2275). The reporter traced it to the packet
filter: when no process holds a reference to it (the default when the firewall's stealth mode is off), the
network setup blocks, and every `container` command hangs.

- MineVibe times out and shows `engine_down` with a link to the issue.
- The workaround reported in the issue is to turn on stealth mode in the macOS firewall settings and
  restart the Mac. This changes a security setting on your Mac, so read the issue first and decide for
  yourself. Check the issue for newer fixes; it may be resolved in a later macOS update.
- Until it is fixed, Docker or OrbStack can stand in for development (`MINEVIBE_PC_RUNTIME=docker`).

## Local Network prompt

macOS may ask whether **MineVibe** (and Apple's container runtime helper) may "find devices on your local
network". **Allow it.** MineVibe talks to its PCs over local network connections: Linux PCs through ports
published on `127.0.0.1`, and macOS PCs on their private VM addresses. If permission is denied, PC screens
stay black and input does nothing.

- **If you clicked "Don't Allow"**, open **System Settings → Privacy & Security → Local Network**, and turn on
  MineVibe and the container runtime helper. Then restart MineVibe.
- **On macOS 27**, connections to published container ports were reset unless the container helper had Local
  Network permission (apple/container#2029, fixed in a macOS 27 beta). On current macOS 27 releases the
  helper appears in the Local Network list and asks on first use.
- **Developers:** macOS ties the permission to the app's code signature. Local builds are signed with your
  free Apple Development identity so the grant survives rebuilds; ad-hoc signed builds may ask again after
  every rebuild.

## A PC won't start

Look at the PC's monitor or its config screen (sneak + right-click the desk):

| Status | Meaning | What to do |
| --- | --- | --- |
| `no_capacity` | Not enough memory or CPU left in your budget | Stop or shrink another PC. See [Resources and budget](/MineVibe/pcs-and-vault/#resources-and-budget). |
| `macos_slots_full` | Two macOS PCs are already running, Apple's limit | Stop one of them |
| `awaiting_consent` | A large download (such as the 24 GB macOS image) needs your OK | Open the config screen and confirm |
| `engine_down` | The container engine is not running | See [Container engine down](#container-engine-down) |
| `error` | Something else failed | Check the logs, then Restart. Reimage is the last resort: it resets the PC, including its home folder, but never touches your Vault folders on the Mac. |

## First-run downloads fail

Every Minecraft file is checked against Mojang's sha1, and every mod against the sha512 in `mods.lock.json`.
A file that fails the check is never used. Check your connection, free disk space and the logs, then relaunch
to try again.

## Still stuck?

Open an [issue](https://github.com/jasperaelvoet/MineVibe/issues) with your macOS version, Mac model,
`claude --version` and the relevant logs. For anything security-related, don't open a public issue; follow
[SECURITY.md](https://github.com/jasperaelvoet/MineVibe/blob/main/SECURITY.md) instead.
