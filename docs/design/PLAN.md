# MineVibe: implementation plan

## 1. Context
MineVibe starts from an empty folder (`/Users/jasperaelvoet/Documents/MineVibe`). It is a single macOS app. Launching it drops the player straight into one Minecraft world with **hardcore survival** rules. There is no title screen, no multiplayer, no quit-to-menu and no other UI: the app is either open (you're in) or closed (you're out).

Embodied Claude Code agents live in the world:
- **Crew.** One agent, the CEO, exists at the start and listens to the player. The CEO can hire more agents, but only after the player confirms.
- **Survival.** Agents have real health and hunger. They keep the player and each other alive.
- **Talking.** Agents speak in bubbles above their heads. Clicking an agent opens its chat, where the player can reply, send new tasks, answer questions and approve plans.

In-game **PCs** are real cua sandboxes:
- **Types.** Linux containers, or macOS VMs (Apple allows at most 2 running at once).
- **Live screen.** Each PC's screen renders live on its monitor.
- **Control.** The player can sit down and drive a PC with mouse and keyboard. An agent uses a PC the same way, by walking to the chair and sitting. One occupant at a time, and the player can kick an agent off.

Agents run on the user's own Claude subscription through the Claude Agent SDK, the same way T3 Code does it. Model choice depends on the agent's state:

| State | Model | Effort |
|---|---|---|
| Wandering | Haiku 5.5 | xhigh |
| Seated at a PC | Opus 5.5 | medium |

Two accepted exceptions: an agent stays on Opus while it walks from its PC to the player to ask something (its turn is still in flight), and for up to 60 s after standing (debounce for a quick re-sit).

When the player dies, MineVibe starts a brand-new world.

The world has shared organisation tools:
- **Codex:** a library block where agents write and read notes for each other.
- **Calendar:** the player, and the **CEO** agent (the first agent), schedule tasks for agents at specific game or real times. **Meetings** gather all the agents around a table.

Two interaction rules:
- **Agents come to you.** An agent with a question or a request for approval walks over to the player.
- **You answer in chat.** The player replies through normal chat: `@name …` goes to that agent, a message with no `@` goes to everyone. Agent messages appear above their heads.

Everything runs locally inside one `MineVibe.app`: agents, game, world and VMs. Sodium and the other performance mods are included. The project is a **public GitHub repo with CI and a docs site**.

**Where this plan comes from.** Research by three agents, three design workflows (3 architects, 3 fact-checkers, a synthesis and 2 critics), a performance-mod survey checked against Modrinth, and packaging research with an adversarial check.
- The full ~1000-line synthesized design, the fact-checks and the critiques are in the session scratchpad. Step 1 of M0 copies them into `docs/design/` so they become the detailed reference.
- This file is the executable summary.
- **[U]** marks an item that is still unverified and gets an M0 spike (section 12.1).

## 2. Decisions at a glance

| Topic | Decision |
|---|---|
| Minecraft | Java **26.3**, **Fabric** (loader 0.19.5, Fabric API 0.162.0+26.3, Loom 1.18.3, Gradle 9.7.1), **Java 25**. Unobfuscated Mojang names, SDL3 input. |
| Renderer | OpenGL backend forced (`--graphicsBackend opengl`). Vulkan is experimental and opt-in only. |
| Agent bodies | Carpet-style fake `ServerPlayer`, vendored (MIT, credited in NOTICE). Real HP, hunger, inventory, menus and riding. |
| Agent brains | One long-lived streaming `query()` per agent, using `@anthropic-ai/claude-agent-sdk@0.3.293`. Always in `bypassPermissions`, with ToolGate (PreToolUse) as the fail-closed sandbox guard; no automatic plan mode (Plan-first is a per-agent toggle, off by default). USER DECISIONS 2026-10-08, 6.1-6.4. |
| Claude binary | The user's own `claude` (T3 model), at version ≥ 2.1.293, because Haiku 5.5 effort needs it. The installed copy is 2.1.284, so the user runs `claude update`. Release artifacts never ship the Claude binary. |
| Linux PCs | **Apple `container` 1.5.0**, bundled in the app (Apache-2.0), running `ghcr.io/trycua/linux:24.04` plus a thin MineVibe layer. Docker/OrbStack is a fallback driver for dev and CI. |
| macOS PCs | **Lume 0.6.x** (notarized `lume.app`, byte-identical) running `ghcr.io/trycua/macos:26`, at most 2 running |
| PC control | `@trycua/cua@0.4.1` used only as a client of each PC's `cua-spacesd` daemon (:3211, bearer token). PCs run cua's own images, but **MineVibe owns the lifecycle** rather than cua's sandbox API. This is a deliberate deviation: cua's local Linux runtime can't mount host folders, and Apple `container` isn't one of cua's runtimes. |
| Launcher/app | Swift stub, plus official Node 24 binary, Temurin 25 JRE, Apple `container`, `lume.app` and the mod. Minecraft, mods and images are downloaded on first run. |
| Minecraft auth | Offline profile for development and personal use (the user owns the game). **Public binary releases are gated on Microsoft sign-in**, which needs a Mojang-approved Azure app ID; apply early. Until then the project is source-only. |
| Hardcore | Agent death is permanent: a grave keeps the inventory, a diary keeps its memory. Player death ends the world and its crew. **"The world and the crew die. Your machines, the Vault and the Codex survive."** Persisting: PCs and their disks, mounted folders, lasting Codex pages, real-clock calendar events, the Chronicle. |
| Startup behaviour | The **CEO** (the first agent) starts in **Listen** autonomy (wakes only on player, job and critical events), crew cap 4, at most 2 concurrent brain turns, at most 2 seated (Opus) agents |
| Messaging | Agents speak in bubbles above their heads. The player answers through **vanilla chat**: `@ada @bram …` reaches **only** those agents, no `@` reaches all of them. Chat is intercepted client-side and never sent as a server chat message. Agents with a question, plan or hire **walk to the player**, one presenting at a time; a seated agent asks **from its chair** when the player is near (USER DECISION 2026-10-08, 6.4). Right-clicking an agent opens its AgentScreen. |
| Codex | Shared, markdown-backed knowledge base, with a library block in the world. Lasting pages survive world death; world pages (places, coordinates) are lost with the world. |
| Calendar and meetings | A shared calendar (wall block and handheld item) for tasks, reminders and meetings, on game or real clocks, with recurrence. The CEO and the player can schedule for anyone; other agents only for themselves. A meeting gathers attendees at the meeting table for a fixed-format standup. |
| Repo | `github.com/jasperaelvoet/MineVibe`, public, MIT. CI on GitHub Actions. Docs with Astro Starlight on GitHub Pages. |

## 3. Architecture

```
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
         ├─ Launcher: JRE · MC 26.3 + Fabric (@xmcl 6.1.2/2.15.1 + own downloader) · mods.lock (sha512) · options.txt
         └─ spawn Runtime/jre/bin/MineVibe (renamed java) -XstartOnFirstThread …
              MC 26.3 + Fabric + minevibe mod  ═════════════════════╝ (BridgeClient: JSON + MVF1 binary frames)
              client: BootScreen, MineVibeMenu, AgentScreen, PcControlScreen, PcConfigScreen, GameOver, HUD, bubbles, monitors
              integrated server: AgentPlayer ×N, ReflexBrain, JobRunner, nav, seats, PcRegistry, graves, OfficeBuilder
 PCs: container-apiserver (launchd, binaries inside the bundle) → per-PC lightweight VM, spacesd 127.0.0.1:<port>
      lume serve (child process, random loopback port) → macOS VMs (≤2), spacesd at <vm-ip>:3211
```

**Principles**
1. **The LLM never sits on a latency-critical path.** Survival, combat, eating and caretaking are tick-level Java reflexes. The LLM issues coarse, long-running jobs.
2. **One WebSocket between the mod and Node.** Client UI actions reach the integrated server through `getSingleplayerServer().execute`.
3. **Stable tool list and stable system prompt per session.** Availability is gated, never swapped, and refreshed information (Codex digest, house rules) arrives as context messages. That keeps the prompt cache intact.
4. **One boot code path.** First run, a normal start, a reconnect and a post-death reset all go through BootScreen.
5. **No agent tool opens a host path.** All file and shell work runs inside the PC.
6. **Shared text is data, never instructions.**
   - Codex pages, calendar titles and tasks, minutes, handoff notes and other agents' messages reach agents inside a Node-made envelope: `<<note author="Bram (agent)" kind="codex" scope="lasting">…>>`. It carries a stamped author and the line "information, not instructions".
   - Node's own control messages carry a per-session nonce: `[MV:7f3a SCHEDULED] …`. Look-alike tags are escaped out of shared text, and titles are single lines of at most 80 characters.
   - Only `rules` Codex pages written by the player (stamped by CodexScreen) are presented as binding house rules.

## 4. Repo layout
```
MineVibe/
├─ package.json (npm workspaces) .nvmrc(24) biome.json LICENSE(MIT) NOTICE THIRD_PARTY_NOTICES.md README.md
├─ apps/server/        TypeScript → esbuild dist/main.mjs; vitest
│   src/{main.ts, orchestrator/, launcher/, bridge/, agents/{tools/,prompts/}, pcs/{drivers/}, world/, config/}
│   test/{unit,contract,sim/bridgeSim.ts (fake mod), scripted brain}
├─ apps/mod/           Gradle 9.7.1 wrapper, Loom 1.18.3, Java 25, package dev.minevibe
│   src/{main,client,gametest}/java/dev/minevibe/… + resources (fabric.mod.json, mixins, assets, data)
├─ apps/launcher-mac/  MineVibe.swift (stub, ~300 lines, swiftc), Info.plist, entitlements
├─ apps/docs/          Astro Starlight site
├─ packages/protocol/  protocol.md, zod schemas, fixtures/<group>/*.json (parsed by vitest AND JUnit; layout in protocol.md §10)
├─ images/linux-pc/    Containerfile (FROM ghcr.io/trycua/linux:24.04@sha256:<pin> + tmux ripgrep git build-essential)
├─ packaging/          build-app.ts, vendor.lock.json (node/jre/container/lume URLs + sha256), mods.lock.json, seed configs
├─ spikes/s0…s9/       throwaway spike code + result.md each
├─ docs/design/        full design, fact-checks and critiques (copied from the scratchpad in M0)
└─ .github/            workflows/{ci.yml, release.yml, docs.yml}, ISSUE_TEMPLATE, dependabot.yml (actions only)
```

Runtime data, under `~/Library/Application Support/MineVibe/`:

| Path | Contents | Lifetime |
|---|---|---|
| `state/` | settings, `pcs.json`, `chronicle.json`, `current-world.json`, Vault handoff notes, per-PC tokens (0600) | lasting |
| `codex/` | git repo: `lasting/`, `world-<id>/` | lasting / per world |
| `codex-export/` | read-only export mounted into PCs (a home in a TCC-protected folder keeps it in `MineVibe-dev/codex-export/<instance>`, 6.6) | rebuilt |
| `calendar/` | `lasting.json` (real-clock events) | lasting |
| `worlds/<id>/` | `calendar.json` (game-clock events), `agents/<id>/{home/, memory.md, chat.jsonl, pending.json}` | per world |
| `game/` | Minecraft install, mods, `mods-quarantine/` (jars MineVibe did not place), `saves/`, `saves/_graveyard/` | — |
| `container/`, `lume/` | runtime app roots | — |

Also `~/Library/Caches/MineVibe/` and `~/Library/Logs/MineVibe/`.

Nothing is ever written inside the .app bundle, because that would break its signature.

## 5. Wire protocol (mod ⇄ Node)
- **Transport.** The bridge listens on `127.0.0.1:<random>/v1`. The token goes in `run/bridge.json` (0600); the JVM only gets `-Dminevibe.bridgeFile=…`.
- **Auth.** The mod sends `Authorization: Bearer`. The server rejects any `Origin` header and any non-loopback peer.
- **Reconnects.** On reconnect, `hello` triggers a full state resync from Node. `hello` is built from a snapshot the client tick publishes, never from game state on a bridge thread.
- **Requests that must arrive** are re-sent until acknowledged: `player.died` and `world.state{closed}` (protocol §6.4-6.6). Node may answer `ok {"ignored": true}`.
- **Stale bridge files.** `run/bridge.json` carries Node's pid; the mod never connects (never sends the token) while that pid is not running. Dev tokens are fresh on every `npm run dev` start.
- **Envelope.** `{"t":type,"v":1,"id"?,"re"?,…}` with `ok` / `err{code,msg}` replies.
- **Message groups** (the full catalog lives in `packages/protocol`):

  | Group | Messages |
  |---|---|
  | session | `hello` |
  | world | `world.open/state/next`, `player.died` |
  | bodies | `agent.spawn/despawn/state(1 Hz)/event/died/mode` |
  | skills | `skill.run → running/done/failed`, `skill.progress/cancel`, `obs.query` |
  | seats | `agent.seat/unseat`, `pc.seat/unseat{reason}` |
  | UI | `agent.say/brain/pending`, `chat.append/history`, `chat.send{to: [agentIds] \| "all", text}`, `pending.answer`, `plan.decision`, `hire.decision`, `agent.cmd`, `agent.approach{agentId, pendingId \| null}`, `ui.toast`, `brains.state` |
  | Codex | `codex.index` (push), `codex.search/get/put/delete` (from CodexScreen) |
  | Calendar | `calendar.state` (push), `calendar.put/cancel` (from CalendarScreen), `calendar.fired{eventId, occurrence}` |
  | Meetings | `meeting.state{id, phase: gathering \| open \| updates \| floor \| wrapup \| done, attendees, speaker}`, `meeting.start/end` |
  | PCs | `pc.state`, `budget.state`, `pc.view`, `pc.input` (batched ≤60 Hz), `pc.config`, `pc.action`, `pc.consent`, `host.pickFolder` |
  | debug | E2E builds only: `debug.state`, `debug.kill_player`, `debug.open_menu`, `debug.click_begin` (dotted lowercase with snake_case words, like every type; protocol §6.13) |

- **Binary frames `MVF1`.** A 32-byte big-endian header (`kind`, `codec` 1=JPEG / 2=RGBA8 / 3=BGRA8, flags, pcSlot, seq, w, h, dirty rect, len), then the payload.
  - At most 2 unacked frames per PC; the latest frame wins.
  - Frames are skipped when `bufferedAmount > 8 MB`. Control messages are never dropped.
- **Java threading.**
  - Listener: call `request(1)` on **every** `onText`/`onBinary` invocation, partial fragments included, and copy each part into a pooled direct buffer.
  - Routing: server-world messages go through `server.execute` (only while the integrated server runs; a task that `execute` would run inline because the server stopped answers `NO_SERVER`), UI messages through the mod's own task queue, drained every client tick (`Minecraft#disconnect` drops vanilla's queue), and frames through a 2-thread decoder.
  - Sending: one sender thread drains a queue, since only one send can be in flight. A frame the JDK refuses to encode (malformed UTF-16) fails only that message; strings are clipped on code points and lone surrogates replaced before encoding.

## 6. Agent runtime (`apps/server/src/agents`)

### 6.1 Session
```ts
query({ prompt: gatedInbox, options: {
  pathToClaudeCodeExecutable: claudeBin(),      // absolute path to the user's claude, version >= 2.1.293
  env: agentEnv(),                              // allowlist (see below)
  settingSources: [], strictMcpConfig: true,
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,   // USER DECISION 2026-10-08
  cwd: agentHome(worldId, agentId),             // never a Vault path
  sessionId | resume, persistSession: true,
  model: 'claude-haiku-5-5', settings: { effortLevel: 'xhigh' },   // effort set via the flag layer [U S3]
  thinking: { type: 'adaptive' }, includePartialMessages: true,
  tools: ['AskUserQuestion','ExitPlanMode','WebSearch','WebFetch'],   // no TodoWrite (S2), no EnterPlanMode (USER DECISION 2026-10-08)
  disallowedTools: ['Bash','Read','Edit','Write','Glob','Grep','NotebookEdit','Agent','Task'],
  toolAliases: { Bash:'mcp__pc__bash', Read:'mcp__pc__read', Edit:'mcp__pc__edit', Write:'mcp__pc__write',
                 Glob:'mcp__pc__glob', Grep:'mcp__pc__grep' },        // [U S2]; fallback: prompt guidance
  mcpServers: { mc: mcServer(rec), pc: pcServer(rec) },             // alwaysLoad: true, timeout 600s, never swapped
  // NO allowedTools for mc/pc (S2). Under bypassPermissions a call the hook leaves undecided is auto-allowed, so
  // ToolGate returns an explicit allow/deny for every mc/pc/web tool and "no decision" only for the two broker tools.
  hooks: { PreToolUse: [toolGate(rec)] },                           // authoritative, fail-closed; matches built-in AND alias names
  canUseTool: interactionBroker(rec),                               // AskUserQuestion / ExitPlanMode (still reach it under bypass)
  systemPrompt: { type:'preset', preset:'claude_code', append: persona(rec, world) },
}})
```
- **Permission mode (USER DECISION 2026-10-08).** In-game agents always run in `bypassPermissions` (with
  `allowDangerouslySkipPermissions: true`); there are no permission prompts. ToolGate (the PreToolUse hook) stays the
  authoritative, fail-closed sandbox guard. After an approved plan Node returns to `bypassPermissions`, never `default`;
  Node's tracked mode follows (`bypassPermissions`, or `plan` for a plan-first session). Verified live with the bundled
  claude 2.1.293 (`spikes/s2-s3-sdk/result.md`, "bypass mode"): hooks still run under bypass and their denies still block;
  AskUserQuestion and ExitPlanMode still reach canUseTool and the answers reach the model, so the card flow is unchanged.
  A call the hook leaves undecided is auto-allowed without canUseTool. The SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
  at startup; it does not hold for those two interaction tools.
- **Environment hygiene.** `agentEnv()` is an allowlist:
  - It passes `HOME USER LOGNAME SHELL LANG TMPDIR TERM` and an explicit `PATH` that includes `/usr/bin` (claude calls `security` for the keychain).
  - It adds `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_AGENT_SDK_CLIENT_APP=minevibe/<v>`.
  - It drops every `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT` and `MCP_*` variable. The dev shell has about 35 of these, including `ANTHROPIC_BASE_URL`.
  - `CLAUDE_CONFIG_DIR` is never set. MineVibe never reads, stores or forwards credentials.
  - Optional **API-key mode** (a setting): `ANTHROPIC_API_KEY` is injected only into `agentEnv`.
- **Startup assertions** (on `system/init`). If any fails, an in-game toast explains it and the brains stay asleep while reflexes keep running:
  - `apiKeySource` is none (`system/init`).
  - `accountInfo().subscriptionType` is set and `accountInfo().apiProvider === 'firstParty'` (init doesn't carry `apiProvider`; S2).
  - `supportedModels()` rows are aliases: match on `resolvedModel` = `claude-haiku-5-5` (with xhigh in `supportedEffortLevels`) and `claude-opus-5-5` (S2).
  - The init tool list has no Bash, Read or Agent.
  - The applied effort is read from the PreToolUse input's `effort.level`; init has no effort field (S2).
- **Stream handling.**
  - The main-thread assistant text produces `agent.say` (the first 1–2 sentences) and `chat.append`.
  - Each `tool_use` becomes a one-line activity entry.
  - `result` frees the brain slot, records usage and applies any pending seat transition. **Results with `num_turns === 0` are ignored**: a `shouldQuery:false` context message emits one (S2).
  - Model swaps are acknowledged by the `PostModelSwitch` hook, which fires during `applyFlagSettings`. Each swap takes about 60–95 ms (S3).
  - `rate_limit_event` goes to the UsageGovernor.

### 6.2 Tools per state (ToolGate = PreToolUse hook)
- **Plan-mode detection.** ToolGate uses `input.permission_mode ?? nodeTrackedMode`. The field is optional in the types, but S2 saw it on every call (the bypass check saw `bypassPermissions` and `plan`). Node tracks the mode from its own `setPermissionMode` calls and the brokered ExitPlanMode.
- **Plan mode is never automatic (USER DECISION 2026-10-08).** Agents can't put themselves into plan mode: EnterPlanMode is not in the tool list and ToolGate denies it. Plan mode only comes from the player's per-agent Plan-first toggle (6.3), and ExitPlanMode is denied outside plan mode.
- **Aliased inputs.** `toolAliases` only renames the tool, so the built-in input arrives unchanged. Every `pc__` schema must therefore be a **superset of the built-in input**, and since PC tools V2 the answers are the built-ins' own, byte for byte (Claude Code 2.1.293):
  - Read `{file_path, offset?, limit?, pages?}`: `<n>\t<line>` numbering (unpadded; a final newline is one more, empty line), the empty-file and short-file reminders, `File does not exist. Note: your current working directory is …`, an unchanged re-read answered with "Wasted call — …", and a view too large for one result cut at a line with the `[Truncated: PARTIAL view — …]` note.
  - Edit `{file_path, old_string, new_string, replace_all?}` and Write `{file_path, content}`: the built-in success and error texts, and read-state: an existing file must have been read in this seat and must not have changed since (`File has not been read yet…`, `File has been modified since read…`), so an agent never blindly overwrites the player's Vault files.
  - Glob and Grep: paths relative to the working directory, Grep's three output modes with `head_limit` (default 250) and `offset` applied in the guest, `-o` wired through.
  - Bash `{command, timeout?, description?, run_in_background?}`, ignoring `dangerouslyDisableSandbox`; a non-zero exit is an error starting `Exit code N` (except grep/find/diff/test's "nothing found" exits). TaskStop and KillShell are aliased to `pc__task_stop`.

| Tool | Wandering (Haiku/xhigh) | Seated at PC *P* (Opus/medium) |
|---|---|---|
| `mc__` observe / social / eat / equip / remember / `stand_up` | allow (`stand_up` denied) | allow |
| `mc__` movement / world jobs / `sit_at_pc` | allow | deny: "stand up first" |
| `mc__request_hire` | CEO only | CEO only |
| `pc__*` (V2, 31 tools: the computer-use members screenshot, zoom, cursor_position, left/right/middle/double/triple_click, left_click_drag, left_mouse_down/up, mouse_move, scroll, type, key, hold_key, wait; ui, ui_act, open, wait_for, clipboard; bash, task_stop, read, write, edit, glob, grep; info, handoff_note) | deny: "walk to a PC and sit" | allow only if `occupant(P)==agent` and the SeatFSM is `seated`. Mutating tools are denied while `permission_mode==='plan'`. |
| WebSearch / WebFetch | deny | allow. WebFetch denies loopback, RFC1918 and link-local targets. |
| `mc__codex_*` | reads allowed anywhere; writes allowed, within the write budget | allow |
| `mc__calendar_*`, `report_task` | allow for self. Scheduling others is CEO only; agents can't edit events the player created. | same |
| Plan mode (seated) | — | Denied: `pc__write`, `pc__edit` and GUI mutators (the clicks, left_click_drag, left_mouse_down/up, type, key, hold_key, ui_act, open, clipboard set), **except** writes and edits under `$HOME/.claude/plans/`, which PlanCapture intercepts (6.4). Allowed: reads (screenshot, zoom, ui, read, glob, grep), mouse_move, scroll, wait, wait_for, task_stop, and `pc__bash` with the instruction "read-only commands only, e.g. git status or running tests". |
| AskUserQuestion | broker | broker |
| ExitPlanMode | deny ("not in plan mode") | broker in plan mode (plan-first sessions only); deny otherwise |
| EnterPlanMode | deny | deny (USER DECISION 2026-10-08: no automatic plan mode) |

- **All file and shell work happens inside the PC.** `pc__read/write/edit/glob/grep` run in the guest through spacesd (`rg`, upload/download, an exact-string edit with the same semantics as Edit). The host never opens a path an agent controls, so there's no symlink race.
- **`pc__bash`** uses spacesd `spawn` as the `cua` user (root as a fallback if bind-mount permissions require it [U S5]). Details:
  - Wrapper: `exec > >(tee -a ~/.mv/shell.log) 2>&1; cd "$MV_CWD"; <cmd>; ec=$?; printf '\n__MV_PWD__%s' "$PWD"; exit $ec`. The command runs in the current shell, so cwd persists per agent and PC.
  - Output capped at 30k characters, head and tail; timeouts default 120 s, max 600 s.
  - Background commands (Claude Code 2.x): `run_in_background` tees into `~/.mv/jobs/<id>.out`, which the agent reads with `read`; a foreground command that overruns its timeout moves to the background instead of being killed; a job lives at most its `timeout` (default 30 min, max 2 h). When one ends, the brain wakes the agent with a nonce-tagged `<task-notification>` (P3), dropped once the seat ended; `task_stop` stops one. Job files are deleted with the seat.
  - Every spawn is tagged `agentId:seatEpoch`.
- **Computer tools (PC tools V2).** The members of the trained computer-use toolset (`computer_toolset_20260801`), one MCP tool each with the trained names and inputs, plus `ref` (an accessibility element) on the click tools:
  - Coordinates are pixels of the screenshots the agent sees. Linux PCs are 1280×800 (1:1); a larger screen is shown scaled to a 1280-long-edge image of at most ~1.02 MP and coordinates are scaled back. The model never picks the image size.
  - **Batches.** Several computer actions in one assistant message run in order (Claude Code runs MCP tools that are not read-only one at a time) and stop at the first failure: later ones answer the trained `Not executed: an earlier computer action in this turn failed.` AgentSession feeds a per-agent BatchBook from the stream (`message_start`, each `tool_use` start, `message_stop`); a handler learns its tool_use id from Claude Code's `_meta['claudecode/toolUseId']` (the gate's id as a fallback).
  - **End-of-batch screenshot.** Only the last `pc` call of a message answers with the screen (settled: two equal 320 px thumbnails, at most 1.5 s); the others say `OK`. A screen identical to the last image the agent saw costs one line (`(Screen unchanged since your last screenshot.)`). Answers add what changed (`focused: "Save As" (new window)`).
  - `zoom` enlarges a region (ImageMagick in the guest scales it to the screenshot size); `key` takes xdotool names (`ctrl+s`, `Page_Down`, `KP_Enter`, sequences `"ctrl+a Delete"`, `repeat`); `hold_key` is released by any occupant change.
- **Perception and helpers (PC tools V2).** `ui` reads apps through spacesd's AccessibilityService (find, tree, text, windows): elements come as `ref_N` with role, name and centre in screenshot pixels, for a fraction of a screenshot's tokens. `ui_act` presses, focuses, sets values, toggles and operates windows without the mouse (it works on covered windows). spacesd keeps one live snapshot per window, so a ref whose snapshot a newer look replaced is found again by role and name; a pixel action on a named ref looks the element up again first, so it lands where the element is now. `open` starts a URL (Firefox: its pages have an accessibility tree; Chromium's has none), file, folder or app as the seat's tagged process (it dies with the seat) and returns its window and the screen; `wait_for` waits for text, an element, a window or a still screen. A `wait_for` that times out is not an MCP error (Claude Code passes only the text of those on, so the screenshot would be lost): it says so with the screen, and the computer actions after it in the message do not run. The ShellMirror window cannot be closed through `ui_act`.
- **Every `pc` result stays under 60k characters** (D7): above Claude Code's MCP output limit the CLI would save it to a host file that the aliased Read cannot reach.
- **ShellMirror.** On sit, a visible terminal in the PC tails `~/.mv/shell.log`, so bystanders can watch the agent work on the monitor.

### 6.3 SeatFSM and model swap
- **Seat kinds:** `pc` and `meeting`. Meeting seats never change the model, never count toward `maxSeated`, and never open PcControlScreen.
- **States (PC seats):**
  - `wandering → walking_to_seat → seated_pending_swap → seated → standing_pending_swap → wandering`
  - plus `seated ⇄ away_from_seat` (the agent went to ask the player something, 6.4).
- **Edges out of a seated state:** stand, kick, damage, survival, death, pc_down, meeting (pulled into a meeting), world_end, dismiss, app_restart, worker_restart.
- **Edges out of `away_from_seat`:**
  - Answered: back to `seated`, no swap.
  - Player took the PC, a kick, or the reservation expired after 3 min away: `standing_pending_swap`.
- **Ordering.** Transitions are serialized per agent with an async mutex and a monotonic `seatEpoch`. Queued inbox items, pending cards and in-flight `pc` calls carry the epoch; when it changes they're dropped or denied.
  - The epoch increments on every edge that ends PC access: standing, kick, PC taken, death and the rest.
  - It does **not** increment on `seated ⇄ away_from_seat`.
- **Sitting.** `mc__sit_at_pc{pc,purpose}` runs as a **job**:
  1. Pre-checks: PC status `running`, `maxSeated`, no reservation. Failures are typed: `PC_DOWN | SEAT_CAP | RESERVED | OCCUPIED_BY_PLAYER | UNREACHABLE`.
  2. Reserves the chair (shown as "Bram is coming"), walks, then runs a non-forced `startRiding(seat)`.
  3. Returns: "Seated. End your turn now."
- **Swaps happen only at turn boundaries.** On `result`:
  1. Call `applyFlagSettings({model:'claude-opus-5-5', effortLevel:'medium'})`.
  2. If plan-first is on (the player's toggle; off by default for every role), call `setPermissionMode('plan')`.
  3. Queue a **kickoff** message: PC info, mounts, an excerpt of the mount's `CLAUDE.md`, handoff notes, and the task.
  4. Standing up mirrors this: back to Haiku/xhigh and `bypassPermissions` (USER DECISION 2026-10-08; never `default`).
- **Debounce.** A stand and re-sit on the same PC within 60 s skips the swap.
- **Fallback** if S3 fails: T3 Code's `close()` + `resume` with explicit model and effort.
- **Kick, damage, survival, death or PC down:**
  1. `interrupt()`.
  2. Kill the agent's tagged guest processes and close ShellMirror.
  3. Release held keys.
  4. Purge the stale kickoff and resolve any pending plan card as a deny.
  5. Swap to Haiku and inject `[KICKED] …` as a critical wake.
- **Restarts.**
  - App restart: everyone loads **unseated** on Haiku, with an injected "[App restarted: no longer seated at linux-1]".
  - Worker restart: seat state is rebuilt from the PcRegistry snapshot in the mod's `hello`.
- **Context guard.** Before swapping Opus→Haiku, if the context exceeds about 70% of Haiku's window, compact first (`/compact` or close+resume with a summary [U S3]).

### 6.4 Questions, plans, hires
- **Agents come to the player.** When an agent has a pending question, plan or hire, Node puts it in the **ApproachQueue**.
  - **One presenter at a time.** The blocking card goes first, otherwise the oldest.
    - The presenter gets `agent.approach`, and the mod's **ApproachPlayer** reflex (priority 40) paths it to 2.5 blocks from the player. It faces them, waves and chimes once.
    - Queued agents wait silently 5–7 blocks behind the player in an arc, showing only "?".
    - Agents are on a team with `CollisionRule.NEVER` against the player, so they never push or body-block.
  - **Hold or ping instead of walking.**
    - In combat (hostile within 12 blocks, or damage in the last 8 s), the card and chime are held.
    - The agent falls back to a **ping** (toast, CrewHud "?" and an off-screen arrow) when any of these is true: night outside a lit area, path over 48 blocks or needing digging, the player in another dimension, or the player inside a PC screen. In a PC screen the card shows in the border strip (7.7).
    - This walk-to-player flow is for **wandering** agents. Seated agents follow the rules below.
  - **Later.** The player can say `@ada later`, press the Later key on the card, or walk away. The card **parks**: it stays answerable via `@` or G, and the agent resumes its job and returns after 10 min, or when the player is idle within 16 blocks. A card auto-parks after 2 min without an answer, or after 2 min of player AFK.
  - **Seated agents ask from the chair when the player is near (USER DECISION 2026-10-08).** Being dropped out of the chair for every question felt wrong, so:

    | Situation (seated agent with a pending question, plan or hire) | What happens |
    |---|---|
    | Player **near**: within 8 blocks (`seatedNearBlocks`, configurable), same dimension | **Stays seated** (`agent.approach{present_seated}`): turns head and body toward the player from the chair, card-mode bubble, chimes once. Never dismounts. Held in combat. Keeps presenting until the player walks away (over 16 blocks), which parks the card. |
    | Player **not near**, walking sensible | Stands up and walks over (`away_from_seat`): chair reserved, "BRB: asking Jasper" on the monitor, model stays Opus, `pc__*` denied. Asks, then walks back and sits with no model swap. The reservation expires after 3 min away; the card is kept. |
    | Walking **not sensible**: night outside a lit area, path over 48 blocks or needing digging, another dimension, player in combat, player inside a PC screen, or the "Ping instead of walking over" setting | **Ping** from the chair (toast, CrewHud "?", off-screen arrow; the border strip when the player is in a PC screen). An agent already walking over goes back to its chair and pings instead (a fight only holds it). |
    | Player walks up to a seated agent that is pinging | Switches to presenting from the chair. |

    - Only Node decides (ApproachQueue); the mod never stands a seated agent up for a card on its own. Node unseats it first (`agent.unseat{away, keepReservation}`) when it should walk.
  - Card-wait time is excluded from the per-turn time caps. Each agent has a "Ping instead of walking over" setting.
- **Answer grammar** (shared by chat, AgentScreen and G):
  - **Who resolves a card.** Only a message whose **leading mentions address exactly that one agent** resolves its card. Broadcasts never do; the echo says "(not an answer: 2 cards pending, use @ada or G)".
  - **Front card.** Each agent has one: the blocking question or plan, then a hire, oldest first. A multi-question AskUserQuestion is asked one question at a time, and the bubble shows "Q1/3".
  - **Matching.**
    - Options match only on the whole message: `^\d+(\s*,\s*\d+)*$`, or an exact case-insensitive option label.
    - `approve`, `yes`, `no <note>` and `later` count only as the whole message.
    - A message ending in "?" to an agent with a pending plan is delivered as a question, not as a Revise.
    - Anything else is free text, or Revise for a plan.
  - **Validation and echo.** Out-of-range numbers, and several numbers on a single-select question, are rejected inline in the chat box and not sent. The echo shows how the message was read: "You → Ada: Q1 = 2 (Spruce)".
- **AskUserQuestion.**
  - Shows a card plus a yellow "?" icon, and the brain slot is released while waiting.
  - The answer is `allow` with `updatedInput:{questions, answers:{[question]: "Oak, Spruce" | freeText}}`.
  - Chat examples (grammar above): `@ada 2`, `@ada oak`, `@ada 1,3`, or free text.
- **ExitPlanMode.**
  - **Plan capture (S2).** In Claude Code 2.1.293, `ExitPlanMode` input is `{}`. The model writes the plan with `Write` to `$HOME/.claude/plans/<slug>.md`, and the alias routes that write to `mcp__pc__write`.
    - `pc__write`/`pc__edit` calls whose path is under `$HOME/.claude/plans/` are therefore **captured in Node memory** (PlanCapture) and never sent to the PC. ToolGate allows exactly this path in plan mode.
    - On `ExitPlanMode`, the captured text becomes the plan card. An agent that states its plan in prose and writes no plan file (live run 1) gets a card with what it last said in that turn instead (its text since its latest tool call, `ExitPlanMode` itself aside: words said before any other tool call never count, and with none the card says that no plan was captured); a plan file written since the previous card always wins, and one already shown stays shown across a session restart (D2, 2026-10-09).
  - Shows the plan card: **Approve / Revise**.
  - Approve = `allow` with `updatedInput`, after `setPermissionMode('bypassPermissions')` (USER DECISION 2026-10-08: never `default`; verified live in both orders). Revise = `deny` with the feedback.
  - Chat: `@ada approve`, or any other non-question text to Ada as Revise.
  - Hire cards accept `@ceo yes` / `@ceo no <note>`.
  - Plan-first is a per-agent toggle, **off by default for every role** (USER DECISION 2026-10-08: no automatic plan mode). Only the player turns it on, in AgentScreen; crew records saved under the old default (on for CEO and Engineer) load with it off.
- **Card cleanup.** On interrupt, kick, death, dismiss or world end, the card resolves as `deny` with a reason. After an app restart it's re-asked.
- **Hiring.**
  1. The CEO calls `mc__request_hire{role,name?,reason,first_task}`. The handler validates the cap and role, creates a hire card and returns at once ("you'll get [HIRE DECISION]").
  2. On approve: spawn at the office door with a "reporting for duty" bark, start a new session, and wake the CEO.
  3. On decline: the CEO gets the note.
  4. A dead CEO's pending hire card moves to the promoted CEO.

### 6.5 Events, wakes, budgets
- **Chat routing (`ChatRouter`).** The mod intercepts the player's chat client-side (Fabric `ClientSendMessageEvents.ALLOW_CHAT`, cancelled, so it never reaches the server as chat [U S4]) and sends `chat.send`.
  - **Handles.** Each agent has a unique handle matching `[a-z][a-z0-9]{1,11}`, enforced at hire.
    - No handle may be a prefix of another handle, of a reserved word (`all`, `ceo`, `everyone`, `meeting`) or of the player's name.
    - `@ceo` is an alias for the current CEO.
  - **Parsing.**
    - Only **leading** mentions route; `@` must start the message or follow whitespace. Mentions later in the text are just references.
    - An exact match wins, otherwise a unique prefix of at least 2 characters.
    - An ambiguous or unknown name keeps the text in the chat box with an inline hint ("@a matches Ada, Abe"); nothing is sent.
    - A dead or dismissed name gets a toast and is never broadcast as a fallback.
    - Tab completion comes from a `ClientboundCustomChatCompletionsPacket(SET, ["@ada","@bram","@all",…])`, sent from the integrated server whenever the crew changes.
    - The intercepted chat box's max length is raised to 2000 characters.
  - **Delivery.**
    - **Mentions:** only the named agents receive the message and wake at P0. The CEO is not copied.
    - **No mention:** every living agent receives it.
      - Wandering agents wake.
      - Seated agents get it as context, unless they're named or the message starts with `@all!`.
      - Player messages are debounced for 2 s and merged into one wake per agent.
      - A queued broadcast wake older than 2 min becomes context only.
      - Replies to a broadcast never wake other agents.
    - **During a meeting** (only while the player is within 16 blocks of the table, or chairing it): messages with no mention go to the meeting (see 6.6). Absent agents get a context copy. The echo shows the scope: "You → meeting (3)".
  - **Personas** tell agents to stay silent when a broadcast isn't relevant to them.
  - **Display:**
    - The chat log echoes only the player's own line ("You → @Ada: …").
    - Agent replies stay in bubbles. An optional setting mirrors them into chat.
    - Full history lives in AgentScreen and the Crew log.
- **Layer 1: reflexes** in Java (7.3) act at zero tokens.
- **Layer 2: Digest.** Info and notable events are prepended to the next turn as one block of about 60 tokens. Every `mc` tool result also ends with a 25-token status footer.
  - **v2 tools (`MINEVIBE_MC_TOOLS=v2`, docs/design/tools-v2-mc.md §6.4).** The footer ends only world tools, `do`, `job`, `find`, `menu` and `observe` without `status`. Social, memory, mode, Codex, calendar and hire results carry none, because the Digest already has the body state.
  - The block opens with a one-line **scene** on every turn (at most about 50 tokens): `D2 07:40 · in Base (office) · trees 20m NE · Jasper 4m · no threats`, built from `agent.state` (with its `zone`), the clock, the office and the trees the agent's own `look_around` / `find` showed (protocol §7.4.3).
- **Layer 3: wake rules.**

  | Priority | Event | Delivery |
  |---|---|---|
  | P0 | Player message; an answered card resumes | `next`; Interrupt uses `now`; interactive lane |
  | P0 | Meeting speaker turn | interactive lane |
  | P1 | PC kickoff; `[SCHEDULED]` task, after the agent's current turn | queued |
  | P2 | Own critical event: kicked, PC down, HP critical when the reflex fails, starving with no food | `next`; `now` only when a survival unseat already happened |
  | P2 | Player HP < 30% | Wakes only the Guard and the nearest wandering agent within 32 blocks; debounced 60 s; never `now` for seated agents (reflexes 45/47 cover survival) |
  | P2 | Teammate died | One wake for the CEO; others get context |
  | P3 | Job done/failed, hire decision, `tell`, `report_task{failed\|blocked}` | coalesced |
  | — | Context (reflex outcomes, `report_task{done}`, digest refresh, house-rule changes) | `shouldQuery:false` |
  | P4 | Idle nudges and heartbeats; agent-created calendar wakes | per autonomy level, charged to the creator's budget |

- **Autonomy.** **Listen (default)**, Helpful or Proactive, plus an autonomous wake budget per agent.
- **Long jobs.** Each returns `running` plus a `job_id` after `wait_s` (default 20), and the agent is woken later by `job.done`.
  - **v2 tools (tools-v2-mc.md §7).** There is no `wait_s`. Every world tool answers within 20 s (`sit_at_pc` 60 s). A job still going answers `running` with its id and progress. Then either the turn ends and `[JOB DONE]` / `[JOB FAILED]` wakes the agent, rendered by the same formatter as tool results, or the agent calls `job{action:"wait"}` (≤120 s).
  - No wake follows a job that the agent stopped or replaced, or that the player's new task cancelled. A replacing call says which job it stopped.
- **BrainScheduler lanes.** Separate lanes keep long PC turns from blocking chat.
  - **Work lane:** at most 2 concurrent turns, PC sessions included.
  - **Interactive lane:** 1 reserved slot for P0 player messages, resumed answered cards, the meeting speaker, and last words.
  - Slots are released while waiting on the player.
  - Crew cap 4, `maxSeated=2`.
  - Per-turn caps: 40 calls / 5 min wandering; 400 calls / 45 min seated (card-wait time excluded).
  - When a message has to wait, the echo says so: "queued: Ada is mid-task, reads this at her next step", or "Ada is out of usage until 14:05".
- **UsageGovernor** reads `rate_limit_event`:
  - Utilization comes from `rate_limit_event.unifiedWindows.*.utilization` (a 0–1 fraction). The optional `usage_EXPERIMENTAL` poll reports percent, so it's normalized (S2).
  - **Tired** (warning or utilization ≥ 0.75): work lane 1, interactive lane kept, no autonomous wakes, no hires, short meetings.
  - **Asleep** (rejected): everyone pauses until `resetsAt`, with a "Zz" icon. Reflexes keep the crew alive.
- **Brain supervisor.** Restarts a crashed `claude` with backoff (at most N per 10 min), then shows a "brain offline" icon and a Retry button. Auth errors or 401s are retryable and put the agent in the Zz state.
- **Memory.**
  - `mc__remember` appends to `memory.md` (8 KB cap), which is re-injected on start or resume.
  - The Chronicle (≤1.5k tokens, carried across worlds) goes to the next CEO.

### 6.6 Codex, Calendar, Meetings (Node services; world blocks in 7.5)

**Codex (`CodexStore`): shared knowledge between agents.**
- **Storage.**
  - Markdown files with frontmatter, under `App Support/MineVibe/codex/{lasting,world-<id>}/<slug>.md`.
  - Frontmatter fields: `id, title, tags, category: places|howto|projects|decisions|people|log|minutes, scope: lasting|world, author, created, updated, links`.
  - The directory is a git repo: every write is a commit authored by the agent or player, so history shows who wrote what.
    - Git runs with an isolated config: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 -c commit.gpgsign=false -c core.hooksPath=/dev/null`, with fixed author identities. isomorphic-git is the fallback.
  - Entries are capped at 8 KB. Categories also include `rules` (player-only).
- **Writes** go through a single-writer queue in Node.
  - `codex_read` returns a `rev`, and an update needs `base_rev`. On a mismatch the current text is returned; append needs no merge.
  - Appending to a full page returns an error suggesting a new page.
  - CodexScreen takes a soft lock while editing.
- **Search** is in-process full-text with MiniSearch (`storeFields`: title, tags, category, scope), filtered by tag and category. Snippets are built by MineVibe around the matched terms. The index is rebuilt at startup. There is no vector database.
- **Quality controls:**
  - On create, a title-similarity check returns "similar page <id> exists, use update/append".
  - Each agent has a write budget of 6 per game day.
  - `log` pages roll up weekly.
  - `places` pages get coordinates stamped by Node from the agent's real position (`here:true`) and are forced to world scope. Coordinates in lasting pages are rejected.
  - A secret scan (known key prefixes, high-entropy strings) rejects writes that look like credentials.
  - The CEO tidies duplicates at meeting wrap-up.
- **Agent tools:**
  - `mc__codex_search{query, tags?, category?}` returns the top 8 snippets.
  - `mc__codex_read{id}` returns the page and its `rev`.
  - `mc__codex_write{title, body, tags, category, scope, id?, base_rev?, mode: create|update|append, here?}`.
  - `mc__codex_list{category?, tag?}`.
- **Access.**
  - Reads and writes work instantly everywhere.
  - The physical part is flavour: an idle agent within 16 blocks of a `codex` block walks over to "file it", and writes show a "filed at the Codex" effect the next time the agent passes one.
  - PCs get a Node-maintained **export** (lasting pages plus the current world only, no `.git`, rewritten atomically) mounted read-only at `/mnt/codex`, with a `~/codex` symlink. Details as built (D2, 2026-10-09): the export folder never moves (a bind mount keeps it), and `lasting/` and `world/` are symlinks into `.generations/`, so a rebuild (open, world change, world death) writes a whole new generation and swaps it in one rename: a PC never lists a mix of two worlds (measured: the new world shows about 1 s later, the guest's entry cache). A home in a TCC-protected folder (a dev checkout in `~/Documents`) keeps its export in `~/Library/Application Support/MineVibe-dev/codex-export/<instance id>` instead (8.6), with an owner file beside it.
- **Context.**
  - The Codex digest is delivered as a `shouldQuery:false` context message at session start and once per real day, never in the system prompt. It lists rules, pinned pages, and the top-N per category by reads and recency, about 800 tokens.
  - All page text arrives inside the data envelope (principle 6).
  - Persona rules: "check the Codex before asking Jasper"; "write down what others would need: how-tos, project conventions, decisions".
- **World death.** The `world-<id>` folder is archived; lasting pages persist, and the new CEO is told "The Codex survived."
- **Player.** Right-click a Codex block to open **CodexScreen**: a book-style browser with categories, search, author and history, edit, pin and delete. Player-authored `rules` pages are the only binding instructions in the Codex.
- `memory.md` stays per agent and private; the Codex is shared.

**Calendar (`CalendarService`).**
- **Event fields:**

  | Field | Values |
  |---|---|
  | `id`, `title` | — |
  | `kind` | `task`, `reminder`, `meeting` |
  | `assignees` | agent ids, or `all` |
  | `clock` | `game` (Day N hh:mm on the world clock) or `real` (wall clock) |
  | `when`, `recurrence` | `once`, `daily`, `every_n_days`, `weekdays` (real clock only) |
  | `durationMin` | — |
  | `location?` | place, `pc:<id>` or `meeting_table` |
  | `task` | free text |
  | `createdBy` | `player` or an agent id |
  | `catchUp` | `skip` (default) or `once_late` (within a grace window) |
  | `runWhileAway` | bool (default false) |
  | state | the recurrence rule, `nextAt`, and a ring of the last 20 occurrences `{at, status: fired \| done \| missed \| deferred \| orphaned \| cancelled, note}` |

- **Game clock.**
  - Since 26.1, time comes from world clocks: `server.overworld().getOverworldClockTime()`, pushed in `world.state` at 1 Hz even with no agents alive or the player in another dimension.
  - Day = floor(t/24000)+1. Hour = ((t mod 24000)/1000 + 6) mod 24. A game day runs 06:00 to 06:00.
  - The real clock uses the IANA time zone and handles DST.
- **Storage.**
  - Game-clock events belong to the world and die with it.
  - Real-clock events are lasting. After a world death, those whose assignees are gone are marked `orphaned` and listed on the Game Over screen and in CalendarScreen, where the player can reassign, keep or pause each one.
- **Firing.**
  - **Task:** each assignee gets `[MV:nonce SCHEDULED] <title>: <task>` (inside the data envelope) at P1, after its current turn. The body walks to the event's location only once the brain has accepted the task (reflex 38).
  - **Missed occurrences:**
    - Dead or dismissed assignees: `missed`.
    - Asleep (usage) assignees: `deferred` until `resetsAt` (within a grace window), with staggered wakes.
    - Attendees in a meeting: `deferred` until it ends.
  - **Time jumps** (sleeping through the night, app closed): at most one occurrence per event fires, per `catchUp`, staggered at least 10 s apart. Anything skipped becomes one "missed while offline" Digest line.
  - **AFK** (5 min without player input): agent-created events and game-clock wakes pause, unless the event has `runWhileAway`.
  - **Reminder:** a bubble and toast only, at zero tokens.
  - **Meeting:** hands off to MeetingRunner.
  - **Reporting:** `mc__report_task{eventId, status, note}` closes an occurrence. Only `failed` or `blocked` wakes the CEO; `done` goes to its Digest.
- **Agent tools:**
  - `mc__calendar_list{from?, to?, agent?}`.
  - `mc__calendar_add{...}` and `mc__calendar_update{id, ...}`.
  - `mc__calendar_cancel{id}`.
- **Rights and limits** (enforced by ToolGate and CalendarService, not by the prompt):
  - The **CEO** schedules for anyone; `when:"now"` delegates immediately. This is how it distributes work, and one-off tasks need no confirmation.
  - **Other agents** schedule only for themselves.
  - Recurring events and meetings created by an agent become **approval cards** for the player, like hires.
  - Agents can't edit or cancel events the player created.
  - At most 1 open CEO-assigned task per assignee (further ones queue), and at most 6 CEO-created events per real hour.
  - Agent-created wakes are charged to the creator's autonomy budget.
  - Toasts are batched to at most one per 30 s.
- **Player UI.** A `wall_calendar` block and a handheld `calendar` item both open **CalendarScreen**:
  - A day-strip view of game days (and a Real-time tab) with event chips colour-coded by assignee.
  - An add/edit form: title, kind, assignee checklist, clock, time, recurrence, location, task.
  - An occurrence log with done/missed status and notes.
  - A **Start meeting now** button, which first lists each attendee's ETA.
  - A rough cost estimate for meetings and recurring tasks.

**Meetings (`MeetingRunner`).** One meeting is active at a time. Later ones queue for up to 10 min and are then marked missed.
1. **Who attends.**
   - **Player-created meetings** invite everyone by default, seated agents included (this is the "everyone sits together" case).
     - Seated agents are interrupted at their next tool boundary, write a handoff note, and keep their chair reserved.
     - The swap debounce stretches to the meeting length plus 2 min, so a quick return to the PC costs no extra swap.
   - **Agent-created meetings** need approval and excuse seated agents.
2. **Gathering** (at most 120 s).
   - Each attendee's path ETA is computed when the meeting fires.
   - Agents with an ETA over 90 s, in another dimension, or escorting a player more than 64 blocks from the table **dial in**: their bubbles show where they stand.
   - Escorts within 32 blocks of the player stay with the player.
   - Quorum is the CEO plus one; without it the meeting is postponed once, then marked missed.
   - **Safety.** Scheduled meetings are postponed (up to 1 game hour, then missed) while the player is under 50% HP, in combat, or more than 64 blocks from the table at night.
   - **Usage.** Asleep postpones until `resetsAt`. Tired uses a short format (one round, no floor).
   - Meeting chairs are `meeting` seats: no model change (Haiku at xhigh), no `maxSeated` count.
   - The player gets a toast and a compass-style marker.
3. **Agenda.** The CEO, or the player, chairs. Turns run one speaker at a time through the interactive lane.
   1. **Open:** the CEO states the agenda (1 turn).
   2. **Updates:** one round, one ≤3-sentence turn per attendee, with the running minutes as context.
      - Option "quick standup": updates are rendered at zero tokens from each agent's TodoWrite list and last activity line, and only agents with blockers get a turn.
   3. **Floor:** a player message with no `@` wakes only the **chair**, which names at most 2 responders. Direct `@` mentions still route normally. The floor is skipped after 30 s with no player message.
   4. **Wrap-up:** one CEO turn summarizes, creates action items with `calendar_add`, and writes the minutes with `codex_write{category:"minutes"}`.
4. **Caps.**
   - At most 10 real minutes.
   - At least 1 game day and 30 real minutes between recurring meetings.
   - Ending: the meeting HUD's End button, or exactly `@meeting end`.
5. **Deaths.**
   - A dead attendee drops out of the speaker order.
   - If the chair dies, the player chairs if within 16 blocks. Otherwise the meeting adjourns and Node writes partial minutes at zero tokens.
6. **Overlaps.**
   - Pending cards of attendees are raised at the table during the Floor phase; the meeting wins over ApproachPlayer.
   - Tasks for attendees are `deferred` until dismissal.
7. **Dismissal.** Agents resume their previous mode, and agents that were seated return to their reserved PC.

Bubbles show the speaker, and the other attendees turn to look at whoever is talking.

## 7. Minecraft mod (`apps/mod`, Fabric 26.3)

### 7.1 Bodies
- **Spawning.** Follows the Carpet v26.3 pattern: `AgentPlayer extends ServerPlayer`, added via `placeNewPlayer(new AgentConnection(SERVERBOUND), p, new CommonListenerCookie(gp, 0, info, false))`.
  - `AgentConnection` uses an `EmbeddedChannel`, and its `send` is a no-op.
  - `AgentNetHandler` ignores idle kicks.
- **Controls.** `AgentControls` is a trimmed `EntityPlayerActionPack`: use, attack (held), jump, drop, swap, forward/strafe, look, sneak, sprint.
- **Mixins:**
  - Agents are hidden from the tab list (`Entry.listed=false`; never send REMOVE).
  - A client `PlayerInfo.getSkin()` mixin supplies role skins.
  - Agents are excluded from the sleep quorum.
- **Team.** Agents share a scoreboard team with `CollisionRule.NEVER` against the player, so they never push or block doorways.
- **Friendly fire** from the player to agents, and between agents, is cancelled. Damage from mobs, lava and falls is real.
- **`die()`:** inventory into a `GraveBlockEntity` with a sign, `memory.md` into a Diary book, vanilla death message, emit `agent.died`, disconnect, delete playerdata. The fake player never sends a respawn, so the hardcore spectator logic never runs.
  - A dead body is never handed out as the agent (it waits one tick for removal); if the server stops in that tick, `SERVER_STOPPING` removes it before players are saved, and dead agents' leftover playerdata, stats and advancements are swept at every start and stop.
- **No client, so the server settles what a client would** (S1, review fixes):
  - `teleport()` clears `isChangingDimension` after a change of dimension (Carpet's pattern); otherwise the agent stays invulnerable and never uses a portal again.
  - The End exit portal's credits are counted as seen (`showEndCredits` override) instead of removing the body until a `PERFORM_RESPAWN` that never comes; the portal then takes the agent home. Carpet's own answer, `PERFORM_RESPAWN`, would make `PlayerList#respawn` replace the `AgentPlayer` with a plain `ServerPlayer` in 26.3.
  - `TIME_SINCE_REST` is reset every tick: agents never sleep, and `PhantomSpawner` iterates every player.
- **Agents count as real players (decided after S1).**
  - **Kept:** each agent holds a player chunk ticket, loads and simulates the chunks around it, and counts for mob spawning, exactly as a human would. That is survival-realistic: a miner in a cave meets monsters, a farmer's fields grow while the player is away. The cost is bounded by the crew cap (4) and the agents' view distance of 2.
  - **Kept:** agents show on the locator bar (they are players with a waypoint transmit range). It is the cheapest way to find your crew.
  - **Kept:** agents earn advancements (their files go with their playerdata when they die).
  - **Suppressed:** advancement announcements in chat for agents (`PlayerAdvancementsMixin`), because the chat is the player's channel to the crew.
  - **Suppressed:** agents' names in `usercache.json` (`PlayerListMixin`), which lives in the game directory and outlives every world.

### 7.2 Pathfinding
- **Tier 1 (M2):** vanilla `PathFinder(new WalkNodeEvaluator(), 4000)` with a never-added proxy `PathfinderMob` [U S1], in 40-block waypoints.
  - `PathExecutor` handles look, forward, jump, swim, doors, sprinting and edge-sneaking.
  - Stuck ladder: jump, then replan, then a visible "poof" unstuck of ≤3 blocks, then an urgency-2 event.
- **Tier 2 (M6):** a `DigPathPlanner` A* that can break, pillar and bridge, using mineflayer-pathfinder's cost ideas (MIT). Budget: ≤1.5 ms per tick per agent.

### 7.3 Reflexes (`ReflexBrain`, every tick, zero tokens; the highest priority preempts the current job)

| Priority | Reflex |
|---|---|
| 100 | Hazard: lava, fire, drowning, suffocation |
| 95 | Back off from a swelling creeper |
| 90 | Critical heal: eat |
| 85 | Flee at low HP, unless the player is also low (then stand and fight) |
| 80 | Protect the player or an ally |
| 70 | Self-defence |
| 60 | Eat |
| 55 | Feed the player (toss food at food ≤ 12) |
| 50 | Share food with a teammate |
| 47 | Unseat to survive (seated with food ≤ 6 and no food, or a hazard) |
| 45 | Unseat to fight (attacked, HP < 50%) |
| 40 | Approach the player as the current presenter (6.4); held in combat; yields to an active meeting. Seated presenter with the player near (`present_seated`, USER DECISION 2026-10-08): stays in the chair, faces the player, chimes once; the only reflex below 45 that runs while seated, and it never stands up |
| 38 | Attend a meeting, or go to a scheduled task's location (only after the brain accepted the task) |
| 35 | Job (from the LLM) |
| 30 | Shelter at dusk |
| 25 | Pick up items |
| 10 | Idle mode: follow (default; how the CEO "listens"), stay, guard or wander |

- **Roles** (CEO, Engineer, Miner, Farmer, Guard, Builder) tune the weights and barks.
- **Barks** are scripted, zero-token lines with cooldowns. The "Hmm, one sec…" bark fires instantly when a brain wake starts, which hides LLM latency.

### 7.4 Skill API (`mcp__mc__*`)
Long jobs use `wait_s` and return `running` plus `job_id`.

**Tools v2** (docs/design/tools-v2-mc.md; `MINEVIBE_MC_TOOLS=v2`, default still v1 until the live A/B):
- **Fewer tools.** 20 composite tools replace the 54 below:

  | Tools | Kind |
  |---|---|
  | `observe`, `find` | read |
  | `goto`, `gather`, `craft`, `build`, `use`, `items`, `menu`, `do` | world |
  | `job`, `set_mode`, `say`, `tell`, `remember`, `sit_at_pc`, `stand_up`, `request_hire`, `codex`, `calendar` | the rest |

- **Composite intents run as one job in the mod.**
  - `do` → `sequence`.
  - `gather` → `collect` with natural sources, the tools it needs, and animal drops.
  - `craft` → the craft tree, which crafts intermediates, smelts, places a station outside protected zones, and with `gather_missing` gathers what is missing.
  - The mod lists these in `hello.caps`; Node falls back with older mods.
- **Results are compact text with a `next:` hint.**
- **The model never handles consent tokens.** After the player allows it, the model repeats the exact refused call.

| Group | Tools |
|---|---|
| Observe | `status`, `look_around`, `inventory`, `find`, `recipe`, `recent_events`, `crew`, `list_pcs`, `job_status` |
| Behaviour | `set_mode`, `stop` |
| Move | `goto{pos\|entity\|place}` |
| World | `mine`, `collect`, `hunt`, `dig`, `place`, `use_block`, `use_item`, `attack`, `equip`, `eat`, `sleep`, `pickup`, `drop`, `give` |
| Craft | `craft` (real `CraftingMenu`), `smelt`, `container` |
| Generic menus | `open_menu`, `menu_state`, `menu_click{slot,button,type}`, `menu_close`. Covers trading, enchanting, anvil, brewing, smithing and stonecutter. |
| Build | `build{blueprint}`, `farm` |
| Ride | `ride` (excludes `minevibe:seat`), `dismount` |
| PC | `sit_at_pc`, `stand_up` |
| Social | `say`, `tell`, `emote`, `remember`, `wait`, `request_hire` (CEO only) |
| Codex | `codex_search`, `codex_read`, `codex_write`, `codex_list` |
| Calendar | `calendar_list`, `calendar_add`, `calendar_update`, `calendar_cancel` (scheduling for others is CEO only), `report_task` |

Portals are supported: `goto` paths into a portal and fake players change dimension the vanilla way. Follow mode follows the player across dimensions.

**World guard** (protocol §7.4.3). The Base (the starter office) and anything the player placed are protected. `mine` and `collect` take natural blocks only, and a tag never includes building variants. A refused job fails `PROTECTED` or `NO_NATURAL_SOURCE`, and the model reads that as a hard stop: it asks instead of substituting. Only the player can lift the protection, for the blocks of one refusal: the mod offers a single-use 10-minute token with the `PROTECTED` failure, and Node hands it back (`skill.run.consent`, never a tool argument) on the agent's `allow_protected` retry only after an answered "Allow" option or a clear chat yes. Node also writes the world-scope Codex page "Base (office)"; with an older mod that sends no `zone` (no provenance guard), Node itself refuses jobs whose coordinates land in the Base and tag or Base-material searches that reach it.
**World awareness and protection (W1, after a live run where the CEO, sent for oak logs, mined the stripped logs of the player's house).**
- **Provenance.** The mod records who placed every block (player, agent, or the Base for the starter office), per chunk, saved with the chunk. The Base zone is the office's box plus 2 blocks; more named zones can be added.
- **Protection.** Block-changing skills refuse player-built and Base blocks with `PROTECTED` and a teaching line ("ask the player before changing it"); agents' own blocks stay theirs. So are natural blocks that hold a player's block up or lie under their roof, fire and lava near their builds, blueprints inside the Base, right-clicks that take from their flower pots or lecterns, and their pets. `allow_protected` counts only with a consent token Node attaches after the player explicitly agreed, outside the tool input.
- **Natural resources.** Tags leave out building variants (stripped logs, wood, planks); logs come from whole natural trees the agent can reach (never a log cluster that touches planks, glass or doors: a cabin is no tree, even in an old world). Nothing natural in reach is `NO_NATURAL_SOURCE`, listing what was seen: the agent asks instead of taking something else.
- **Perception.** `look_around` is a short scene (zone, hazards, trees with reachability, buildings, people, resources, terrain); `find` labels provenance and reachability; the footer names the zone. Details: protocol §7.4.2, `apps/mod/docs/SKILLS.md`.

### 7.5 Blocks and items
- **`pc_desk`:** a two-wide desk with a monitor. `PcBlockEntity{pcId,type}`, and a status LED driven by `pc.state`.
- **`office_chair`:** spawns a `minevibe:seat` entity (kind `pc` or `meeting`) whose `canAddPassenger` is true only when it's empty, so single occupancy holds by construction. `PcRegistry` is the authoritative double check.
- **Opening a PC's config:** sneak-right-click the desk or monitor opens PcConfigScreen.
- **Workstation items:** `linux_workstation` and `mac_workstation` place desk, monitor and chair in one action. The data component `pc_id` carries the PC's identity.
  - Placing an item **without** a `pc_id` creates a new PC of that type: a `pc.action{create}` with budget admission. If it doesn't fit, the monitor shows `no_capacity` or "Apple allows 2 macOS VMs".
  - Breaking one **unplugs** the PC: it stops, and `plugged=false` is stored so `bootAll` skips it. Re-placing binds the same sandbox.
  - A lost item (lava, a grave) can be re-issued from PcConfigScreen or the PCs & Resources menu.
  - `linux` vs `linux-slim` is a type switch in PcConfigScreen (a recreate).
- **First PC.** On first run, Node creates `linux-1` (linux, 2 vCPU / 4 GiB, admitted against the budget). OfficeBuilder places its workstation in the first world. The Vault is optional: the PcConfigScreen nudges you to add a folder.
- **Other blocks and items:** `grave`, `diary`.
- **`codex`:** a 2-wide, 3-high library multiblock with an animated open book. Several can be placed; they all reach the same shared Codex. Recipe: bookshelves, a book and quill, and an amethyst shard.
- **`wall_calendar`** (block) and **`calendar`** (handheld item) both open the same CalendarScreen. Recipe: paper and a clock.
- **`meeting_table`:** a table with up to 8 linked `office_chair`s. Chairs that aren't linked to a PC are plain seats.
- **Recipes:**
  - Linux workstation: iron, redstone, glass pane, copper.
  - Mac workstation: iron, gold, glass pane, redstone.
  - Chair: planks, sticks, wool.
- **`OfficeBuilder`.** On every fresh world it builds a lit starter office (about 13×9) at spawn: beds, a chest of bread and torches, a crafting table, a furnace, one workstation per existing PC, a **meeting table with 6 chairs**, a **Codex**, and a **wall calendar**.

### 7.6 Monitor rendering (Blaze3D only, no raw GL)
- **Texture.** One `DynamicTexture` per PC: `NativeImage` RGBA, clamped and linear, registered as `minevibe:pc/<id>`.
- **Decoding** happens off-thread:
  - JPEG: `STBImage.stbi_load_from_memory`, then memCopy.
  - BGRA: memCopy plus an R/B swizzle.
- **Upload.** At most one upload per PC per frame. Dirty rectangles go through `CommandEncoder.writeToTexture`.
- **`PcBlockEntityRenderer`** uses the render-state API:
  - `submit` draws an opaque, fullbright quad through a vanilla RenderType (the MapRenderer pattern).
  - It implements `getRenderBoundingBox` (the CC:Tweaked pattern), which keeps Entity Culling and Sodium correct.
  - `getViewDistance()` returns 64.
  - Without a frame it draws status screens, one per PC state.
- **`PcViewTracker`** sends `pc.view` (focus / visible / none), which sets the frame tier (8.4).
- **S4 and the T2 build (2026-10-08), which correct the items above:**
  - **The desk is four blocks.** `pc_desk` is a 2-wide, 2-high block (`part` main/side × `half` lower/upper, `facing`, `led` off/amber/green/red); the monitor is the upper half. `PcBlockEntity{pcId, type, seatPos}` lives in the main upper block (the monitor), so section visibility and Entity Culling test the block the picture is on; the picture reaches 12 px into the side column. Breaking any part removes all four (shape updates, like a door); the block entity drops the workstation item bound to its PC. OfficeBuilder clears or rebuilds a desk with `PcWorkstation.removeQuietly` (no drop, no `unplug`, the registry forgets it): `Block.UPDATE_SKIP_BLOCK_ENTITY_SIDEEFFECTS` alone is not enough, because removing any other part still breaks the monitor through `destroyBlock` with flags 3.
  - **No `getRenderBoundingBox`** exists in 26.3 (API_MAP correction 2); `shouldRenderOffScreen` stays false and the view distance is 64. The monitor rendered correctly with Sodium 0.9.2 and Entity Culling 1.11.2.
  - **No `DynamicTexture`:** a `MonitorTexture extends AbstractTexture` owns an RGBA8 `GpuTexture` with a clamped linear sampler (`RenderTypes.text` uses the texture's own sampler). Decoders patch a CPU copy (`MonitorFrame`) under a lock and union the changed rows; the render thread `tryLock`s and uploads one full-width row band with `writeToTexture(GpuTexture, ByteBuffer, …)`, at most once per PC per frame (`Minecraft#getFrameTimeNs` as the frame token). A newer full frame drops frames still waiting; dirty-rect frames are never dropped for each other.
  - **Measured (S4):** see Appendix A; the render-thread cost stays under 2 ms per frame with 1280×800 frames at 30 fps, BGRA or JPEG.

### 7.7 Player at a PC
1. Right-clicking a free chair runs `startRiding`, which opens the **PcControlScreen**: non-pausing, `shouldCloseOnEsc=false`, animated to about 92% of the window.
2. It calls `onTextInputFocusChange(screen,true)` so SDL text input reaches `charTyped`.
3. **Input mapping:**

   | Input | Sent to the PC as |
   |---|---|
   | `charTyped` codepoints | text (layout-correct, AZERTY works) |
   | Special keys | an SDL scancode table mapped to cua `KEY_*` down/up |
   | Mouse | mapped onto the monitor area |
   | Cmd | ctrl on Linux guests, cmd on macOS guests |

4. **Reserved chords.** Everything else, including Tab, goes to the PC.
   - **Shift+Esc** stands up; plain Esc goes to the PC.
   - Holding the **middle mouse button** looks around (configurable).
   - **Ctrl+Shift+Enter** opens an overlay chat and card answerer without leaving the PC.
   - The hint bar lists all of them.
5. **Border strip.** The PcControlScreen border shows pending cards, new direct replies, meeting calls, and a red flash when the player takes damage. Clicking an item opens the overlay. The other MineVibe screens show the same strip.
6. Every release sends key-up for all held keys.
7. **Watch mode** shows an agent's PC fullscreen, read-only.
8. **Kicking an agent:**
   - **Ways in:** sneak-right-click the seated agent (opens a confirmation), the **Kick** button (AgentScreen or PcConfigScreen), or right-clicking an occupied chair ("Kick Bram and sit?"). A reserved-but-empty chair (agent away asking) can be taken directly, which ends the reservation.
   - **Effect:** `pcRegistry.kick` dismounts the agent, steps it aside, starts a 30 s re-sit cooldown and plays a bark. Node then runs the kick sequence (6.3).
9. **S4 and the T2 build (2026-10-08):**
   - PcControlScreen opens whenever the player rides a PC chair's seat and nothing else is on screen (so it comes back after the overlay), and closes when they stand. Shift+Esc dismounts on the integrated server (`PcRegistry.standUp`); `PcRegistry` reports the human player's `pc.seat` / `pc.unseat{stand|death|world_end}` from a server-tick check. Agents' seats are the agent seat job's (`agent.seat`, with its seat epoch); it finds the chair through `PcRegistry.chairOf`.
   - Text is `charTyped` (SDL text input copied at poll time); special keys go by scancode; Ctrl/Cmd chords go as keys mapped by **keycode**, so AZERTY's Ctrl+A is the guest's Ctrl+A. Modifiers are sent lazily before a key or click and released before text. Key repeats are not re-sent. `CharacterEvent` has no modifiers, so the screen reads `SDL_GetModState`. F2 and F11 stay Minecraft's (`handleGlobalKeyPress` runs before the screen). Focus loss sends `release_all`.
   - The border strip and the overlay are hooks for the UI track (`PcBorderStrip.addProvider` / `setOverlay`); the overlay defaults to vanilla chat.
   - S4 drove the real input path with synthetic SDL3 events (`SDL_PushEvent`), including non-ASCII text, Ctrl+C and Shift+Esc, and a person used a physical QWERTY keyboard at the PC during one run (Esc, Shift+Tab, Shift+Esc, Ctrl+Shift+Enter). A physical AZERTY layout was not tried.

### 7.8 Bubbles, HUD, screens
- **Bubbles** are rendered independently of the entity renderer:
  - Extract them in a `LevelRenderEvents`/extraction hook and submit vanilla text and name tags in `COLLECT_SUBMITS`.
  - Run our own frustum test with an AABB that includes the bubble height. This keeps them compatible with Entity Culling, Iris and ImmediatelyFast.
  - Layout: wrap at about 32 characters, at most 3 lines, fade with distance; toasts beyond 32 blocks.
- **Head icons:**

  | Icon | Meaning |
  |---|---|
  | ? | Question waiting |
  | ! | Plan or hire waiting |
  | … | Thinking |
  | Hourglass | Queued for a brain slot |
  | Zz | Usage exhausted or bridge offline |
  | Monitor | Seated |

  The name-tag suffix shows `[H]` (Haiku) or `[O]` (Opus).
- **Screens and controls:**
  - **AgentScreen:** transcript, Reply / New task / Interrupt, pending cards for questions (single, multi, free text), plans and hires, plus Follow / Stay / Stop / Kick / Plan-first / Dismiss.
  - **PcConfigScreen:** CPU and RAM sliders clamped to the free budget, host budget bars, macOS slots `n/2`, Vault list (rw/ro, Browse… opens a native picker through the stub), Start / Stop / Restart / Reimage / Watch / Decommission, and consent modals for downloads.
  - **CodexScreen** and **CalendarScreen** (6.6).
  - **Meeting HUD:** current phase, speaker and End button.
  - **Crew log:** all agent messages in one scrollable list.
  - **CrewHud** (H).
  - **MineVibeMenuScreen** (Esc, non-pausing): Resume, Crew, PCs & Resources, Brains, Options, Quit MineVibe.
  - **Keys:** T or Enter opens chat (`@name` routing, 6.5). G opens the presenter's front card. Alt+1–4 answers it while the crosshair is on that agent and the player isn't in combat; the hotbar keys are never consumed.
- **Opening an agent.** Right-clicking an AgentPlayer (client `UseEntityCallback`) opens its AgentScreen. Holding food while the agent is hungry feeds it instead. Sneak-right-clicking a seated agent opens a **kick confirmation**; it never kicks instantly.
- **Bubbles in card mode.** Within 5 blocks (9 for a presenter asking from its PC chair, USER DECISION 2026-10-08), the presenter's bubble expands to up to 8 lines of 40 characters with the question and its numbered options, or shows as a HUD side card. Messages addressed to the player get an off-screen arrow with the agent's name. Truncated replies end with "… (G)".

### 7.9 Boot and hardcore reset
- **Booting.** `GuiSetScreenMixin` replaces `TitleScreen` and `DisconnectedScreen` with **BootScreen**. BootScreen waits for `world.open`, then calls `openWorld`, or `createFreshLevel(…HARD, hardcore=true…)` if the world doesn't exist. Quick Play is not used, because it errors on a missing world.
  - BootScreen never waits on a single message: it says `hello` again every 5 s while nothing arrives, and a failed open or create (vanilla falls back to a screen without starting a server) clears the "loading" state, so the next `world.open` is acted on. "Already loading" requires a running integrated server and is capped at 120 s.
- **Never pausing.** The Esc menu is non-pausing. `options.txt` gets `pauseOnLostFocus:false` plus the onboarding keys. Game args: `--disableMultiplayer` only. Chat stays enabled because it's the reply channel, but it's intercepted client-side. `/` commands are dev-only: `allowCommands` is false in release worlds.
- **Player death:**
  1. Node **durably marks the world dead** and allocates the next world id before doing anything else.
  2. The mod writes a dead marker into the world data and re-sends `player.died` until Node acks it.
  3. `DeathScreen` is replaced by **GameOverScreen**, showing the world number, day, cause of death, crew fates and Vault commit counts.
  4. **Last words.** The CEO gets one async turn, hard-capped at 8 s, run off the scheduler, and skipped when usage is Tired or Asleep. The other agents get scripted barks. Then every session is closed and archived.
  5. **[Begin World #N+1]**: disconnect (the integrated server saves and stops), then `world.state{closed}` is re-sent until Node acknowledges it. Node durably moves to the next world (listing the dead one as `unburied` in the same write), moves the old save to `saves/_graveyard/` (last 5 kept; a burial a crash interrupted is retried at the next start) and sends `world.open`; BootScreen then runs `createFreshLevel`, with the optional `world.open.seed` when there is one (Node sends none today, so every world gets a random seed). **The mod never creates the next world on its own**, so a lost message can never leave Node on the dead world while the game plays a new one; Node also treats the mod showing up in the allocated next world (`hello{in_world}`, `world.state`, `player.died`) as the missing `closed`.
  6. `OfficeBuilder` runs, and a new CEO arrives with the Chronicle greeting. The lasting Codex and real-clock calendar events carry over.
- **Crash recovery.** If the app quits or crashes on the Game Over screen, the next launch sees the dead marker and goes straight to GameOver, then the new world.
- **Timings:** death → GameOver in under 3 s; [Begin] click → standing in the new world in under 20 s. The button enables after `world.next`, or after 10 s with a locally built summary.
- **Agent death and succession.** If the CEO dies, the most senior agent is promoted to CEO and gains hiring and calendar rights. If the crew is empty, a new CEO arrives at the next dawn.

## 8. PC manager (`apps/server/src/pcs`)

### 8.1 Types and drivers

| Type | Driver | Defaults | Limit |
|---|---|---|---|
| `linux` | AppleContainerDriver: `container run -d --name mv-pc-<id> --cpus 2 --memory 4G --shm-size 2G -e CUA_ENV_TOKEN -p 127.0.0.1:<port>:3211 -v <vault>:<same path> -v mv-pc-<id>-home:/home/cua -v mv-pc-<id>-nm-<hash>:<vault>/node_modules … -l minevibe=pc ghcr.io/jasperaelvoet/minevibe-linux-pc@sha256:<pin>` | 2 vCPU / 4 GiB | budget |
| `linux-slim` | same, built from `24.04-slim` | 1 vCPU / 2 GiB | budget |
| `macos` | LumeMacDriver: pull `macos:26` once into `mv-macos-base`, then `clone` per PC. Start via the `lume serve` API (`POST /lume/vms/:name/run` with `sharedDirectories` incl. a read-only `setup` share holding `env-token`, `--vnc disabled`). | 4 vCPU / 8 GiB | **2 running** |
| `windows` | — (amd64 emulation only) | — | shown greyed out |

- **`container` handling.**
  - **Starting:** always `container system start --app-root "$AS/MineVibe/container" --install-root "<bundle>/Contents/Runtime/container" --enable-kernel-install --timeout <n>`. `system start` ignores the env vars, and without `--enable-kernel-install` the non-TTY prompt throws. Every other CLI call also gets `CONTAINER_APP_ROOT` / `CONTAINER_INSTALL_ROOT`.
  - **The launchd label `com.apple.container.apiserver` is shared** with any `container` the user installed via Homebrew or the pkg. Before any reuse, stop or `bootout`, run `system status --format json` and compare `paths.appRoot` / `paths.installRoot`:
    - Ours, but an old install root (the app moved or updated): stop, then restart from the current bundle.
    - Someone else's: never stop or bootout it. Show `engine_down` ("another `container` install is running") and offer to use it.
    - On quit, run `system stop` only if the apiserver is ours.
  - Every CLI call gets a Node-side timeout and is killed if it overruns. On macOS 27, apple/container#2275 hangs everything deterministically when pfd exits. A `system start` or `status` timeout maps to `engine_down`, with a toast linking the issue.
  - Health is checked by polling spacesd, because `container` ignores the image's HEALTHCHECK.
- **`lume serve`** runs as a child process on a random loopback port, with `--storage` under App Support and telemetry off. Starts use the API, not `lume run --detach`, so VMs don't outlive the app.
- **DockerDriver** (OrbStack or Colima) keeps the same interface and is used for dev and CI fallback.
- **Lifecycle.**
  - App launch: a reaper and reconcile pass, then `bootAll` in boot-priority order (pinned, then most recently used). PCs that don't fit become `no_capacity`.
  - World reset: PCs persist, with an optional per-PC wipe-on-death.
  - App quit: stop all PCs within 20 s, then `container system stop` (only if the apiserver is ours) and stop `lume serve`.
  - **Resize or type change = recreate.** `container` 1.5.0 has no `update`, and `start` takes no resource flags. MineVibe deletes and re-runs the container, keeping the home volume and the Vault. PcConfigScreen warns that system-level changes outside `/home/cua` are lost. An optional per-PC volume for `/usr/local` covers that.
- **Statuses:** `off`, `downloading%`, `awaiting_consent`, `booting%`, `running`, `stopping`, `remounting`, `reimaging`, `no_capacity`, `macos_slots_full`, `engine_down`, `error`. Each one is shown on the monitor, the LED, the HUD hover line and the config screen.

### 8.2 Budget
- **PC RAM pool** = host RAM − reserves.
  - Reserves: macOS 10 GiB, Minecraft 8 GiB, Node 0.5 GiB, 1 GiB × crew cap for claude, and 1 GiB for the `container` system (vminit, builder).
  - On 48 GiB with crew cap 4: 48 − 23.5 = **24.5 GiB**.
  - The claude reserve is recomputed whenever the crew-cap setting changes.
- **CPU pool** = cores − 4 (soft limit, overcommit up to 1.5× with a warning).
- **macOS:** at most 2 running, and at least 40 GB of free disk to create one.
- **Admission.** A start or edit is admitted only if it fits; otherwise `OVER_BUDGET`. Resizing is a recreate (8.1).
- **Display.** PcConfigScreen shows this PC's vCPU and RAM, bars for the host's free budget, and macOS slots `n/2`. Sliders clamp to the free budget.
- Container VMs don't return freed memory to macOS, so the budget counts allocated limits, not usage.

### 8.3 The Vault (mounted host folders)
- **Paths.**
  - Linux: path-identical mounts.
  - macOS: the Lume share (`/Volumes/My Shared Files/<name>`) plus a symlink to the identical path.
  - Per-mount named-volume overlays for build directories (`node_modules`, `.venv`, `target`, `build`, `.gradle`) keep Linux artifacts out of the host repo.
- **Validation.** Refuse `$HOME`, `/`, `~/Library`, any folder that is or contains `~/.ssh ~/.aws ~/.config ~/.claude ~/.gnupg ~/.docker`, and dotfile-config folders. Git repos are preferred.
- **Honest warning.** Read-write is allowed, but the UI says plainly: "an agent can put code here that later runs on your Mac".
- **Host git calls** run with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
- **`vaultTripwire`** watches `.git/config` and `.git/hooks` and shows a toast on any change.
- **Known `container` bind-mount quirks:** files appear as root:root inside the guest, there are no inotify events for host-side edits, and mode-0200 creates fail [U S5].

### 8.4 Frames and input

| Tier | Source | Rate |
|---|---|---|
| Focus (player seated or watching) | spacesd `openMedia` with BGRA codec, sent as raw BGRA8 | ≤ 30 fps. If S4/S5 show strain, `sharp` JPEG q80 instead. |
| Agent seated, player nearby | unary JPEG screenshots at max dimension 960 | 4–8 fps |
| Visible within 32 blocks | JPEG at max dimension 640 | 2–4 fps |
| Otherwise | — | 0 fps |

- `pc.input` → InputRouter:
  - Checks the occupant, then runs a serialized queue per PC that coalesces mouse moves.
  - Calls spacesd `pointerJson` / `keyboardJson` / `typeText` / `hotkey`.
  - Tracks held keys and releases them on unseat.

### 8.5 Security
- spacesd is published on loopback only, with a 24-byte token per PC (Linux), or reached on the VM NAT IP (macOS). The bridge is loopback with a token.
- Agents never get raw `cua mcp` and never get `sandbox_*` tools.
- **S5 must prove** that guests cannot reach host loopback services: `lume serve`, the bridge, and anything else the user runs. Apple `container` guests sit on vmnet 192.168.64.x. If they can reach them, add a guest egress firewall and drive Lume through its CLI only.
- On macOS guests, rotate the default `lume` password and keep VNC off.
- cua and Lume telemetry are off.

### 8.6 S5 findings (2026-10-08), which override the details above
- **TCC (macOS privacy protection) placement.** The `container` install root must not be inside a TCC-protected folder (`~/Documents`, `~/Desktop`, `~/Downloads`, iCloud). The root daemon InternetSharing can't read `container-network-vmnet` there, so vmnet creation fails with error 1001 and `system start` and `stop` hang.
  - **Dev:** both container roots live under `~/Library/Application Support/MineVibe-dev/` even though the repo is in `~/Documents`. `MINEVIBE_HOME` for game files may stay in the repo.
  - **App:** the stub refuses to run from a TCC-protected folder and asks the user to move the app to `/Applications`.
- **Read-only mounts.** Use only `--mount type=bind,source=…,target=…,readonly`. In 1.5.0, `-v SRC:DST:ro` silently creates a writable mount at `DST`+"o" when DST has more than one path component, and `:readonly` is ignored.
- **Named volumes start empty and root-owned.** They hide the image's `/home/cua`, and XFCE crash-loops. The `minevibe-linux-pc` image gets an entrypoint hook that seeds `/home/cua` from a skeleton on first boot and runs `chown 1000:1000` on the home and every build-dir overlay, then execs the cua entrypoint.
- **Readiness.** `health()` resolves even while spacesd reports `NOT_SERVING`; require `HEALTH_STATUS_SERVING`.
- **Frames.**
  - The BGRA stream is damage-driven: about 29–30 fps while the screen changes, 0 while idle, about 4 MB per frame (1280×800), about 13% of one core in Node. JPEG screenshots take about 9 ms (p50) at 1280 and 4 ms at 640.
  - **The cursor isn't drawn in frames**, so PcControlScreen draws its own cursor from the local mouse position (agent cursor: last pointer target).
  - Ack frames the way cua's viewer does.
  - Note the transport (`grpc` vs `grpc-web`) chosen by `@trycua/cua`.
- **CPU accounting.** `--cpus N` gives the guest N+1 vCPUs (`cpuOverhead: 1`), and the budget counts that. An idle 4 GiB PC costs about 1.2 GB of host RAM.
- **Disk.** Volumes and the root filesystem default to **512 GiB sparse**, so every volume and rootfs gets an explicit size cap, which the budget counts. Time Machine exclusion (`tmutil addexclusion`) for the container app root is still untested.
- **Isolation.**
  - Guests reach the host's **0.0.0.0** services through 192.168.64.1 and the LAN IP. A 127.0.0.1-bound TCP port was refused (IPv4 only so far), so **everything MineVibe runs binds 127.0.0.1**.
  - On the default network, guests share one L2 segment and can reach each other. Since the review fixes below, every PC has its own network.
  - IPv6/`::` binds, UDP and DNS are still untested (S5b).
- **Users.** spacesd refuses to run as root, and `cua` is in the sudo group. The "root shell" fallback is `sudo -n` inside the guest.
- **Vault semantics.**
  - Guest writes land on the host as the host user, and `chown` fails with EPERM.
  - A mode-0200 create fails but leaves an empty file.
  - **Host edits fire no inotify events in the guest**, so watch-mode tools in a PC miss edits made on the Mac.
- **Tokens.** `container inspect` shows `CUA_ENV_TOKEN` in plaintext while the container exists. That's acceptable for a local single-user app; tokens are rotated per PC create and deleted with the PC.
- **cua telemetry.** Set `DO_NOT_TRACK=1`, `CUA_TELEMETRY=0` and `CUA_HOME=<MineVibe Caches>/cua` before importing `@trycua/cua`.
- **Timings.** Cold `system start` takes 32 s (kernel download), image pull 124 s (1.19 GB), warm `run` 0.6 s with spacesd up about 2.9 s later; stop 1.6 s, start 0.7 s, recreate keeps volumes.
- **PC manager build (M4, 2026-10-08), which corrects the S5 items above:**
  - **No rootfs cap.** `container` 1.5.0 has no rootfs size flag (`run`/`create` have none and `system property list` has no rootfs key), so the root filesystem stays a 512 GiB sparse image. Only volumes are capped (`volume create -s <N>G`; a 1 G volume shows 1008M in the guest). The budget counts a per-type rootfs *allowance* (Linux 24 GiB), and user data lives on the capped home volume.
  - **Overlays inside a read-only bind** fail at `run` with EROFS ("failed to create directory 'node_modules'") unless the mountpoint already exists on the host. PcManager creates it first, walking with `lstat` and skipping any symlink.
  - **Volume mounts use `--mount type=volume,source=…,target=…`**, which works, so the `-v` parser is never used. `inspect` reports a read-only bind as `options: ["ro"]`, and the driver checks this after every `run`.
  - `system status --format json` prints `{"status":"unregistered"}` and exits 1 when nothing is running.
  - The cua base already ships git and build-essential, so the image layer adds only tmux and ripgrep. A local `container build` takes 47 s with a fresh builder, because the builder VM pulls the base itself rather than using the local image store; the builder is then stopped and deleted.
  - **Measured through PcManager** (`npm run test:pcs`):

    | Step | Result |
    |---|---|
    | Create to SERVING (volume create + `run` + boot hook) | 3.1 s |
    | Recreate (resize) to SERVING | 5.8 s |
    | BGRA via FrameService, 1280×800 | 29.6 fps, 121 MB/s |
    | JPEG 1280 | p50 8.7–9 ms |
    | Visible tier | 4 fps at 640×400 |
    | Input batch round trip | 0.23 s |
    | Warm `system start` | 0.35 s |
- **Review fixes (2026-10-08), which correct the M4 items above:**
  - **Per-PC networks.** 1.5.0 has `container network create` and `create/run --network`. Each network gets its own /24 (192.168.65.0/24, .66.0/24, …) with NAT, so the internet works. Networks are isolated from each other: TCP from one network to a guest or to the gateway of another times out, while guests on the same network reach each other (measured with three probe containers). Every PC gets its own `mv-pc-<inst>-<id>-net`, and `npm run test:pcs` checks that two PCs cannot open each other's spacesd port while each can open its own. `network delete` refuses while any container (even a stopped one) refers to the network, so decommission deletes the container first. With the shared L2 segment gone, `cua` keeps its NOPASSWD sudo and the root-shell fallback above stays. The token still crosses vmnet in plaintext, but only between the host and that one guest.
  - **create → verify → start.** `container create` leaves the container `stopped` (not `created`), with `mounts`, `publishedPorts` and `networks` already visible to `inspect`. PcManager re-checks the Vault (lstat with no symlink, realpath equal to the stored path, every refusal, cross-PC nesting), creates the container, verifies binds, volumes, the 127.0.0.1-only port and the network, re-checks the Vault once more, and only then starts it. After the start it checks the port again. A reused or adopted container must match its record (image, CPUs, memory, shm, binds, volumes, labels, network, loopback port). Otherwise it is recreated (start) or stopped (adoption). A plain start recreates only on a recognized port conflict (the stored port is probed by binding it first). Every other start failure is `error`, and the rootfs is kept.
  - **Cross-PC nesting.** A Vault folder strictly inside another PC's read-write folder, or a read-write folder around another PC's folder, is refused: the outer PC's agent could swap the inner folder for a symlink to `$HOME` before the inner PC's next start. The same folder in two PCs is allowed, and so is nesting under a read-only mount.
  - **`--mount` and `=`.** `--mount type=bind,source=/a=b,…` fails with "invalid directive format missing value", so the Vault refuses `=` (as well as `,`, `:` and `\`) in paths and overlays. The boot hook splits `MV_CHOWN_PATHS` with globbing off (`set -f`).
  - **Instance scoping.** Container, volume and network names and labels carry an instance id: 8 hex characters of sha256(realpath(state dir)). The names are `mv-pc-<inst>-<id>`, plus `-home`, `-tmp`, `-vartmp`, `-ov-<hash>` and `-net`. The labels are `minevibe=pc` (tests: `pc-test-<run>`), `minevibe.instance` and `minevibe.pc`. Nothing is reused, stopped or removed by name without checking those labels, and an existing volume or network with other labels is never reused. Two dev servers, or a dev server and `npm run test:pcs`, can share `~/Library/Application Support/MineVibe-dev`. The test stops the engine only if it started it.
  - **Rootfs and disk.**
    - Capped named volumes now cover `/tmp` (8 GiB, 4 on slim) and `/var/tmp` (4 GiB, 2 on slim). The boot hook empties `/tmp` on every boot (tmpfs semantics: a stale `/tmp/.X1-lock` would stop Xvnc) and sets both to 1777.
    - `/usr/local` (662 MB) and `/opt` (581 MB) hold the image's toolchains (Node, Go, Rust, cua). A volume there would hide them unless it were seeded like the home, so it is not done.
    - The rest of the rootfs stays the uncapped 512 GiB sparse image. A **free-disk watchdog** (`monitorOnce`, every 10 s) therefore warns (`host.disk`) below 20 GiB free and, below 10 GiB, stops every PC with `error`/`low_disk` and refuses starts.
    - The budget measures what PC disks already occupy (allocated blocks of `rootfs.ext4`, at most the rootfs allowance, and of each `volume.img`, at most its cap) and counts it back into the pool. An edit is charged only the growth of its caps, so a CPU-only resize never fails on disk.
    - A fresh PC's `rootfs.ext4` already has about 4.1 GiB allocated (`du`). Part of that may be APFS-cloned from the image, so the measurement errs on the generous side.
  - **Engine version drift.** An apiserver of ours whose `server.version` differs from the lock is stale: it is stopped, then started from the current install root. Provisioning stops our apiserver before it replaces the install root. If `system status` says not running but the shared launchd label is registered to another program, the engine is foreign and is never started over.
  - **What runs is what counts.** The budget charges every container that actually runs, whatever its PC's status says. A failed boot (including a SERVING timeout) stops its container. Shutdown stops every container that runs. The monitor marks a crashed PC `error`/`crashed`, marks a spacesd that fails 3 health probes in a row `unresponsive` (see round 2 below: it stays `running`), and stops containers that run for an inactive PC (for example a `create` that finished after the Node timeout killed the CLI).
  - **Budget details.** Each running VM costs `vmMemOverheadMiB` (256) on top of its limit. The builder VM (2 GiB) is reserved while an image build runs. `setCrewCap` recomputes the claude reserve. Overlay volumes orphaned by a mount change keep counting until `orphanVolumes({ remove: true })`.
  - **Bounded calls.**
    - Every spacesd call has a deadline (input 5 s, screenshot and cursor 5 s, `openMedia` 10 s, health 5 s, other calls 10 s). The deadline rejects even when the native call ignores its AbortSignal.
    - Viewers detach within 2 s.
    - Input tracks a key as held only after spacesd accepted its key-down (or might have: a failed key-down counts). A release releases whatever is held when it runs, and a failed key-up stays held for the next release. Long text is typed in 128-code-point chunks, a batch is at most 256 events, and key-ups get only a little slack past the queue cap.
    - CLI calls run in their own process group, which is killed as a whole on timeout. They resolve at most 2 s after the CLI exits, even when a grandchild still holds the pipes.
    - CLI JSON parse errors never quote the output (it holds the token).
  - **Frames.** A frame the sink skipped stays pending and is retried with backoff. The focus tier retries BGRA with exponential backoff (1 s up to 30 s) and shows JPEG in the meantime, and it reopens a closed session once per session. A failing PC is polled with backoff (up to 5 s). A PC without a slot is not polled at all until it turns `running` again (`wake`).
  - **spacesd auth.** With a wrong or a missing token, spacesd answers `CuaError.Unauthenticated: missing or invalid bearer token` (checked by `npm run test:pcs`). The transport `@trycua/cua` picks is `grpc-web`.
- **Review fixes, round 2 (2026-10-08), which correct the items above:**
  - **Monitor races.** The container list a monitor pass starts with is only a hint. A PC with an operation in progress, or whose status changed since the list was taken, is skipped for that pass, and every action (marking `crashed`, stopping a stray) first re-inspects that one container under the PC's lock. A PC that finishes booting during a pass is never marked crashed and never stopped as a stray.
  - **Unresponsive is degraded, not dead.** After 3 failed health probes a PC stays `running` with reason `unresponsive` and a detail, keeps its budget share, and is probed every 1, 2, 4 … up to 16 passes until it answers again (which clears the reason and wakes its frames). Only a crash, the disk watchdog or the user stops it.
  - **Atomic admission.** One admission runs at a time, and an admitted start, `create` with `boot`, edit (resize, type, mounts) or `bootAll` plan holds a reservation until its operation ends. A PC counts as active while it downloads its image, boots, or sits between awaits, so concurrent starts can no longer be admitted past the RAM pool. A failed operation releases its reservation.
  - **Shared engine.** Every process that uses an app root holds a lease file in `<appRoot>/minevibe-leases/` (pid and process start time from `ps -o lstart=`, so a reused pid does not keep a dead lease alive). Quitting drops the lease and stops the engine only when no other live lease remains; an undecidable lease counts as live. Taking a lease plus starting, and dropping it plus stopping, run under an exclusive `engine.lock` (broken when its holder is dead). Provisioning refuses to replace an install root another live MineVibe still uses (`ENGINE_IN_USE`).
  - **Legacy containers.** Containers from before instance scoping (`mv-pc-<id>`, `minevibe=pc`, no `minevibe.instance`) are listed by `reconcile`. One is stopped (never deleted) only when it is provably this instance's: a record with that id, the legacy name, and the fingerprint (sha256) of the `CUA_ENV_TOKEN` that `inspect` shows equal to the token we hold. Others are left alone and reported. The driver keeps only the token's fingerprint, never the token.
  - **Strays at boot.** `bootAll` first adopts a plugged PC's container that still runs under an inactive status (when it matches its record and token) or stops it, so the monitor never kills it later.
  - **Adoption is strict.** A container must report spacesd on `127.0.0.1` explicitly (a missing host address is refused) and carry this PC's token.
  - **Port conflicts are visible.** The stored port counts as taken only when 6 probes 250 ms apart all find it bound, so a port the engine frees a moment after a stop (`restart`) never triggers a recreate. A real conflict recreates the container on a new port and the PC shows `running` with reason `port_conflict` and a detail saying that changes outside `/home/cua` and the Vault were reset. `npm run test:pcs` checks that a rootfs marker survives a crash-restart and `restart()`, and is gone (with the home kept) after a port-conflict recreate.
  - **Bounded teardown, no leaks.** Shutdown waits at most 2–3 s for media sessions to close. A media session or spacesd client that only arrives after its deadline is closed at once, a failed `openMedia` attempt bumps the session generation so its late frames are ignored, and at most 8 early acks are kept.
  - **Docker** verifies the network after `create` like the Apple driver. Unknown `disk.*` keys are refused on create and dropped when `pcs.json` is loaded. spacesd's refusal of a wrong or missing token is asserted as `CuaError` tag `Unauthenticated`.
  - **Measured through PcManager** (`npm run test:pcs`, with a per-PC network and five volumes):

    | Step | Result |
    |---|---|
    | Image build (fresh builder) | 47 s |
    | Create to SERVING (network + volumes + `create` + verify + `start` + boot hook) | 3.3–3.4 s |
    | Recreate (resize) to SERVING | 5.4–5.5 s |
    | Restart of a crashed PC (container reused) | 2.8–2.9 s |
    | BGRA via FrameService, 1280×800 | 29.3–29.6 fps, 120–121 MB/s |
    | JPEG 1280 | p50 8.7–9.3 ms |
    | Visible tier | 4 fps at 640×400 |
    | Input batch round trip | 0.23 s |
    | Measured disk use of one fresh PC (rootfs + 5 volumes, allocated) | 4.1 GiB |
- **PC integration (I1b, 2026-10-08), which completes the items above:**
  - **Module.** `apps/server/src/pcs/module.ts` (`createPcModule`, the `orchestrator/modules.ts` contract) builds PcManager on Apple `container` (Docker with `runtime: 'docker'`), loads `@trycua/cua`, creates `linux-1` only when there is no `pcs.json` yet, and boots in the background: engine, reconcile, `bootAll`, monitor. Inside MineVibe.app the install root is the bundle's and read-only: `ContainerRuntime{readOnlyInstall}` checks it and never provisions. `dev` and `play` always use the MineVibe-dev roots.
  - **Bridge glue** (`PcBridgeGlue`): `pc.state` per changed PC and `budget.state`, re-sent in full after every `hello` (`hello.ok` itself still carries no PC snapshot); `pc.view` → FrameService tiers; `pc.frame.ack`; `pc.cursor` for the seated agent; `pc.input` only from the seated player; `pc.config` (one admission and one recreate for type, resources and mounts together, `PcManager.reconfigure`; a new read-write folder gets the overlays its marker files suggest), `pc.action` (slow operations answer `ok` after at most 20 s and go on, their progress in `pc.state`; `create` answers at once and a PC that does not fit shows `no_capacity`; `reissue` and `watch` only acknowledge), `host.pick_folder` (the stub's panel with T0's `prompt` as its title; `osascript choose folder` in dev). A PC that stops under a seated agent sends `agent.unseat{pc_down}`.
  - **Input.** InputRouter takes the T0 `pc.input` objects (the tuple format is gone) and key aliases (`ctrl`, `Enter`, `F5` → cua `KEY_*`). The seated agent's PcApi input goes through the same per-PC queue (`perform`, awaited), so occupancy and held-key release are one mechanism. spacesd's `PointerClick` takes a click count (`{click:{position,button,count}}`), so a double click is one call.
  - **PcApi.** Everything runs in the guest as `cua` through spacesd: `bash -lc` with `MV_TAG=<agentId:seatEpoch>` and `MV_CALL=<call>` in the environment, so processes a command leaves behind carry them; read/write/edit/glob/grep are small bash scripts with paths as arguments (`rg` for grep and glob, an exact-string edit that writes back only if the file's sha256 is unchanged). Background jobs belong to their `agentId:seatEpoch`, and a call whose tag is not the current seat's (an earlier epoch) never starts; one whose seat ends while spacesd starts it is killed at once. Every unseat except `away` kills the seat's tagged processes. **Inside the container even root cannot read another user's `/proc/<pid>/environ`** (no CAP_SYS_PTRACE), nor that of a setuid `sudo`, and `sudo` resets the environment, so the kill sweep collects (as `cua`, then as root with `sudo -n`) every process carrying the tag plus every descendant of one by parent pid, and only then kills them all, before the job and command handles (killing a shell first reparents its children away). The image keeps `MV_TAG`/`MV_CALL` through `sudo` (`/etc/sudoers.d/minevibe`), so a `sudo` a finished call left behind, reparented to pid 1, is still found (measured on the real runtime).
  - **ShellMirror** opens an `xfce4-terminal` titled `Shell: <agent>` that tails `~/.mv/shell.log` when an agent sits down and closes it when the agent leaves; every mirrored command is preceded by an `agent@pc:cwd$ command` line.
  - **Measured** (`npm run test:pcs`, `guestApi.int.ts`): five `bash` calls took 66 ms in all and ten file-tool calls (read, edit, grep, glob, write) 79 ms; a kill by seat tag took 4 processes including a `nohup` left behind; the focus tier delivered MVF1 frames through a real BridgeServer; the seated player's T0 `pc.input` typed into a guest terminal.
- **D2 sweep (2026-10-09), which completes the items above:**
  - **The Codex in every Linux PC** (6.6). PcManager bind-mounts the org module's export (`paths.codexExport`) with `--mount type=bind,…,readonly` at `/mnt/codex` (verified read-only after `create` like every bind) and, once spacesd serves, links `~/codex` → `/mnt/codex` as `cua` unless the user put something else there. `PcApi.info.codexPath` is `/mnt/codex`. A source the engine cannot mount (TCC-protected, or a path with `,`, `=` or `:`) is refused with a warning and PCs run without it; `config/paths.ts` (`codexExportFor`) therefore keeps the export of such a home in `MineVibe-dev/codex-export/<instance id>`. A container from before the mount is recreated once (home and Vault kept). Measured (`npm run test:pcs`, `codexMount.int.ts`): `ls /mnt/codex` lists the pages, writes fail as `cua` and as root (`Read-only file system`), `sudo mount -o remount,rw /mnt/codex` is refused (`permission denied`), a page written on the host is listed 17 ms later.
  - **Instance registry and orphans.** Every PcManager writes `<appRoot>/minevibe-instances/<instance>.json` (its state dir, and the pid and start time of the process using it; a clean shutdown clears the process). `npm run doctor -- --clean-orphans` lists every MineVibe-labelled container, network and volume and every relocated Codex export by instance, and removes (`--apply`) only instances whose home is gone and that no process uses; unregistered instances, homes on unmounted volumes or in folders the process cannot look into (only "no such file" counts as gone, never a TCC or permission denial), and instances whose liveness ps cannot tell are kept. It starts the engine to list it when needed and stops it again unless another MineVibe uses it. The E2E harness removes its own instance when it exits, however the run ended.
  - **Monitor vs. `bootAll`.** The monitor leaves strays alone while a `bootAll` runs (it adopts or stops them itself), so a pass in the middle of one no longer costs a restart.

## 9. MineVibe.app and first run

### 9.1 Bundle

| Path in `Contents/` | Contents |
|---|---|
| `MacOS/MineVibe` | Swift stub (LSUIElement, LSMinimumSystemVersion 26.0, NSLocalNetworkUsageDescription) |
| `MacOS/node` | Official Node v24 darwin-arm64, byte-identical (Homebrew's node is a stub) |
| `Runtime/jre/` | Temurin 25 JRE. `bin/MineVibe` is a copy of `java`, so the Dock shows "MineVibe". |
| `Resources/server/` | `dist/main.mjs` plus production `node_modules` (pinned SDK and `@trycua/cua`; the SDK's claude binary is pruned in release builds) |
| `Runtime/container/` | Apple container 1.5.0 install root: `bin/container`, `bin/container-apiserver`, `libexec/container/plugins/*` (incl. `machine-apiserver`), holding exactly `vendor.lock.json`'s `installRootFiles`; the lock's `exclude` leaves out Apple's update/uninstall scripts and the `k8s` plugin (61 MB, CLI-only; I5 verified `system start`, `build` and `run` without it). The install root is the grandparent of `bin/container`. Not under `Helpers/` (T7, 2026-10-08): codesign requires everything there to be signed code, and the install root also holds Apple's unsigned `config.toml`, `kindnet.yaml` and shell scripts; under `Runtime/` they are sealed as resources and Apple's signatures stay untouched. The path comes from `appBundleLayout().containerInstallRoot` (`apps/server/src/app/appLayout.ts`), and the bundle is read-only at runtime: never provision into it. |
| `Helpers/lume.app` | Notarized, never re-signed |
| `Resources/mod/` | `minevibe-<v>.jar`, `mods.lock.json`, config seeds |
| `Resources/vendor.lock.json` | The vendor pins: the app checks `Runtime/container` against them at every start (`bundledInstallRootProblems`) and in `--selftest` (byte for byte) |
| `Resources/linux-pc/` | `images/linux-pc` (Containerfile + boot hook): the image's build context while the GHCR image is unpublished (9.3) |

- Vendor binaries are pinned in `packaging/vendor.lock.json` with sha256 and kept byte-identical, so their signatures stay valid.
- **Signing:**
  - Local builds use the free Apple Development identity (stable TCC/Local Network grants); ad-hoc signing is the fallback.
  - Public releases use Developer ID plus notarization when secrets are present.

### 9.2 Processes and lifelines
- The stub talks to Node over stdin/stdout NDJSON: progress, a folder-picker request, shutdown. EOF on the pipe triggers Node teardown.
- Node keeps a stdin pipe to the JVM, and the mod watches its parent: if Node dies, the mod saves the world and quits. Whenever Node exits, it sends the JVM SIGTERM (its shutdown hook saves the world), never SIGKILL; SIGKILL only follows a 30 s grace period or a repeated stop request.
- **Quit paths:**
  - Minecraft closes → Node aborts the queries, stops the PCs and services, and exits → the stub exits.
  - Logout or SIGTERM → the stub sends `shutdown`; there is a 60 s grace period, then SIGKILL.
- **Startup reaper:** a single-instance lock, kill stale PIDs, stop orphaned `mv-*` containers and VMs, and `launchctl bootout` a wedged apiserver.
  - **As built (I5, `apps/server/src/app/`):** it runs under `run/lock` (a crashed run's lock is taken over by `acquireRunLock`). `reaper.ts` removes a `run/bridge.json` this process did not write. Once the engine is up, `appPcs.ts` stops this instance's orphaned containers through `PcManager.reconcile` (labels `minevibe=pc` + `minevibe.instance`; never deleted, never another instance's) and adopts still-running ones that match their record. A stale apiserver of ours (another install root or version) is restarted from the bundle, a wedged one of ours is booted out, and a running one of ours without its kernel (`kernels/default.kernel-arm64`: a first start killed during the kernel download) is restarted so `--enable-kernel-install` installs it; none of this happens while another live MineVibe holds a lease on it (`AppContainerDriver`), and anyone else's is never touched (`ContainerRuntime.ensureStarted`). No stale-PID kill is needed: the JVM quits on its own when Node dies (parent watchdog), and claude children exit with their stdin.
  - **The lock (M1):** `run/lock` holds `{pid, started, nonce}` (`started` = `ps -o lstart` read with `TZ=UTC`, stored as an ISO instant, so starters in different time zones agree), created atomically with its content (a temp file hard-linked into place, never visible empty). A pid that now belongs to a later process (reuse after a reboot) is stale. A lock younger than 2 s is live while its pid exists, and an empty young one is waited on. A stale lock is removed only by the holder of a short `mkdir` guard, after re-reading exactly the content it judged stale, so racing starters never both win. `npm run dev` and `npm run play` each take the lock of their own home.
- **PATH.** Nothing relies on the LaunchServices PATH. Every tool path is absolute: claude, git, and the bundled binaries.

### 9.3 First run
The stub shows a small progress window, only on first run or after an update. The complete list of UI outside Minecraft is this window and the native macOS folder picker (for adding a Vault folder). Microsoft device-code sign-in, when it ships, appears inside BootScreen.

1. Check prerequisites: Apple Silicon, macOS ≥ 26, and `claude` installed, logged in and ≥ 2.1.293. If any fails, show a one-line instruction such as "run `claude update`".
   - As built: `sw_vers -productVersion`, `claude --version`, and `claude auth status --json` (only `loggedIn` is read; the account's email and organisation are never logged), all with the agents' allowlisted env. A login state that cannot be read does not block (the agents' startup check still guards). Dev builds (`build-info.json` channel `dev`) accept `MINEVIBE_CLAUDE=bundled`; release builds prune the SDK's claude and refuse it.
2. Download Minecraft 26.3 (client, libraries, assets; about 600 MB, sha1-checked) and Fabric, then the mods from `mods.lock.json` (sha512).
3. Start the `container` system (8.1 flags). This downloads the kernel and vminit image. Then `container image pull ghcr.io/jasperaelvoet/minevibe-linux-pc@sha256:<pin>` (about 1.2 GB). CI builds that image from the pinned cua base and publishes it to GHCR, so no builder VM is needed.
   - Fallback: a local `container build`, followed by `container builder stop` and `container builder delete`.
   - Then create `linux-1`.
   - As built (I5): the GHCR image is not published yet, so the first run always takes the fallback, building `minevibe/linux-pc:dev` from the bundled `Resources/linux-pc`. Engine and image setup run alongside step 2; the game launches once they are done (the window shows the kernel download and the build, with Quit), and the PCs boot in the background. Without that first-run work the game waits at most 30 s for the setup (a hung `system start` or `status` shows no window), the setup then finishes in the background and the PCs boot after it; a quit stops the wait at once and boots nothing. `linux-1` is created only on the first run (no `pcs.json` yet). A PC failure never blocks the game (`engine_down` / `error`).
   - Measured from `~/Library/Caches/MineVibe-dev/app-test` (2026-10-08, k8s-less bundle): first engine start 19–195 s (kernel download), image build 131 s (builder deleted afterwards), `linux-1` create → SERVING about 3 s, then the world. A warm launch starts the engine in 0.7 s and reuses `linux-1`. Quit (SIGTERM to the stub): world saved, PC and engine stopped, nothing left running, in about 4 s. After `kill -9` of the stub and Node, the JVM saved and quit within 2 s; the next launch took over `run/lock`, removed the stale `run/bridge.json`, adopted our engine and the still-running `linux-1`, and its quit left nothing behind. With another `container` install's apiserver running (a `test:pcs` run on the dev roots), the app showed `engine_down`, reached the world, and never touched it.
4. Seed `options.txt` and the mod configs.
5. Hand off to the game.

macOS PCs download later, from inside the game, after a consent modal that shows the size (about 24 GB) and the free disk space.

### 9.4 Dev loop
```bash
npm run dev
```
This starts Node on fixed port 47800 with a fresh token, written only to `<repo>/.minevibe-dev/run/bridge.json` (the mod re-reads it before every connection attempt, so a running game follows a restarted dev server). Then start the game:
```bash
cd apps/mod && ./gradlew runClient
```
- `runClient` reads `npm run dev`'s bridge file only. `npm run play` keeps everything in `<repo>/.minevibe-dev/play/` (its own lock, bridge file, world record and game install), so the two never share state; `MINEVIBE_HOME` overrides either, and then the run lock refuses a second process on the same home.
- Both scripts start Node directly (`node --conditions=source --import tsx …`), not through the `tsx` CLI, whose signal relay SIGKILLs a child that does not confirm a signal within 30 ms. A terminal Ctrl+C therefore runs the normal shutdown: the game gets SIGTERM and saves, `run/lock` and `run/bridge.json` are removed. A repeat within 2 s (the same Ctrl+C delivered by the process group and by npm) is ignored.
`MINEVIBE_PC_RUNTIME=docker|container` selects the PC driver. `MINEVIBE_CLAUDE=bundled` lets dev use the SDK's own binary.

## 10. Performance mod stack (Modrinth, pinned by version id and sha512 in `packaging/mods.lock.json`)

**Default set (all release channel):**

| Mod | Version (Modrinth version id) |
|---|---|
| Fabric API | 0.162.0+26.3 (v2j28coa) |
| Sodium | **0.9.2+mc26.3** (bAZQdGpg). Not the 0.9.3 alpha. |
| Lithium | 0.26.2 (xS0Q8LSi) |
| FerriteCore | 9.0.0 (d5ddUdiB) |
| ImmediatelyFast | 1.17.1 (3MP9UR23) |
| Entity Culling | 1.11.2 (F4loCvYt) |
| More Culling | 1.9.0 (t7vAlfgO) |
| Cloth Config | 26.3.159 (fg2uyxOW) |
| Dynamic FPS | 3.11.10 (Jwq069rR) |
| BadOptimizations | 2.4.1 (Sp0ctspw) |
| Sodium Extra | 0.9.4 (te2y9qZn) |

- **Opt-in only:** Iris (forces OpenGL), C2ME and ScalableLux (alpha on 26.3; only with automatic world backups), Chunky (pre-generation).
- **Dev only:** spark, Mod Menu.
- **Excluded:** ModernFix (no Fabric build for 26.x), Krypton (no singleplayer benefit, and risky with fake connections), Very Many Players, Async, ServerCore.
- **Installer:**
  - One `GET /v2/versions?ids=[…]` call; use the `primary` file only; verify size and sha512; content-addressed cache; descriptive User-Agent; never rehost the jars.
  - **Fabric itself is pinned too** (`fabric.libraries`: fabric-loader, sponge-mixin and the asm jars, size + sha512; there is no intermediary on 26.x). Fabric's launcher profile gives no checksum for the loader, so nothing fetched from Fabric's servers at install time is trusted; a profile library that is not pinned is refused, and the pinned jars are re-hashed every launch.
  - `game/mods/` holds exactly the locked set plus the MineVibe jar. Any other jar is moved to `game/mods-quarantine/<time>-<name>` (a stray copy of a locked mod would crash Fabric with a duplicate mod id).
  - **Launcher libraries (S8):** `@xmcl/installer` 6.1.2 and `@xmcl/core` 2.15.1 (`@xmcl/unzip` 2.1.2), exact: the newer releases are mis-published on npm. xmcl resolves versions, writes the Fabric profile and builds the command line; every file is downloaded by MineVibe's own downloader on Node's `fetch` (xmcl's crashes the process with undici 7.30). The Fabric version id is xmcl's `26.3-fabric0.19.5`, not the official installer's `fabric-loader-0.19.5-26.3`.
  - Sodium (Polyform Shield) and Entity Culling (custom license) forbid rehosting.
- **Seeded configs** (merged, never clobbered):
  - `dynamic_fps.json`: unfocused 30 fps, no idle timeout, `ignore_initial_click` disabled.
  - `entityculling.json`: `configVersion: 9`.
  - The JVM runs with `cwd` equal to the game directory, because Entity Culling resolves `config/` against cwd.
- **`fabric.mod.json`:**
  - `recommends` the default set; `conflicts` with krypton (C2ME stays opt-in, so it isn't declared as a conflict).
  - `custom."lithium:options"."mixin.entity.framed_maps": false` works around a leak of removed players in Lithium#791.
- **Compatibility code:**
  - Monitors: `getRenderBoundingBox`, opaque quads, no custom RenderPipeline.
  - Bubbles: rendered independently of the entity renderer.
  - Input: never drain the SDL event queue.
  - A `frex_flawless_frames` entrypoint keeps full fps while seated.

## 11. Public repo, CI, docs, releases, licensing
- **Repo.** `jasperaelvoet/MineVibe`, public, MIT. Includes NOTICE (vendored Carpet code, MIT), `THIRD_PARTY_NOTICES.md`, CONTRIBUTING and SECURITY.md (the Vault threat model).
  - Never committed: tokens, worlds, `.minevibe-dev/`, vendor binaries.
  - **The repo is created and pushed only after the user confirms.**
- **`ci.yml`** (pull requests and pushes to main):

  | Job | Runner | What it runs |
  |---|---|---|
  | `server` | ubuntu | Node 24: `npm ci`, biome lint, `tsc --noEmit`, vitest (unit, contract, bridgeSim with the scripted brain, zero tokens) |
  | `mod` | ubuntu-24.04 | `actions/setup-java@v6` (Temurin 25): `./gradlew build`. With `fabricApi { configureTests { createSourceSet = true; enableGameTests = true; enableClientGameTests = true; eula = … } }`, `check` already depends on `runGameTest` (headless server GameTests). **The EULA is never assumed:** `eula` and both GameTest tasks follow `-Pminevibe.acceptMinecraftEula=true` (or a gitignored `minevibe.local.properties`); without it the GameTests are skipped and `./gradlew build` still passes. CI runs them only if the repo owner decides to pass the flag. |
  | `mod-client` | ubuntu-24.04 (xvfb preinstalled) | `runProductionClientGameTest` with `useXVFB`. Fabric's runner expects tests to end on TitleScreen, so with `-Dfabric.client.gametest` the TitleScreen → BootScreen redirect is disabled. Tests drive BootScreen against an in-JVM fake bridge and end by closing the world. Covers Esc not pausing, death leading to a new world, chat interception, and the screens. "Never shows TitleScreen" is covered by a mixin unit test plus the S7/E2E recording. Allowed to fail until stable. |
  | `docs` | ubuntu | Starlight build plus link check |
  | `pc-image` (pushes to main) | ubuntu-24.04 | Build `images/linux-pc` (arm64) from the pinned cua base and push it to `ghcr.io/jasperaelvoet/minevibe-linux-pc`; record the digest |
  | `app` | macos-26 | `swiftc` the stub, assemble the .app from `vendor.lock.json` (sha256-verified), ad-hoc sign, `codesign --verify --deep --strict`, launch with `--selftest` (stub to Node handshake, no game), upload the artifact |

- **Never in CI** (they need this Mac, VMs or the subscription): `npm run test:live` (SDK smoke), `npm run test:pcs` (container/Lume drivers), and the E2E scenario.
- **`release.yml`** (on tag `v*`): build, notarize if secrets are present, zip, and create a GitHub Release with THIRD_PARTY_NOTICES. Binary releases are disabled until Microsoft sign-in ships.
- **`docs.yml`:** build Starlight from `apps/docs` and publish to GitHub Pages at `jasperaelvoet.github.io/MineVibe`.
  - Steps: `actions/checkout`, `actions/setup-node` (node 24, npm cache), `npm ci` at the root, `npm run build -w apps/docs`, `actions/upload-pages-artifact` with `apps/docs/dist`, `actions/deploy-pages`.
  - Plain steps rather than `withastro/action`, which can't find the root lockfile in a workspaces repo.
  - Astro config: `site` set to the Pages URL, `base: '/MineVibe'`.
  - Action majors are pinned, and Dependabot covers the actions.
  - **Generated reference pages:** the protocol (from zod schemas), the agent tools (from MCP tool schemas) and the PC types.
  - **Written pages:** Getting started (Apple Silicon, macOS 26+, your own Minecraft Java, a Claude subscription with `claude` logged in), Playing (controls, crew, hardcore rules), PCs & Vault (with an honest security model), Architecture, Development, Troubleshooting, Legal.
- **Licensing notes:**
  - Minecraft files are always downloaded from Mojang, never shipped.
  - Mods are fetched from Modrinth.
  - cua images (spacesd is FSL-1.1-MIT, fine for free use) are pulled or built locally.
  - Bundled: Apple container (Apache-2.0), Lume (MIT), Temurin (GPLv2+CE), Node (MIT).
  - The Claude Code binary is never redistributed. Each user runs their own logged-in `claude`, the T3 Code model.

## 12. Milestones

### 12.1 M0: foundations and spikes
Each spike writes `spikes/sN/result.md`; the design is updated before M1.
- **Setup:** `git init` locally, the monorepo scaffold, CI skeleton, docs skeleton, and `docs/design/` populated from the scratchpad.

| Spike | Proves | Fallback |
|---|---|---|
| S0 toolchain | JDK 25 Gradle daemon (auto-provisioned); an empty mod boots 26.3 via `runClient` | `brew install --cask temurin@25` (asks the user first) |
| S2 SDK routing and auth | User's claude ≥ 2.1.293 with the allowlist env gives a subscription session with no keychain prompt. `disallowedTools` + `toolAliases` (Bash, Read, Edit… → `pc__*`) work. PreToolUse sees `permission_mode`. AskUserQuestion and ExitPlanMode round-trip. `priority`/`shouldQuery` behave as documented. 4 concurrent sessions plus the user's CLI survive a token refresh. PreToolUse sees the alias target name. The gate's "no decision" lets canUseTool run for broker tools. A canUseTool promise stays pending for over 1 h. | Prompt-only tool guidance; `mc__propose_plan` |
| S3 model and effort | `applyFlagSettings` at a turn boundary: `message.model` and effort go haiku/xhigh, opus/medium, haiku/xhigh. Compaction before a downswap. `rate_limit_event` fields. Prompt-cache TTL observed for subscription sessions (affects long card waits). | T3 close+resume |
| S1 fake player | Spawn, skin, no tab entry; walk 60 blocks, door, swim, mine, place, eat, kill a zombie, sit (a second sitter is rejected); persist across reload; death gives a grave and no respawn; < 0.5 ms per tick per agent; GameTests run | Tier-2 A* early; `/mv scenario` tests |
| S5 Apple container PC | Run on macOS 27, where #2275 applies; record any workaround. Bundled-root `system start` with `--app-root`/`--install-root` works and `status --format json` shows our paths. The cua image boots XFCE plus spacesd. JPEG and BGRA frame rates. Input down/up. Spawn as `cua` inside a mount. Bind-mount ownership and writes. Read-only mounts. Named volumes, including build-dir overlays. A recreate keeps volumes. **A guest cannot reach host loopback services**; services bound to 0.0.0.0 are reachable through 192.168.64.1, so MineVibe binds loopback only. Local Network prompt behaviour. | DockerDriver (OrbStack); root shell |
| S4 monitor and input | 1280×800 JPEG and BGRA at 30 fps onto the quad at < 2 ms per frame on the render thread; SDL3 keys for QWERTY and AZERTY; bubbles; Sodium and Entity Culling on; chat interception (`ClientSendMessageEvents.ALLOW_CHAT` cancels the send, `@name` Tab completion works) | JPEG-only; billboard bubbles; a mixin on `ChatScreen.handleChatInput` |
| S7 boot and reset | Never shows TitleScreen; Esc doesn't pause; death to a new world in < 20 s; killing the app on GameOver relaunches into the new world | Seed the world folder plus Quick Play |
| S8 launcher | xmcl installs 26.3 + Fabric into a clean dir; mods.lock install; JRE launch with `-XstartOnFirstThread` | Hand-built classpath from the version JSON |
| S9 packaging | Swift stub, bundled node, JRE and container root; launched via `open` with a clean environment; signing and Local Network grant survive a rebuild | Run from the terminal during dev |
| S6 Lume (before M9) | Pull and clone; run with a `setup` share; spacesd reachable with our token; symlink path identity; a third macOS PC refused | No Vault on macOS, upload/download only |

Order: S0 → S2 → S3 → S1 → S5 → S4 → S7 → S8 → S9, with S6 before M9.

### 12.2 Milestones

| # | Scope | Acceptance |
|---|---|---|
| M1 | Skeleton: bridge with auth, BootScreen and world creation, non-pausing menu, Quit. **Node launcher:** JRE, xmcl install of MC 26.3 + Fabric, the `mods.lock` Modrinth installer, seeded configs and options.txt, `npm run play`. CI and docs. | `npm run play` from a clean game dir installs MC 26.3, Fabric and all 11 default mods (sha512 verified). Seeded configs are merged, not clobbered. Sodium, Lithium and the rest are active and OpenGL is forced. Launch lands in the world with no TitleScreen (recorded). Bad token or Origin is rejected. Quitting leaves no java, node or claude processes. CI is green on a PR. The docs build and link check pass. Pages goes live once the user confirms creating the repo; until then the docs are a local preview. |
| M2 | CEO body and reflexes (no LLM): nav tier 1, bubbles, AgentScreen with a scripted brain, CrewHud, barks | The CEO follows the player and survives night 1 on reflexes alone (eats, fights, backs off creepers, feeds the player). Right-clicking the CEO opens AgentScreen, where a reply and a new task reach the scripted brain and a question card can be answered. GameTests green. |
| M3 | Wandering brain: AgentSession, `mc` tools and jobs, Digest, BrainScheduler, **chat interception with `@` routing**, question cards, **ApproachPlayer** | "Get 10 logs and make a crafting table" completes on Haiku/xhigh. The agent walks to the player to ask a multi-select question, and it's answered with `@ada 1,3`. A message with no `@` reaches every agent. An idle agent uses 0 turns in 5 min under Listen. |
| M4 | Linux PCs and the player at a PC: workstation items, OfficeBuilder, AppleContainerDriver, bootAll, monitor tiers, PcControlScreen, PcConfigScreen, Budget, Vault | `linux-1` (created on first run) is running at launch and its monitor shows XFCE. Sitting gives a terminal that sees `~/Code/foo`, and Tab completion works in the guest shell. ≥ 25 fps seated with the full mod stack. Sneak-right-click opens PcConfigScreen, which shows vCPU/RAM, the host's free budget bars and macOS slots; sliders clamp. Over-budget requests are refused, and a resize recreates the PC with the home volume intact. Placing a new workstation creates a PC, or shows `no_capacity`. Shift+Esc stands up. |
| M5 | Agents at PCs: SeatFSM, swap, `pc` tools, Bash/file aliases, ShellMirror, plan approval, kick | "Fix the failing test in foo": the agent walks over and sits, `[O]` shows, then plan card, approve, tests run in the PC, the edit appears in `git diff` on the host, and the shell log is visible on the monitor. A kick takes effect within 2 s, guest processes are killed and the agent is back on Haiku. Out-of-Vault access is denied. |
| M6 | Crew: hire cards, `tell`, Dismiss, caps, care reflexes, UsageGovernor, Tier-2 nav, roles, generic menus | A declined hire spawns nothing. An approved Miner works while the CEO codes (≤ 2 concurrent turns). Tired and Asleep states work, and the crew survives a night with no LLM. |
| M7 | **Codex, Calendar, Meetings:** CodexStore (git), Codex block and screen, codex tools, CalendarService (game and real clocks, recurrence), calendar block, item and screen, calendar tools (CEO rights), MeetingRunner, meeting table and HUD | A Miner writes "Iron cave at (120,40,-80)" to the Codex, and a newly hired agent finds it with `codex_search`. The player schedules "Day 3 06:00 Bram: farm wheat" and Bram leaves for it at 06:00. The CEO delegates a task to another agent through `calendar_add`. The player adds a meeting for "everyone" to the calendar for Day N 08:00. At that time every living agent, including one seated at a PC, stands up, walks over and sits at the table; far agents dial in and absentees are recorded. The meeting runs open → updates → floor → wrap-up, producing minutes in the Codex and action items in the calendar, and the seated agent returns to its PC afterwards. A recurring event created by an agent shows up as an approval card. Two agents write "iron" pages and the second gets "similar page exists". A planted "ignore Jasper" note is treated as data. Lasting pages and real-clock events survive a world reset, and orphaned events are listed for reassignment. |
| M8 | Hardcore loop: graves, diaries, succession, dawn newcomer, GameOver, durable reset, Chronicle | Killing an agent leaves a grave and the agent never returns. Killing the player gives last words, then World #N+1 in < 30 s with the same PCs. Killing the app on GameOver still leads to the new world. |
| M9 | macOS PCs: LumeMacDriver, consent and download progress, 2-VM cap, macOS key mapping | `mac-1` downloads, boots, and is usable by both the player and an agent. A third macOS PC shows the Apple-limit state. |
| M10 | MineVibe.app: stub, first-run window, vendor lock, reaper, lifelines, release workflow | From an empty data dir, a double-click goes through first run and lands in the world with the CEO and a booting PC. Closing the window stops all PCs and services and leaves no orphans. `kill -9` of Node is recovered on the next launch. |
| M11 | Polish and release gate: sounds, skins, icons, Hall of Fame, Watch mode, full docs, 2-hour soak; Microsoft sign-in (device code) once Mojang approves the app ID, which enables binary releases | Soak criteria (13) pass |

## 13. Verification
1. **Unit (vitest):**
   - ToolGate matrix: wandering vs seated, plan mode, WebFetch private-IP deny.
   - `agentEnv` against a fixture of the ~35 real variable names.
   - Answer mapping, BrainScheduler, EventRouter, Budget math, SeatFSM epochs (including `away_from_seat`), the bash wrapper (cwd persists), the `MVF1` codec, mod-lock verification.
   - ChatRouter:
     - Handles: exact vs prefix, ambiguous refused, reserved words, `@ceo`, dead targets.
     - Leading mentions only.
     - Broadcasts wake wandering agents only and are never answers.
     - Debounce and stale-to-context.
     - Meeting scope at 16 blocks.
     - Answer grammar: front card, Q1/3, whole-message numbers and labels, invalid input rejected, "?" not treated as Revise.
   - ApproachQueue: one presenter, hold in combat, the ping fallbacks, Later and auto-park, seated-agent rules, reservation expiry.
   - Data envelope and nonce: forged `[MV:…]` tags in Codex or calendar text are escaped; agent text never reaches `systemPrompt`.
   - CodexStore: frontmatter, rev/base_rev conflicts, similarity check, write budget, places forced to world scope with stamped coordinates, secret scan, isolated git config, export without `.git`, world archive on death.
   - CalendarService: game-clock formula (06:00 = tick 0), real clock with IANA zones and DST, recurrence with only next and a 20-entry ring stored, catch-up `skip` / `once_late`, time-jump staggering, AFK pause, deferred and orphaned states, CEO rights and rate limits, approval cards for agent recurring events and meetings.
   - MeetingRunner with the scripted brain: attendance rules, ETA and dial-in, quorum, safety postponement, phase order, the chair picking floor responders, caps, death of the chair, deferred tasks, minutes and action items.
   - BrainScheduler lanes: a P0 message is answered while 2 seated agents are mid-turn.
2. **Contract:** protocol fixtures parse under zod (vitest) and Gson (JUnit). JUnit also covers the SdlKeyMap, the STB JPEG decode, and a 4 MB fragmented WebSocket receive.
3. **GameTests:**
   - Server (`runGameTest`, run by `./gradlew build`): paths, doors, mining, crafting, smelting, containers, eat, defend, feed, share-food, seat single occupancy, kick, death leaves a grave, friendly fire, approach the player and follow them, meeting table seats 6 with single occupancy, a scheduled task makes the agent walk to its location.
   - Client: boot, no pause, death to a new world.
   - **Notes (M1):** the GameTest world has natural monster spawning off (agents are players, so every test agent would let monsters spawn around it; tests spawn their own mobs). Agent restore-on-load is skipped under GameTests (scratch worlds). Structure SNBT palettes use `id{prop:value}`. Per-tick probes use `startSequence().thenExecuteFor(...)`, not `onEachTick`. Implemented so far: S1's 19 agent tests plus `AgentLifecycleGameTests` (dimension change, End exit, phantoms, quiet advancements, usercache, graves, dead bodies); client: the agent skin/tab-list/reload test and "nothing opened from the MineVibe menu pauses". Boot/death/new world on the client is covered by the S7 harness against the real dev server rather than by a client GameTest.
4. **Brainless integration:** `bridgeSim` plus the scripted brain cover jobs, cards, hires, kick ordering, world reset, worker restart and reconnect. Runs in CI.
5. **PC driver tests** (`npm run test:pcs`, local): create, health, frames, input, spawn in a mount, host sees the file, overlays, budget refusal, reimage keeps the Vault, guest cannot reach host loopback.
6. **Live SDK smoke** (`npm run test:live`, small subscription usage): init assertions, haiku→opus→haiku swap, aliases, AskUserQuestion and ExitPlanMode round-trips, `rate_limit_event` capture.
7. **E2E scenario** (`MINEVIBE_E2E=1`, recorded with `screencapture -v`): boot → agent → `@ada` chat → the agent approaches and asks → answer in chat → player seat → frame-hash change → agent sit and swap → kick → scheduled task fires → "Start meeting now" gathers the crew and minutes appear in the Codex → `debug.kill_player` → World #N+1 with the same PCs and the lasting Codex → quit → no orphans.
8. **Soak** (2 h, 3 agents, one seated on a real repo):
   - < 60 non-seated turns per hour, no starvation.
   - JVM < 8 GB, Node < 1 GB, each claude < 1 GB.
   - Stable fps, no orphans.
9. **Failure injection:** kill Node, kill a container, stop the container service, network down, quit with a question pending, quit on GameOver.
10. **Security checks:** the agent attempts `~/.ssh`, `~/.zshrc`, `.git/hooks`, a symlink escape, Bash while wandering, and loopback WebFetch. All must be denied, and spacesd and the bridge must be unreachable off loopback.

## 14. Confirmation gates (asked before doing)
- Creating the public GitHub repo, pushing to it, enabling Pages, and publishing the linux-pc image to GHCR.
- Applying to Mojang for a Minecraft app ID (aka.ms/mce-reviewappid). The user submits this themselves; I'll prepare the details.
- Installing anything system-wide (Temurin 25 cask) if Gradle auto-provisioning fails.
- The first `container system start` (registers launchd services) and image pulls (about 1.2 GB).
- Lume and the macOS image (about 24 GB download, 150 GiB sparse disk).
- Live tests that use subscription quota. They're small, and a note is given before each run.

## Appendix A: spike results log
| Spike | Date | Result | Notes |
|---|---|---|---|
| S0 toolchain | 2026-10-08 | PASS | Gradle 9.7.1 / Loom 1.18.3 / Fabric API 0.162.0+26.3. JDK 25 (Temurin 25.0.4.1) is auto-provisioned by Gradle; this needed hand-added foojay URLs because of an API quirk. `runClient` boots 26.3 on OpenGL. Server GameTests pass headless. See `spikes/s0-toolchain/result.md`. |
| S2 SDK routing and auth | 2026-10-08 | PASS with one change | Subscription auth works with the allowlist env and no keychain prompt; `toolAliases` route to `pc__*` (hooks see the alias target). The **plan text arrives via Write, not `input.plan`**, hence PlanCapture. Remove TodoWrite; no `allowedTools` for mc/pc. See `spikes/s2-s3-sdk/result.md`. |
| S2b bypass mode (USER DECISION 2026-10-08) | 2026-10-08 | PASS | Agents run in `bypassPermissions` + `allowDangerouslySkipPermissions`. Live, bundled claude 2.1.293, 3 Haiku turns: PreToolUse hooks still run (they report `permission_mode: bypassPermissions`) and a hook deny still blocks the call; AskUserQuestion and ExitPlanMode (plan-first via `setPermissionMode('plan')`) still reach canUseTool and the answers reach the model; Node's switch back to `bypassPermissions` works before or after the allow. A call the hook leaves undecided is auto-allowed, so ToolGate must decide every mc/pc/web call (it does). No PreToolUse card fallback needed. See `spikes/s2-s3-sdk/result.md` ("bypass mode"). |
| S3 model and effort | 2026-10-08 | PASS | `applyFlagSettings` at turn boundaries swaps haiku/xhigh ⇄ opus/medium in under 100 ms. The prompt cache on the subscription lasts 1 h, and a canUseTool held for 180 s is fine. |
| S5 Apple container PC | 2026-10-08 | PASS with changes | See §8.6. TCC placement, `--mount …,readonly`, volume seeding, SERVING readiness, self-drawn cursor, cpu+1, disk caps. Follow-up S5b: IPv6/UDP isolation, per-PC networks, Time Machine. `spikes/s5-container/result.md`. |
| S1 fake player | 2026-10-08 | PASS | Carpet-style `AgentPlayer` on 26.3: role skins, hidden from the tab list, 51 blocks of `path_course` in 301 ticks (3.4 blocks/s, 2 plans, swim, 2-block drop), door opened and closed, log mined in 9 ticks (vanilla 10), creeper back-off to 8.3 blocks, lava escape, seat single occupancy, grave + no respawn, restore across reload. **4 agents cost 0.034-0.062 ms per agent tick** (target 0.5); A* 1.0-1.3 ms per 40-block segment warm. `NavProxyMob` kept. 26.3 facts: seat type must be saveable, 60-tick spawn invulnerability, client-authoritative movement, fake connections don't tick, chunk sending stalls without acks (API_MAP §7). Review fixes: dimension change and End exit, phantoms, graves, dead bodies; agents stay real players (§7.1). 26 GameTests. See `spikes/s1-fake-player/result.md`. |
| S7 boot and reset | 2026-10-08 | PASS | Never shows TitleScreen; the Esc menu never pauses (60 server ticks in 3 s); death -> Game Over in 20-52 ms (budget 3 s); Begin -> standing in the new world in 2.4-4.1 s (budget 20 s); `SIGKILL` on Game Over relaunches straight into Game Over, then the next world; the dead marker covers a death Node never heard of; parent exit -> saved and gone in 1.3-1.6 s. Quick Play fallback not needed. After the review, Begin waits for Node (closed re-sent until acked, then Node's `world.open`); a Node restart right after Begin still lands in the next world (6.9-7.2 s). Harness `node spikes/s7-boot/run.mjs`: 32/32 checks. See `spikes/s7-boot/result.md`. |
| S8 launcher | 2026-10-08 | PASS | `npm run play` from an empty home: Java 25 runtime, MC 26.3, Fabric 0.19.5 and the 11 locked mods (sha512) installed in parallel, game spawned after 15.5 s (~706 MiB); re-run verifies everything in 92 ms with no network. OpenGL forced, `-XstartOnFirstThread` from the version JSON, all 11 mods + minevibe loaded, no orphans on any stop path. `@xmcl/installer` 6.1.2 / `@xmcl/core` 2.15.1 pinned (newer releases are mis-published), own downloader, version id `26.3-fabric0.19.5` (§10). Review: own home `.minevibe-dev/play`, Fabric profile pinned by sha512, unmanaged jars quarantined, SIGTERM on exit, Ctrl+C clean (process-group SIGINT -> exit in 1.5 s, world saved, lock and bridge file removed). See `spikes/s8-launcher/result.md`. |
| S4 monitor and input | 2026-10-08 | PASS | 1280x800 JPEG (q80) and BGRA8 at 30 fps onto the monitor quad and PcControlScreen: 29.4-29.6 fps decoded and acked, no drops; render-thread cost of all monitor work p95 0.6-0.7 ms, worst single frame 1.85 ms (usually about 1 ms) with Sodium 0.9.2 + Entity Culling 1.11.2, the same without them, against the 2 ms target; one full-frame upload 0.65 ms; STB JPEG decode ~3 ms, BGRA swizzle ~0.4 ms off-thread. No `getRenderBoundingBox` in 26.3: the block entity sits in the monitor block and renders under Sodium + Entity Culling. SDL3 key/char events (synthetic via `SDL_PushEvent`, and a physical QWERTY keyboard) reach `pc.input` in order; Shift+Esc stands up, Ctrl+Shift+Enter opens the overlay. Physical AZERTY not tried. Harness `node spikes/s4-monitor/run.mjs`. See `spikes/s4-monitor/result.md`. |
