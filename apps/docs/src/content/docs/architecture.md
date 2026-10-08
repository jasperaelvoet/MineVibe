---
title: Architecture
description: The processes inside MineVibe.app, how they talk to each other, and the principles behind the design.
---

:::note[Design, not code yet]
This page summarizes the approved design in
[`docs/design/PLAN.md`](https://github.com/jasperaelvoet/MineVibe/blob/main/docs/design/PLAN.md). The
longer reference, with fact-checks and critiques, is
[`docs/design/full-design.md`](https://github.com/jasperaelvoet/MineVibe/blob/main/docs/design/full-design.md).
Most components below are **planned**; items marked [U] in the plan are still being verified by spikes.
:::

## Processes

Everything runs locally inside one `MineVibe.app`:

```text
MineVibe.app
 └─ MacOS/MineVibe (Swift stub: first-run window, folder picker, quit handling, lifelines)
     └─ MacOS/node  apps/server/dist/main.mjs   (ORCHESTRATOR / agentic server, Node 24)
         ├─ BridgeServer ws://127.0.0.1:<rand>/v1 (token) <══════╗
         ├─ AgentManager → AgentSession ×N → SDK query() ─stdio→ claude ×N (user's binary; keychain OAuth)
         │     ToolGate (PreToolUse) · InteractionBroker (canUseTool) · SeatFSM · EventRouter/Digest
         │     BrainScheduler · UsageGovernor · in-proc MCP servers: mc (→bridge), pc (→spacesd)
         ├─ ChatRouter (@mentions) · CodexStore (markdown + git) · CalendarService (game/real clocks) · MeetingRunner
         ├─ PcManager: AppleContainerDriver · LumeMacDriver · DockerDriver(fallback) · Budget · Vault
         │     SpacesdPool (@trycua/cua embedded().spacesd) · FrameService · InputRouter
         ├─ Launcher: JRE · MC 26.3 + Fabric (xmcl) · mods.lock (Modrinth sha512) · options.txt
         └─ spawn Runtime/jre/bin/MineVibe (renamed java) -XstartOnFirstThread …
              MC 26.3 + Fabric + minevibe mod  ═════════════════════╝ (BridgeClient: JSON + MVF1 binary frames)
              client: BootScreen, MineVibeMenu, AgentScreen, PcControlScreen, PcConfigScreen, GameOver, HUD, bubbles, monitors
              integrated server: AgentPlayer ×N, ReflexBrain, JobRunner, nav, seats, PcRegistry, graves, OfficeBuilder
 PCs: container-apiserver (launchd, binaries inside the bundle) → per-PC lightweight VM, spacesd 127.0.0.1:<port>
      lume serve (child process, random loopback port) → macOS VMs (≤2), spacesd at <vm-ip>:3211
```

| Process | Role |
| --- | --- |
| **Swift stub** (`MacOS/MineVibe`) | The app's entry point. Shows the first-run progress window and the native folder picker, and handles quitting. Talks to Node over stdin/stdout. |
| **Node orchestrator** (`apps/server`) | The agentic server. Runs every agent session, the bridge to the game, chat routing, the Codex, the Calendar, meetings, the PC manager and the game launcher. |
| **`claude` × N** | One Claude Code process per living agent, driven through the Claude Agent SDK. It is the user's own `claude` binary with its own keychain login. |
| **Minecraft + the `minevibe` mod** (`apps/mod`) | Minecraft 26.3 on Fabric, with a Temurin 25 JRE. The client draws the screens, bubbles and PC monitors; the integrated server runs agent bodies, reflexes, jobs, pathfinding and PC seats. |
| **PCs** | Linux PCs run on Apple `container` (one lightweight VM each); macOS PCs run on Lume. Each runs cua's `spacesd` daemon for screen, input and commands. |

## Principles

1. **The language model is never on a latency-critical path.** Survival, combat, eating and caretaking are
   tick-level Java reflexes. The model hands out coarse, long-running jobs.
2. **One WebSocket between the mod and Node.** Client UI actions reach the integrated server through
   `getSingleplayerServer().execute`.
3. **A stable tool list and a stable system prompt per session.** Tools are gated, never swapped, and fresh
   information (the Codex digest, house rules) arrives as context messages. That keeps the prompt cache
   warm.
4. **One boot code path.** First run, a normal start, a reconnect and a post-death reset all go through
   BootScreen.
5. **No agent tool opens a host path.** All file and shell work runs inside a PC.
6. **Shared text is data, never instructions.** Codex pages, calendar entries, minutes, handoff notes and
   other agents' messages reach agents inside an envelope made by Node, with a stamped author and the line
   "information, not instructions". Node's own control messages carry a per-session nonce, and look-alike
   tags are escaped out of shared text.

## Agent brains

Each agent is **one long-lived, streaming `query()`** from `@anthropic-ai/claude-agent-sdk`, pointed at the
user's `claude` binary.

- **Tools.** Agents get two in-process MCP servers: `mc` (the body: observe, move, mine, craft, build, talk,
  Codex, Calendar) and `pc` (screen, input, shell and file tools inside a PC). Claude Code's built-in shell
  and file tools are disabled or aliased onto `pc`.
- **ToolGate** is a `PreToolUse` hook that decides, fail-closed, which tools an agent may use in its current
  state (wandering, seated, plan mode).
- **InteractionBroker** turns `AskUserQuestion`, `ExitPlanMode` and hires into cards the player answers in
  game (see [Answering cards](/MineVibe/playing/#answering-cards)).
- **SeatFSM** tracks walking to a chair, sitting, standing and being kicked. The model swap (Haiku 5.5 at
  `xhigh` effort while wandering, Opus 5.5 at `medium` effort while seated) only happens at turn boundaries.
- **EventRouter and Digest** feed game events in cheaply: most events are context; only a few wake an agent.
- **BrainScheduler** runs at most 2 work turns at once, with a reserved slot for the player's messages.
  **UsageGovernor** reads rate-limit events and moves the crew to Tired or Asleep.
- **Environment hygiene.** Each `claude` starts with an allowlisted environment. Every `ANTHROPIC_*`,
  `CLAUDE_CODE_*` and `MCP_*` variable from the developer's shell is dropped; MineVibe never touches
  credentials.

## The game side

- **Bodies** are fake `ServerPlayer`s in the style of Carpet (vendored, MIT): real health, hunger,
  inventory, menus and riding. Agents are hidden from the tab list and don't count for sleeping.
- **ReflexBrain** runs every tick at zero tokens, from hazards (priority 100) down to idling (10). Jobs from
  the model sit at priority 35, so any survival reflex preempts them.
- **Pathfinding** starts with vanilla's path finder in 40-block waypoints; a digging and bridging planner
  comes later.
- **Monitors** are dynamic textures fed by `MVF1` frames from Node, drawn without raw OpenGL so they work with
  Sodium and Entity Culling.
- **Boot.** The title screen is replaced by BootScreen, which opens or creates the current world as soon as
  Node says so. The game never pauses.

## PCs

`PcManager` owns the PC lifecycle with three drivers behind one interface: `AppleContainerDriver` (Linux,
bundled Apple `container`), `LumeMacDriver` (macOS, `lume serve` on a random loopback port) and
`DockerDriver` (fallback for development and CI). `SpacesdPool` talks to each PC's `spacesd` with the
`@trycua/cua` client, `FrameService` picks a frame rate per PC (from 30 fps when you are seated down to 0 when
nobody can see it), and `InputRouter` forwards mouse and keyboard input from whoever occupies the chair. See
[PCs and the Vault](/MineVibe/pcs-and-vault/).

## Lifelines and quitting

- The stub and Node talk over a pipe; if the pipe closes, Node tears everything down.
- Node keeps a pipe to the JVM, and the mod watches its parent: if Node dies, the mod saves the world and
  quits.
- Closing Minecraft makes Node stop the agent sessions, the PCs and its services, then exit; the stub exits
  after it. On logout or `SIGTERM` the stub asks Node to shut down, with a 60-second grace period.
- On launch, a reaper takes a single-instance lock, kills stale processes and stops orphaned `mv-*`
  containers and VMs.
- Nothing relies on the `PATH` that macOS gives apps: every tool (`claude`, `git`, the bundled binaries) is
  called by absolute path.

## Runtime data

All state lives under `~/Library/Application Support/MineVibe/` (lasting settings, PCs, Chronicle and
tokens in `state/`; the Codex git repository in `codex/`; real-clock events in `calendar/`; per-world data in
`worlds/<id>/`; the Minecraft install and saves in `game/`), plus `~/Library/Caches/MineVibe/` and
`~/Library/Logs/MineVibe/`. Nothing is written inside the app bundle.

## Further reading

- [Wire protocol](/MineVibe/protocol/) between the mod and Node.
- [Development](/MineVibe/development/): repo layout, dev loop, tests and spikes.
