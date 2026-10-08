# Security policy

MineVibe gives AI agents real computers and, if you choose, access to real folders on your Mac. We take that
seriously and would rather hear about a problem early.

## Reporting a vulnerability

**Please report vulnerabilities privately**, through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**
   (https://github.com/jasperaelvoet/MineVibe/security/advisories/new).

Please **don't** open a public issue, discussion or pull request for a vulnerability.

Include what you can:

- what an attacker can do, and what they need first (for example "a malicious web page an agent reads", or
  "a file in a mounted folder");
- steps to reproduce, or a proof of concept;
- the MineVibe commit, your macOS version and your `claude --version`;
- any logs, with secrets removed.

MineVibe is a small, pre-alpha open-source project maintained in spare time. We aim to acknowledge a report
within a week and to keep you updated until it is resolved. We'll credit you in the advisory unless you
prefer otherwise. Please give us a reasonable chance to fix the problem before you disclose it publicly.

## Supported versions

There are no releases yet. Security fixes land on `main`.

## Threat model

MineVibe runs locally. It has four kinds of assets: **your Mac** (files, credentials, other services), **your
Claude account**, the **folders you mount** into PCs (the Vault), and **the game state** (worlds, the Codex,
the Calendar). The main adversary is **untrusted content reaching an agent**, such as a web page, a file in a
repository, or text another agent wrote, that tries to steer the agent into harming any of those assets.
Agents themselves are treated as untrusted.

### Agents are sandboxed in PCs

- **No host shell, no host file access.** Agents have no tool that runs a command or opens a path on the Mac.
  Claude Code's built-in shell and file tools are disabled or redirected into the agent's PC, and all shell
  and file work runs inside that PC through cua's `spacesd` daemon.
- **A fail-closed tool gate** (a `PreToolUse` hook) checks every call against the agent's state: PC tools
  only while seated at that PC, no web access while wandering, no web fetches to loopback, private (RFC 1918)
  or link-local addresses, and no file changes in plan mode.
- **PCs are virtual machines.** Linux PCs run on Apple `container`, one lightweight VM per PC. macOS PCs run
  as full VMs under Lume, with the default password rotated and VNC off.
- **Credentials stay in `claude`.** MineVibe never reads, stores or forwards Claude credentials. Each `claude`
  process starts with an allowlisted environment; API keys, base URLs and other `ANTHROPIC_*`,
  `CLAUDE_CODE_*` and `MCP_*` variables from the user's shell are dropped.
- **Shared text is data.** Codex pages, calendar entries, minutes, handoff notes and other agents' messages
  reach agents inside an envelope that names the author and marks the content as information, not
  instructions. Node's own control messages carry a per-session nonce, and look-alike tags are escaped out
  of shared text. Only `rules` pages written by the player are presented as binding house rules.
- **Codex writes are scanned** for strings that look like credentials, and rejected.

### Local services are loopback-only and authenticated

- **The bridge** between the Minecraft mod and Node listens on `127.0.0.1` on a random port, requires a
  bearer token stored in a 0600 file (the JVM only receives the file's path), rejects any request with an
  `Origin` header, and rejects non-loopback peers.
- **Each PC's `spacesd`** is published on `127.0.0.1` only, with a random 24-byte token per PC. macOS PCs are
  reached on their private VM address, also with a token. Tokens are stored with mode 0600.
- **`lume serve`** runs as a child process on a random loopback port.
- Agents never get cua's own MCP server or its sandbox-management tools. cua and Lume telemetry are off.

### The Vault is the main risk

Mounting a folder into a PC is a deliberate trust decision:

- **Read-write mounts let agents plant code that may later run on your Mac**: package scripts and
  dependencies, build files, test files, `.envrc`, editor tasks, CI workflows, git hooks and `.git/config`.
  It runs with your user's permissions as soon as you build, test or open the project on the Mac. The UI
  says so when you add a read-write mount.
- **Any mount, read-only or read-write, can be read**, and PCs have internet access, so mounted content can
  leave your Mac.
- Mitigations: MineVibe refuses to mount `$HOME`, `/`, `~/Library`, and any folder that is or contains
  `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude`, `~/.gnupg` or `~/.docker`. Host-side git calls run with hooks
  and fsmonitor disabled. A tripwire warns when `.git/config` or `.git/hooks` changes. Build folders are
  overlaid with per-PC volumes.
- Recommendations: mount only project folders under version control, prefer read-only, and review
  `git diff` before running anything from a mounted folder on your Mac.

### Known gaps and unverified assumptions

- **Guest-to-host loopback isolation is unverified.** Spike S5 must prove that PCs cannot reach services
  bound to the Mac's loopback interface (`lume serve`, the bridge, and anything else you run). If they can,
  MineVibe will add a guest egress firewall before PCs ship.
- **Services bound to all interfaces are reachable from PCs.** Apple `container` guests sit on
  `192.168.64.x`, and any service on the Mac that listens on `0.0.0.0` is reachable through `192.168.64.1`.
  MineVibe binds its own services to loopback; other software on your Mac may not.
- **Prompt injection cannot be fully prevented.** The tool gate and the data envelope limit what a steered
  agent can do; they don't make it trustworthy.

## Scope

In scope: anything in this repository, including the mod, the orchestrator, the protocol, the PC drivers, the
packaging and CI workflows, and the docs site. Examples of what we especially want to hear about:

- an agent running a command or touching a file on the host, or escaping its PC;
- a tool-gate bypass (PC tools while not seated, web access while wandering, writes in plan mode, a WebFetch
  to a private address);
- reaching the bridge or a PC's `spacesd` without the token, or from off-loopback;
- credentials leaking into agent environments, logs, the Codex or the repository;
- a forged control message or house rule getting through the data envelope.

Out of scope: vulnerabilities in Minecraft, Claude Code, Apple `container`, Lume, cua or a mod (please report
those upstream; tell us too if MineVibe makes them worse), attacks that already require root or full
control of the user's account on the Mac, and the documented risk that a read-write mount lets an agent write
code you later run, unless you found a way around the mitigations listed above.
