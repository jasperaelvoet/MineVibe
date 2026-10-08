# MineVibe: final implementation plan (merged from Designs 1-3 plus the three fact-checks)

Status: planning only. Nothing has been built, installed or written. Date 2026-10-08.
Tags: **[V]** means a primary source or the fact-checks confirmed it. **[U]** means unverified; every [U] item is assigned to a spike in section 10 with a fallback.

---

## 1. Context

### 1.1 What we are building
- **MineVibe.app** is a Fabric mod for Minecraft Java plus a Node "agentic server". Minecraft is the only UI. Launching drops you straight into ONE hardcore survival world. There is no title screen, no multiplayer and no way to leave the world: the app is either open (in) or closed (out).
- **Agents.** The world starts with one embodied agent, the Lead, which follows and listens to the player. It is a full player: walk, mine, place, use, containers, craft, fight, eat, sleep, sit. Agents have real HP, hunger and air, and look after the player and each other. They speak in bubbles above their heads, never in vanilla chat. Right-clicking an agent opens its conversation (read, reply, new message, answer questions, approve plans, approve hires). With player confirmation, the Lead can hire embodied sub-agents.
- **Brains.** Each agent is one Claude Agent SDK session. It runs the user's own Claude Code login (subscription, T3 Code model) and never handles tokens. Wandering agents run Haiku 5.5 at effort xhigh; seated agents run Opus 5.5 at effort medium.
- **PCs.** The world contains PCs, desks and chairs. Each PC is its own cua sandbox: Linux container, or macOS VM with at most 2 running. The player or one agent sits at a PC to use it: live screen on the monitor, mouse and keyboard. The player can kick agents off. The user mounts host folders (the "Vault") into PCs. Agents get cua screen control plus a shell and file tools inside the PC, and no host shell.
- **PC capacity.** All PCs boot when the game starts. Each PC has an indicator and a config screen showing its resources and how much host capacity is left.
- **Hardcore.** Player death means MineVibe starts a new world. A concurrency cap protects the usage window.

### 1.2 Environment (checked read-only)

| Item | Fact |
|---|---|
| Host | macOS 27.0.1, M5 Pro, 18 cores (6P+12E), 48 GiB RAM, 199 GiB free disk |
| Docker | **OrbStack** 2.2.3 / Engine 29.4.0, arm64, runtimes `runc` only (no gVisor), engine cap `memory_mib=16384` (MemTotal 15.66 GiB), NCPU 18. An unrelated container (`<other-container>`) is in a restart loop: count it in the budget, never touch it. |
| Tools | Node 24.20, bun, uv, python3, git, `/opt/homebrew/bin/ffmpeg` |
| Claude | `~/.local/bin/claude` 2.1.284 is too old for Haiku 5.5 effort. SDK 0.3.293 bundles CC 2.1.293. |
| Java | Temurin 17 only. Runtime needs Java 25 (Mojang `java-runtime-epsilon` 25.0.1 `mac-os-arm64` [V]). The Gradle daemon needs JDK 25 (Loom 1.18 is Java-25 bytecode [V]). |
| cua / lume | Not installed; `~/.cua` and `~/.lume` are absent |
| Shell env | About 35 `ANTHROPIC_*` / `CLAUDE*` / `MCP_*` variables, including `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT` and `DISABLE_MICROCOMPACT` |
| Project dir | `/Users/jasperaelvoet/Documents/MineVibe`: empty, not a git repo |

### 1.3 Pinned versions

| Component | Version |
|---|---|
| Minecraft | 26.3 (unobfuscated, Mojang names, SDL3 input, LWJGL 3.4.3 incl. `lwjgl-sdl`, `lwjgl-stb`) [V] |
| Fabric | loader 0.19.5, Fabric API 0.162.0+26.3 (0.161.0+26.3 also valid), plugin `net.fabricmc.fabric-loom` **1.18.3**, **Gradle 9.7.1**, `release = 25` [V] |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.293` (CC 2.1.293); models `claude-haiku-5-5`, `claude-opus-5-5` [V] |
| cua | `@trycua/cua@0.4.1` exactly, with `@trycua/cua-darwin-arm64@0.4.1`, which also ships the `cua` binary. Images pinned by digest: `ghcr.io/trycua/linux:24.04@sha256:…`, `ghcr.io/trycua/macos:26@sha256:…`. cua ships several releases a day, so never track `latest` [V]. |
| Launcher | `@xmcl/installer@6.3.5` (workflow API), `@xmcl/core@2.16.2` [V]. Not MCLC. |
| Server libs | `ws`, `zod`, `pino`, `execa`, `sharp` (fallback JPEG encode), `vitest`, `tsx`, `esbuild` |

### 1.4 Corrections applied from the fact-checks

| Claim in a design | Status | Replacement in this plan |
|---|---|---|
| Gradle 9.6 + Loom 1.17 (D1, D3); Gradle runs on JDK 17 (D2) | Refuted | Gradle 9.7.1 + Loom 1.18.3. The daemon must run on JDK 25 (spike S0). |
| `setMcpServers` attaches `pc` tools mid-session and they are visible at once (D1, D3) | Refuted | Tools added later are deferred behind ToolSearch. **Both `mc` and `pc` are registered at session start with `alwaysLoad: true` and never swapped.** Availability is enforced by a PreToolUse gate (D2's approach). |
| AskUserQuestion answers are `label \| label[]` (D1, D3) | Refuted | `answers: {[question]: string}`. Multi-select is joined with `", "`. Free text goes in as the value. Never rely on `response`. |
| canUseTool can guard every tool call | Refuted | canUseTool never fires for auto-approved calls. **The PreToolUse hook is the authoritative guard.** canUseTool is only for human-in-the-loop. |
| CLAUDE_CODE_SHELL / SHELL_PREFIX could relocate Bash | Refuted / fragile | `disallowedTools:['Bash']` + `toolAliases:{Bash:'mcp__pc__bash'}` [V] |
| ExitPlanMode approve = plain `allow` | Corrected | Allow WITH `updatedInput`, and set the next permission mode explicitly. |
| An explicit `effort` option is safe across `setModel` | Uncertain | No top-level `effort` option. Effort lives in the flag layer (`settings`), and every swap calls `applyFlagSettings({model, effortLevel})` at a turn boundary (S3). |
| The bundled CLI may trigger a Keychain prompt (D3) | Not expected | The keychain ACL is on `/usr/bin/security`. Keep `HOME` and leave `CLAUDE_CONFIG_DIR` unset. S2 confirms. |
| `settingSources: []` fully isolates agents | Partial | Auto memory still loads, so set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. |
| The cua SDK/CLI can bind-mount host folders | Refuted | MineVibe runs Linux PCs with its own `docker run -v` and attaches via `embedded().spacesd(url, token)`. macOS runs through Lume REST with `sharedDirectories`. |
| A cua Sandbox has stop/start; `cua mcp --sandbox` pins one PC | Refuted | Use docker/lume lifecycle directly. Never give agents raw `cua mcp`: per-call `sandbox` args and `sandbox_*` tools would break single occupancy. |
| WebP screenshots; PNG media stream on Linux; Node SDK delivers decoded frames | Refuted | JPEG screenshots. Media BGRA via `requestJson '{"codecs":["MEDIA_CODEC_BGRA"]}'`. No H.264 decode path. |
| Windows PC via QEMU is realistic | Refuted | Shown greyed out as "Unavailable on Apple Silicon". |
| macOS disk 100 GB; Lume suspend keeps memory | Corrected | 150 GiB sparse disk (image annotation). Lume "suspend" is a stop, followed by a cold boot. |
| `--quickPlaySingleplayer` boots or creates the world | Refuted | It errors if the world is missing. The mod intercepts TitleScreen and calls `openWorld` / `createFreshLevel` itself. |
| Hardcore turns a dead fake player into a spectator (D1 mixin) | Refuted | Not needed. The fake never sends PERFORM_RESPAWN. Override `die()`. |
| Unsigned profile textures give agent skins; `allowsListing()` hides agents from the tab list (D2) | Refuted | Client `PlayerInfo.getSkin()` mixin returning `PlayerSkin.insecure(…)`. A mixin sets `ClientboundPlayerInfoUpdatePacket.Entry.listed=false`. Never send REMOVE. |
| `NativeImage.read` / ImageIO for JPEG (D1, D3) | Replaced | PNG-only. Use `STBImage.stbi_load_from_memory`, then `new NativeImage(RGBA, w, h, true, ptr)` [V]. |
| Carpet `mount()` for seating | Corrected | `mount()` forces the ride and bypasses `canAddPassenger`. Use non-forced `startRiding(seat)`. |
| xmcl legacy `getVersionJsonFromLoaderArtifact`; MCLC | Refuted | xmcl 6.x workflows: `createFabricInstallWorkflow`, `createJavaRuntimeInstallWorkflow({target:'java-runtime-epsilon'})`. |

### 1.5 Merge map (where the source design matters)
- **Process model:** supervisor plus worker with crash recovery (D1), plus the mod's ParentWatchdog (D2).
- **Built-in tool routing:** host Read/Edit/Write/Glob/Grep confined to path-identical Vault mounts (D1, D2), Bash aliased into the PC (D2), stable tool list (D2). D3's alias-everything-to-PC tools are kept as the macOS fallback.
- **Model swap at the turn boundary:** D1's insight, D3's strike/interrupt mechanics.
- **UX layer:** legibility kit, roles, barks, care reflexes, AgentScreen, PcConfigScreen, GameOver, "Vault" (D3).
- **Verified 26.3 code paths:** Carpet v26.3 bodies, render-state API, SDL3 input (D2 plus the MC fact-check).
- **Death and persistence decisions:** section 9. "Only the Vault and the hardware survive."

---

## 2. Architecture

### 2.1 Processes

| # | Process | Runtime | Role |
|---|---|---|---|
| P1 | **supervisor** (`main.mjs run`) | Node 24 | Single-instance lock, preflight, allocates the bridge port and token once, forks and restarts P2 (at most 3 times per 5 min), launches the JVM via @xmcl/core, runs shutdown when the JVM exits. `LSUIElement` gives it no Dock icon. |
| P2 | **worker**, the agentic server | Node 24 | BridgeServer, AgentManager, BrainScheduler, PcManager, FrameService, InputRouter, WorldLifecycle, Chronicle, StateStore. Re-binds the same port after a restart. |
| P3 | **Minecraft JVM** | Java 25 (Mojang epsilon), MC 26.3 + Fabric + `minevibe` | Client thread: screens, bubbles, monitor textures, input. Integrated server thread: AgentPlayer bodies, reflexes, jobs, navigation, seats, PcRegistry. ParentWatchdog: if P1 dies, save and exit. |
| P4..n | **claude** ×N (one per living agent) | CC 2.1.293 (SDK-bundled, or the user's binary if ≥ 2.1.293) | Agent brain over the SDK stdio control protocol. Keychain OAuth. |
| PCs | Linux containers (OrbStack, runc) and macOS VMs (Lume, at most 2 running) | `cua-spacesd` on :3211 | Sandboxed computers |

### 2.2 Diagram

```
 MineVibe.app (LSUIElement zsh stub) --exec--> node apps/server/dist/main.mjs run
                                                   |
 +------------------------ P1 supervisor (Node 24) ----------------------------+
 | lock · preflight · port+token (run/bridge.json 0600) · fork/restart worker  |
 | launch JVM via @xmcl/core · shutdown orchestration                          |
 +-------------+-----------------------------------------+----------------------+
               | fork (IPC)                               | spawn java -Dminevibe.bridgeFile=… -Dminevibe.parentPid=…
               v                                          v
 +------------- P2 worker (Node 24) ------------+   +---- P3 JVM: MC 26.3 + Fabric 0.19.5 + minevibe ----+
 | BridgeServer ws://127.0.0.1:P/v1  <==========|===| BridgeClient: 1 WS, JSON text + MVF1 binary frames  |
 | AgentManager -> AgentSession xN              |   | client: BootScreen, MineVibeMenu, AgentScreen,      |
 |   BrainScheduler · UsageGovernor             |   |   PcControlScreen, PcConfigScreen, GameOver, HUD,   |
 |   ToolGate(PreToolUse) · InteractionBroker   |   |   bubbles, MonitorTextures                          |
 |   EventRouter/Digest · TranscriptStore       |   | integrated server: AgentPlayer xN (Carpet pattern), |
 |   SDK query() --stdio--> P4 claude xN -------+-->|   ReflexBrain, JobRunner, nav, PcRegistry, seats,   |
 |     (keychain OAuth --HTTPS--> Anthropic)    |   |   graves, HardcoreHooks, OfficeBuilder               |
 |   in-proc MCP: mc (-> bridge) · pc (-> PCs)  |   +-----------------------------------------------------+
 | PcManager: DockerLinuxDriver · LumeMacDriver |
 | SpacesdPool (@trycua/cua embedded, pinned)   |
 | FrameService · InputRouter · Budget          |
 | WorldLifecycle · Chronicle · StateStore      |
 +--------+------------------------+------------+
          | docker CLI (execa)      | lume REST 127.0.0.1:7777
          v                         v
   OrbStack VM (runc)          Virtualization.framework
   mv-pc-linux-1 …             mv-pc-mac-1 … (max 2 running)
   spacesd :3211 -> 127.0.0.1:<rand>      spacesd <vm-ip>:3211
   VAULT: host folders bind-mounted at IDENTICAL absolute paths (macOS: Lume share + guest symlink)
   P4's host file tools may touch ONLY the Vault paths of the PC the agent is seated at.
```

### 2.3 Principles
1. **The LLM is never on a latency-critical path.** Survival, combat, eating and caretaking are tick-level Java reflexes. The LLM issues coarse, long-running jobs. Agents stay alive when Node, the network or the usage window is down.
2. **One WebSocket.** MineVibe is singleplayer-only, so client UI actions reach the integrated server through `Minecraft.getInstance().getSingleplayerServer().execute(…)`. There are no Fabric custom payloads.
3. **Stable tool list per session.** Availability is gated, not swapped, so the prompt cache only breaks on deliberate model swaps.
4. **One boot code path.** First run, normal start, reconnect and post-death reset all go through BootScreen.

---

## 3. Repo layout

```
MineVibe/
├─ package.json            # npm workspaces: apps/server, packages/protocol; scripts: setup, dev, build, test, test:live, test:pcs, app, doctor
├─ .nvmrc (24)  .gitignore  LICENSE  NOTICE (Carpet MIT attribution)
├─ apps/server/            # TypeScript, esbuild -> dist/main.mjs, vitest
│  └─ src/
│     ├─ main.ts                       # setup | run | dev | doctor
│     ├─ supervisor/{Supervisor.ts, singleInstance.ts, shutdown.ts}
│     ├─ launcher/{preflight.ts, javaRuntime.ts, installMinecraft.ts, installFabric.ts, mods.ts, optionsTxt.ts, launchGame.ts}
│     ├─ bridge/{BridgeServer.ts, rpc.ts, frames.ts}
│     ├─ agents/{AgentManager.ts, AgentSession.ts, GatedInbox.ts, BrainScheduler.ts, UsageGovernor.ts,
│     │          ToolGate.ts, InteractionBroker.ts, EventRouter.ts, Digest.ts, TranscriptStore.ts,
│     │          agentEnv.ts, claudeBinary.ts, models.ts, memory.ts, prompts/{persona.ts, roles.ts, kickoff.ts, barks.ts}}
│     ├─ agents/tools/{mc.ts, pc.ts, pcShell.ts, pcFiles.ts (macOS fallback), schemas.ts}
│     ├─ pcs/{PcManager.ts, PcTypes.ts, Budget.ts, Vault.ts, SpacesdPool.ts, FrameService.ts, InputRouter.ts,
│     │       drivers/{DockerLinuxDriver.ts, LumeMacDriver.ts}, folderPicker.ts, vaultTripwire.ts}
│     ├─ world/{WorldLifecycle.ts, Chronicle.ts, HallOfFame.ts}
│     └─ config/{paths.ts, settings.ts, StateStore.ts}
│  └─ test/ (unit, contract, sim/bridgeSim.ts fake mod, scripted brain)
├─ apps/mod/               # Gradle 9.7.1 wrapper, Loom 1.18.3, splitEnvironmentSourceSets(), Java 25
│  ├─ settings.gradle.kts (foojay-resolver-convention)  gradle/gradle-daemon-jvm.properties (toolchainVersion=25) [U: S0]
│  ├─ gradle.properties (minecraft_version=26.3, loader_version=0.19.5, fabric_api_version=0.162.0+26.3, loom_version=1.18.3)
│  └─ src/{main,client,gametest}/java/dev/minevibe/…  + resources (fabric.mod.json, mixins, assets, data)
├─ packages/protocol/      # protocol.md, zod schemas, fixtures/*.json (round-tripped by vitest AND JUnit)
├─ images/linux-pc/Dockerfile   # FROM ghcr.io/trycua/linux:24.04@sha256:<pin>; apt: tmux ripgrep git build-essential; nothing else
├─ spikes/s0-toolchain … s8-launcher/   # throwaway, each with README + result.md
├─ packaging/{MineVibe.app.template/, build-app.sh, icon.icns}
├─ scripts/{dev.sh, e2e/run-scenario.ts}
└─ docs/DESIGN.md
```

Runtime data lives in `~/Library/Application Support/MineVibe/`. Logs go to `~/Library/Logs/MineVibe/{server.log, agents/<id>.jsonl, mc/}`.

```
state/   settings.json  pcs.json  chronicle.json  hall-of-fame.json  current-world.json  vault-handoffs/<mountHash>.md
         tokens/<pcId> (0600)  macsetup/<pcId>/setup/env-token (0600)
run/     bridge.json {port, token, supervisorPid} (0600)  lock
runtime/ java-25/ (Mojang epsilon: jre.bundle/Contents/Home/bin/java)
game/    versions/ libraries/ assets/ mods/ saves/ saves/_graveyard/ options.txt
worlds/<worldId>/ world.json  agents.json  agents/<agentId>/{home/ (claude cwd), memory.md, chat.jsonl, pending.json}
```

Build commands:

| Task | Command |
|---|---|
| Server | `npm i && npm run build` |
| Mod | `cd apps/mod && ./gradlew build`, producing `build/libs/minevibe-<v>.jar` |
| Dev loop | `npm run dev`: worker on fixed port 47800 with a `.dev-token` file, then `./gradlew runClient` with `-Dminevibe.bridgeFile=…` in the Loom run config |
| App bundle | `npm run app`: esbuild bundle + production `node_modules` (native optional deps for the SDK and cua) + mod jar + Fabric API jar, written to `~/Applications/MineVibe.app` |

---

## 4. Wire protocol (mod <-> worker)

### 4.1 Transport and auth
- The worker listens on `127.0.0.1:<port>` (random, fixed per app run, 47800 in dev) at path `/v1`.
- The JVM receives only `-Dminevibe.bridgeFile=<run/bridge.json>`, so the token is never on the command line. The mod connects with `HttpClient.newWebSocketBuilder().header("Authorization","Bearer "+token).subprotocols("minevibe.v1")`.
- The server rejects: a missing or bad token (constant-time compare), any `Origin` header, and non-loopback peers. A new authenticated connection replaces the old one.
- The mod reconnects with backoff 0.5 s to 5 s. On every `hello` the worker re-sends full state. While disconnected, agents show the "Zz" icon and reflexes keep running.
- Envelope: `{"t":"<type>","v":1,"id"?:"…","re"?:"…", …}`. Replies are `{"t":"ok","re":id,…}` or `{"t":"err","re":id,"code","msg"}`. Timeouts: 5 s for world queries, 15 s for config, skill calls per `waitMs`. Text frames are at most 256 KB. Unknown `t` is logged and ignored.

### 4.2 Message catalog

| Group | Type (direction) | Payload sketch |
|---|---|---|
| Session | `hello` (M→N) | `{mod, mc, phase:"boot"\|"in_world", worldId?}` |
| | `hello.ok` (N→M) | `{world:{id,gen,fresh}, player:{name}, settings, pcs, budget, crew, brains, pending}` |
| World | `world.open` (N→M) | `{worldId, gen, fresh, hardcore:true, difficulty:"hard"}` |
| | `world.state` (M→N) | `{phase:"loading"\|"ready"\|"closing"\|"closed", worldId, fresh?, spawn?, office?:{origin, slots}}` |
| | `player.died` (M→N) | `{cause, killer?, day, ticksAlive}` |
| | `world.next` (N→M) | `{worldId, summary:{day, cause, crewFates, vaultCommits}}` (enables the Game Over button) |
| | `client.stopping` (M→N) / `server.shutdown` (N→M) | `{}` |
| Bodies | `agent.spawn` (req N→M) | `{agent:{id,uuid,name,role,skin,lead}, at:"office_door"\|"near_player"\|"saved"}` → `ok{entityId}` |
| | `agent.despawn` (N→M) | `{agentId, reason:"dismissed"\|"world_end"}` |
| | `agent.state` (M→N, 1 Hz, coalesced) | `{day, tod, player:{pos,hp,food,attackers}, agents:[{id,hp,food,sat,air,pos,held,seat,mode,job:{id,skill,progress},near:{hostile:[[type,dist]]}}]}` |
| | `agent.event` (M→N) | `{agentId, kind, urgency:0\|1\|2, data, reflex?}` |
| | `agent.died` (M→N) | `{agentId, message, pos, graveAt, lastWords}` |
| | `agent.mode` (M→N) | `{agentId, mode:"follow"\|"stay"\|"guard"\|"wander", target?}` (changed by UI buttons, zero tokens) |
| Skills | `skill.run` (req N→M) | `{agentId, skill, args, waitMs≤120000}` → `skill.result{status:"done"\|"failed"\|"running"\|"interrupted", jobId, summary, data, footer}` |
| | `skill.progress` (M→N) / `skill.cancel` (N→M) | `{jobId, note}` / `{jobId}` |
| | `obs.query` (req N→M) | `{agentId, q:"status"\|"look"\|"find"\|"inventory"\|"recipe"\|"crew"\|"events"\|"pcs", args}` → `{text, data}` |
| Seats | `agent.seat` / `agent.unseat` (req N→M) | `{agentId, pcId}` → `ok` \| `err{OCCUPIED\|UNREACHABLE\|COOLDOWN}` |
| | `pc.seat` / `pc.unseat` (M→N) | `{pcId, who:{kind:"player"\|"agent", id}, reason?:"stood"\|"kicked"\|"damage"\|"died"\|"removed"\|"pc_down"}` |
| | `pc.placements` (M→N), `pc.bind` (N→M), `pc.removed` (M→N) | `{items:[{pcId\|null, type, pos}]}`, `{pos, pcId}`, `{pcId}` |
| UI | `agent.say` (N→M) | `{agentId, text?, bark?, style:"speech"\|"bark"\|"tell", ttlMs}` |
| | `agent.brain` (N→M) | `{agentId, state:"idle"\|"thinking"\|"queued"\|"awaiting_player"\|"asleep", model, effort, activity}` |
| | `chat.append` (N→M) / `chat.history` (req M→N) | `{agentId, entries:[{ts, from, text, kind}]}` / `{agentId, before?, limit}` |
| | `agent.pending` (N→M, full replace) | `{agentId, items:[{id, kind:"question"\|"plan"\|"hire", …}]}` |
| | `chat.send` (M→N) | `{agentId, text, mode:"reply"\|"new_task"\|"interrupt", replyTo?}`; `chat.shout{text}` wakes agents within 32 blocks |
| | `pending.answer` (M→N) | `{pendingId, answers:{"Which wood?":"Oak"}}`; multi-select `"Oak, Spruce"`; free text as the value |
| | `plan.decision` (M→N) | `{pendingId, decision:"approve"\|"approve_auto"\|"revise", feedback?}` |
| | `hire.decision` (M→N) | `{pendingId, approve, name?, firstTask?, note?}` |
| | `agent.cmd` (M→N) | `{agentId, cmd:"dismiss"\|"plan_first_on"\|"plan_first_off"}` |
| | `ui.toast`, `brains.state` (N→M) | `{text, kind}`; `{inFlight, queued, max, mode:"normal"\|"tired"\|"asleep", utilization, resetsAt}` |
| PCs | `pc.state` (N→M) | `[{pcId, slot, type, status:"off"\|"booting"\|"running"\|"error"\|"no_capacity"\|"reimaging", bootProgress?, cpus, memMb, mounts:[{host,ro}], occupant, display:[w,h]}]` |
| | `budget.state` (N→M) | `{host:{cpus,memMb,diskFreeGb}, reserve, engine:{name,memMb}, allocated, free:{cpus,memMb,linuxMemMb,macosSlots}}` |
| | `pc.view` (M→N, on change) | `{subs:[{pcId, mode:"focus"\|"visible", px}]}` |
| | `pc.input` (M→N, batched per client tick, ≤60 Hz) | `{pcId, seq, ev:[["m",x,y],["bd","left"],["bu","left"],["s",dx,dy],["t","héllo"],["kd","KEY_SHIFT"],["ku","KEY_SHIFT"],["k","ctrl+c"]]}` |
| | `pc.frame.ack` (M→N) | `{slot, seq}` |
| | `pc.config` (req M→N) | `{pcId, cpus, memMb, mounts}` → `ok{restartRequired}` \| `err{OVER_BUDGET\|MACOS_SLOTS\|PATH_REFUSED}` |
| | `pc.action` (req M→N) | `{pcId?, action:"create"\|"start"\|"stop"\|"restart"\|"reimage"\|"decommission", type?, pos?}` |
| | `host.pickFolder` (req M→N) | `{}` → `{path}` (worker runs `osascript -e 'POSIX path of (choose folder)'`) |
| Debug | `debug.state` / `debug.teleport` / `debug.damage` / `debug.killPlayer` | E2E builds only (`MINEVIBE_E2E=1`) |

Example:
```json
{"t":"skill.run","v":1,"id":"s-91","agentId":"ada","skill":"collect","args":{"block":"minecraft:oak_log","count":8,"radius":32},"waitMs":20000}
{"t":"ok","v":1,"re":"s-91","status":"running","jobId":"j-12","summary":"3/8 oak_log","footer":"HP 17/20 food 12/20 | Jasper 6m HP18 | threats: none | D2 08:10"}
```

### 4.3 Binary frames (worker → mod): `MVF1`, big-endian, 32-byte header

```
0  u32 magic 'MVF1'   4 u8 kind (1=pc_frame)   5 u8 codec (1=JPEG, 2=RGBA8, 3=BGRA8)
6  u16 flags (bit0 full frame, bit1 cursor drawn, bit2 dirty rect)   8 u32 pcSlot   12 u32 seq
16 u16 width  18 u16 height  20 u16 rectX  22 u16 rectY  24 u16 rectW  26 u16 rectH  28 u32 payloadLen  32.. payload
```
Flow control: at most 2 un-acked frames per PC, latest wins. If `ws.bufferedAmount > 8 MB`, frames are skipped; control messages are never dropped.

### 4.4 Threading
- **Java.** `BridgeClient` is a client-lifetime singleton that survives world resets. The listener accumulates partial frames until `last`, then calls `request(1)`. Dispatch:
  - `agent.*`, `skill.*`, `obs.*`, seat and world-server messages go to `server.execute(…)`. If no server is running, reply `err NO_SERVER`.
  - `world.open`, `world.next`, UI and bubble messages go to `Minecraft.getInstance().execute(…)`.
  - Binary frames go to a 2-thread `FrameDecoder`, latest-wins per PC.
  - Outbound: a single `mv-bridge-send` thread drains a `LinkedBlockingQueue`, one `sendText` at a time (`java.net.http.WebSocket` allows only one send in flight). `agent.state` is coalesced by key.
- **Node.** Single event loop. `rpc.request(type, payload, timeout)` returns a Promise keyed by `id`. `pc.input` goes through one serialized queue per PC with move coalescing.

---

## 5. Agent runtime

### 5.1 Session construction (one long-lived streaming `query()` per agent)

```ts
const q = query({
  prompt: inbox,                                    // GatedInbox<SDKUserMessage>; turn-starting messages released by BrainScheduler
  options: {
    pathToClaudeCodeExecutable: claudeBin(),        // user's claude if --version >= 2.1.293, else undefined (SDK-bundled 2.1.293)
    env: agentEnv(),                                // allowlist, 5.2
    settingSources: [], strictMcpConfig: true, skills: [], plugins: [],
    permissionMode: 'default',                      // explicit; omitted = 'auto' on current SDKs
    cwd: paths.agentHome(worldId, agentId),         // fixed for the agent's life; never a Vault path
    ...(rec.started ? { resume: rec.sessionId } : { sessionId: rec.sessionId }),   // we mint UUIDs
    persistSession: true, title: `MineVibe · ${rec.name} · World #${gen}`,
    model: 'claude-haiku-5-5',
    settings: { effortLevel: 'xhigh',               // flag layer; NO top-level `effort` option (see 5.5)
      modelSettings: { 'claude-haiku-5-5': { effortLevel: 'xhigh' }, 'claude-opus-5-5': { effortLevel: 'medium' } } },
    thinking: { type: 'adaptive' },
    tools: ['Read','Edit','Write','Glob','Grep','TodoWrite','AskUserQuestion','EnterPlanMode','ExitPlanMode','WebSearch','WebFetch'],
    disallowedTools: ['Bash','Agent','Task','NotebookEdit'],   // exact 2.1.293 names confirmed from system/init in S2
    toolAliases: { Bash: 'mcp__pc__bash' },
    mcpServers: { mc: mcServer(rec), pc: pcServer(rec) },      // createSdkMcpServer({..., alwaysLoad: true, timeout: 600_000}); never swapped
    allowedTools: ['mcp__mc__*', 'mcp__pc__*'],
    hooks: {
      PreToolUse:     [{ hooks: [toolGate(rec)] }],            // authoritative guard + input rewriter, runs on every call
      PreModelSwitch: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } })] }],
    },
    canUseTool: broker(rec),                                   // AskUserQuestion / ExitPlanMode / EnterPlanMode; anything else -> gate re-check
    systemPrompt: { type: 'preset', preset: 'claude_code', append: persona(rec, world) },
    includePartialMessages: true,
    stderr: s => log.agent(rec.id, s),
  },
});
```

**Startup assertions** (on `system/init`, before any agent spawns; failures show an in-game toast and agents stay "asleep"):
- `apiProvider === 'firstParty'`, `apiKeySource` is `'none'` or absent, and `await q.accountInfo()` has a non-empty `subscriptionType` (shown in the ESC menu). On failure the toast says: "Run `claude` and /login in Terminal".
- `await q.supportedModels()` contains `claude-haiku-5-5` with `xhigh` and `claude-opus-5-5`. If not, the toast says: "Claude Code too old, using bundled 2.1.293".
- The init tool list contains no `Bash`, `Agent` or `Task`.

**Stream handling:**
- Main-thread (`parent_tool_use_id === null`) assistant text becomes `agent.say` (first ~2 sentences, "…(open chat)" if longer) plus `chat.append`.
- `tool_use` blocks become one-line activity entries such as "collect oak_log x8".
- Partial deltas drive the typing icon.
- `result` releases the brain slot, records usage and applies any pending transition (5.5).
- `rate_limit_event` goes to UsageGovernor.

### 5.2 Subscription auth and environment hygiene
- **`agentEnv()` is an allowlist.** It passes `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TMPDIR, TERM` and adds:
  - `CLAUDE_AGENT_SDK_CLIENT_APP=minevibe/<ver>`
  - `DISABLE_AUTOUPDATER=1`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (MineVibe does its own memory)
  - `DO_NOT_TRACK=1`
- Everything else is dropped, including `ANTHROPIC_BASE_URL` (which would proxy inference and disable tool search), `CLAUDE_EFFORT`, any `CLAUDE_CODE_EFFORT_LEVEL` (which would override all effort control), `CLAUDE_CODE_*`, `CLAUDECODE`, `MCP_*` and `DISABLE_MICROCOMPACT`.
- `HOME` is kept and `CLAUDE_CONFIG_DIR` is never set, so the user's keychain login is used through `/usr/bin/security`. MineVibe never reads, stores or forwards credentials.
- **Binary choice** follows the T3 model (user's own binary) when possible. Preflight runs `~/.local/bin/claude --version`:
  - If it is ≥ 2.1.293, use it.
  - Otherwise use the SDK-bundled 2.1.293 (same login) and show a tip in the ESC menu: "run `claude update` to use yours". MineVibe never updates the CLI itself.
- If S2 shows AskUserQuestion disappears after stripping, re-add only `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL=1`.

### 5.3 Tools per state (ToolGate = PreToolUse hook; fail-closed)

| Tool | Wandering (Haiku/xhigh) | Seated at PC *P* (Opus/medium) |
|---|---|---|
| `mcp__mc__` observe / social / eat / equip / say / remember | allow | allow |
| `mcp__mc__` movement and world jobs | allow | deny: "You're seated at linux-1. Call mc__stand_up first." |
| `mcp__mc__sit_at_pc` / `mcp__mc__stand_up` | allow / deny | deny / allow |
| `mcp__mc__request_hire` | Lead only | Lead only |
| `mcp__pc__*` (incl. aliased `Bash`) | deny: "Computer tools work only while seated. Walk to a PC and call mc__sit_at_pc." | allow if `PcRegistry.occupant(P) == agent` **and** the seat transition is complete |
| `Read`, `Glob`, `Grep` | deny (same teaching message) | allow if `realpath` is under a Vault mount of *P* |
| `Edit`, `Write` | deny | allow if under a **rw** mount of *P*. Deny `**/.git/hooks/**` and `**/.git/config` ("runs on the host"). Plan mode is enforced by Claude Code itself. |
| `WebSearch`, `WebFetch` | deny ("no internet away from a PC") | allow (setting `allowWeb`, default on) |
| `TodoWrite` | allow | allow |
| `AskUserQuestion`, `ExitPlanMode` | pass through to canUseTool | pass through to canUseTool |
| `EnterPlanMode` | deny (plan mode is for PC work) | pass through |
| anything else | deny | deny |

Gate rules:
- **Path check.** Canonicalize with `fs.realpath` (for Write and Edit, on the nearest existing parent). This defeats `..` and symlink escapes.
- **Default search path.** When `Glob`/`Grep` omit `path`, rewrite `updatedInput` to the primary mount. `updatedInput` replaces the whole input, so copy all fields.
- **Second line of defense.** If a file tool still reaches canUseTool (an Edit outside cwd in `default` mode), the broker re-runs the same check. S2 verifies whether a hook `allow` already skips canUseTool.
- **Plan mode.** While plan mode is on, mutating `pc` tools (click, type, key, drag, clipboard set) are denied with "Plan mode: read-only until Jasper approves". `pc__bash` stays allowed, and the agent is told to keep it read-only.

**`pc` server tools.** These are registered always. Their schemas mirror the built-ins so aliased calls validate.

| Tool | Args | Implementation |
|---|---|---|
| `info` | – | OS, display, cpus and memory, Vault mounts (host path = guest path), cwd, toolchains |
| `screenshot` | `max_dim?` | `SpacesdClient.screenshot({format:Jpeg, quality:75, maxDimension:1280, includeCursor:true})`. Linux 1280x800 means image pixels equal guest pixels. Returns an image block plus `{w,h,scale}`. Reuses a FrameService frame under 200 ms old. |
| `click` / `double_click` / `right_click` / `move` / `drag` / `scroll` | `x,y,…` | spacesd typed methods. Coordinates are rescaled when `scale != 1`. |
| `type` / `key` | `text` / `keys:"ctrl+shift+t"` | `typeText` / `hotkey` |
| `clipboard` | `set?` | `getClipboard` / `setClipboard` |
| `bash` | `command, timeout?, description?, run_in_background?, cwd?` (a superset of BashInput) | See 5.4 |
| `bash_output` / `bash_kill` | `id` | Background jobs |
| `handoff_note` | `mount, text` | Stored in `state/vault-handoffs/<hash>.md` (not in the user's repo) and injected into the next kickoff for that mount |

The full `mc` tool catalog is in 6.5.

### 5.4 Routing built-in tools: shell in the sandbox, files on the Vault
- **Path identity.** A Vault folder `/Users/me/Code/foo` appears inside the PC at the **same absolute path**:
  - Linux: `-v /Users/…/foo:/Users/…/foo`.
  - macOS: a Lume share plus `sudo ln -sfn "/Volumes/My Shared Files/foo" /Users/…/foo` inside the guest.
  - A convenience symlink `~/vault/foo` is added inside the guest.
  - Host-side `Read/Edit/Write/Glob/Grep` (well-trained Claude Code behaviour, read-before-edit tracking) and `pc__bash` inside the guest therefore see the same bytes at the same paths, and the model never translates paths.
- **No host shell.** `Bash` is disallowed and aliased to `mcp__pc__bash`, the documented `toolAliases` use case. `Agent`/`Task` are disallowed, because every helper must be embodied (hire).
- **`pc__bash` semantics** (the built-in Bash features are rebuilt):
  - Execution: Linux uses spacesd `spawn({program:'bash', args:['-lc', wrapped], user:'cua', cwd, timeoutMs, tag})`; macOS runs as user `lume`. Fallback for Linux: `docker exec -u cua -w <cwd> mv-pc-<id> desktop-env bash -lc …`.
  - Wrapper: `set -o pipefail; cd "$MV_CWD" 2>/dev/null; { <cmd> ; } 2>&1 | tee -a ~/.mv/shell.log; ec=${PIPESTATUS[0]}; printf '\n__MV_PWD__%s\n' "$PWD"; exit $ec`. The cwd persists per agent and PC.
  - Output: capped at 30k characters (head and tail). The full output is kept at `~/.mv/out/<id>.log` inside the PC.
  - Timeouts: default 120 s, maximum 600 s.
  - `run_in_background` keeps a spawn tag, polled with `bash_output`.
- **ShellMirror (fun and legibility).** On sit, the worker launches a visible terminal that tails `~/.mv/shell.log` (`xfce4-terminal --title agent -e 'tail -n 200 -F ~/.mv/shell.log'`, or Terminal.app on macOS). The monitor shows the agent's commands and output scrolling while watchers stand nearby. Execution itself stays headless and deterministic.
- **macOS fallback (if S6 fails).** If Lume shares or symlinks do not work, the Vault is not mounted on macOS PCs. For that agent, the gate denies host file tools and the `pc` server exposes `read/write/edit/glob/grep` emulated over spacesd `download`/`upload` and `rg` (D3's PcFiles). Work moves through git push/pull or `Space.upload/download`.
- **Residual risk (accepted, documented).** Anything an agent writes into a mounted repo can execute on the host later, through git hooks, `core.hooksPath`, package scripts or Makefiles. Mitigations:
  - Per-mount `ro` toggle.
  - An extra `ro` overlay on `<mount>/.git/hooks` where it exists.
  - `vaultTripwire` checks `git config --get core.hooksPath` and the hooks-dir mtime after each seated session and toasts on change.
  - `settingSources: []` means no project hooks run in claude itself.

### 5.5 Model and effort switching (at turn boundaries only)

Facts [V]: `setModel` and `applyFlagSettings({model})` take effect mid-turn; `applyFlagSettings({effortLevel})` takes effect from the next turn. Swapping mid-turn would run the rest of the turn on Opus at xhigh, so every swap happens between turns.

**Sit**
1. Haiku calls `mc__sit_at_pc{pc:"linux-1", purpose}`.
2. The handler sends `agent.seat`. The mod's SitSkill paths to the chair and does a **non-forced** `startRiding(seat)`, so a second occupant is rejected.
3. On success: `PcRegistry` occupant is set, `pc.seat` is emitted, and Node sets `pendingTransition = seat(P)`. The tool returns: "Seated at linux-1. End your turn now; your PC session starts next turn."
4. Any further tool call this turn is denied with the same text. After 2 strikes, `q.interrupt()`. Optional accelerator if S3 confirms it: PostToolUse `{continue:false}`.
5. On `result`:
   - `await q.applyFlagSettings({ model: 'claude-opus-5-5', effortLevel: 'medium' })`.
   - If Plan-first is on: `setPermissionMode('plan')`.
   - Push the **kickoff** message: PC info, mounts, an excerpt of the primary mount's `CLAUDE.md` (≤2k tokens, read by Node because `settingSources: []`), stored handoff notes, the original task, and "prefer the shell for code; the screen for GUIs; tell Jasper the result in 1-2 sentences, then mc__stand_up".
   - The kickoff is queued at P1 priority.

**Stand up voluntarily.** `mc__stand_up` dismounts at once. At the next `result`, apply `{model:'claude-haiku-5-5', effortLevel:'xhigh'}` and `setPermissionMode('default')`. The rest of the current turn runs on Opus at medium, which is acceptable.

**Kick, damage-unseat, PC crash or death.**
1. If a turn is in flight, `q.interrupt()`.
2. Release held keys.
3. Swap to Haiku/xhigh and set mode `default`.
4. Inject `"[KICKED] Jasper kicked you off linux-1 mid-task. Ask what he wants or do something else."` as a critical wake.

**Debounce.** Every swap re-reads the context uncached on the other model. A stand followed by a sit at the same PC within 60 s skips the swap, and swaps are logged with their cache cost.

**Badges** show the actual `message.model` from assistant messages, so any surprise, such as a Sonnet plan-mode upgrade, is visible.

**Fallback** if S3 shows effort not applying or a stuck swap: T3 Code's pattern. `close()` the query and reopen it with `resume: sessionId` and explicit `model` + `effort` options for the new state. The cwd is fixed, so the session is found again. The trigger points are unchanged.

### 5.6 Questions, plans and permissions (`InteractionBroker` = canUseTool)

Pending items persist in `pending.json`. The canUseTool promise may stay pending indefinitely, and it honours `options.signal`.

- **AskUserQuestion.**
  1. Show a `question` card, the yellow "?" head icon, a chime and a toast ("Ada has a question: press G").
  2. **Release the brain slot** while waiting.
  3. Answer with `{behavior:'allow', updatedInput:{questions: input.questions, answers:{[q.question]: picked.join(', ') | freeText}}}`.
- **ExitPlanMode.**
  1. Read `input.plan` (fallback: read `input.planFilePath` from Node). Show a `plan` card (orange "!", rendered markdown) with **Approve / Approve + auto-edits / Revise: ____**.
  2. Approve: `{behavior:'allow', updatedInput: input, updatedPermissions:[{type:'setMode', mode:'default'|'acceptEdits', destination:'session'}]}`, then `setPermissionMode(...)` as belt and braces.
  3. Revise: `{behavior:'deny', message:"Jasper wants changes: <feedback>"}`. The agent stays in plan mode.
  4. If S2 shows the plan text missing, add `mc__propose_plan(plan)` with the identical card.
- **Plan first.** A per-agent toggle in the AgentScreen, on by default for coding purposes. It applies at sit time.
- **Everything else** reaching canUseTool gets the gate check and is denied otherwise. There are no generic permission prompts: the sandbox, the gate and user-chosen mounts are the boundary.
- **App restart with a pending card.** The resumed session sees an interrupted tool call. Node injects "[The app restarted before Jasper answered; ask again if still needed.]" and the card is re-shown.

### 5.7 Hiring sub-agents (always confirmed)
1. The Lead calls `mc__request_hire{role, name?, reason, first_task}`.
2. The handler validates three things: the crew cap (default 4), that the role exists, and that no other hire is pending. A failure returns an immediate error.
3. Otherwise it creates hire card `h-N` (with the role skin and "Crew after: 2/4 · +1 brain") and **returns immediately**: "Asked Jasper. You'll get [HIRE DECISION]." This holds no turn open and survives restarts.
4. The player can edit the name and first task, then **Hire** or **Decline (note)**. Spawning happens only in the `hire.decision` handler:
   1. A new record (UUID, sessionId, role) is created.
   2. `agent.spawn{at:"office_door"}`: a walk-in puff and a "Bram reporting for duty!" bark.
   3. A new AgentSession starts. Its first message is the hire context plus the first task plus "you report to <Lead> via mc__tell; Jasper is the boss".
   4. The Lead gets `[HIRE APPROVED]` as a social wake. On decline the Lead gets `[HIRE DECLINED] <note>`.
5. Only the current Lead has `request_hire`; sub-agents are fully embodied with the same model policy. **Dismiss** (AgentScreen) despawns the agent with a "walks home" puff and closes its session.

### 5.8 Feeding game events in without burning tokens
- **Layer 1: reflexes act** (6.3). The mod tags each `agent.event` with an urgency: 0 = info, 1 = notable, 2 = needs judgement (stuck after 3 replans, skill failed twice, starving with no food anywhere, player in danger out of reach).
- **Layer 2: Digest.** Urgency 0/1 events are buffered per agent and prepended to the next turn as one block of about 60 tokens:
  `[D3 17:40 dusk | HP 14/20 food 9/20 | (102,64,-33) plains | Jasper 4m HP17 food12 | zombie 11m W | took 6 from zombie (reflex killed it); ate bread]`
  Every `mc` tool result also ends with a ~25-token footer.
- **Layer 3: EventRouter wake rules:**

| Event | Class | Delivery |
|---|---|---|
| `chat.send` reply / new_task | P0 player | `priority:'next'`. `new_task` also cancels the current job. |
| `chat.send` interrupt | P0 player | `priority:'now'`, `origin:{kind:'human'}` |
| PC kickoff / stand-up continuation | P1 | queued |
| Kicked, damage-unseat, PC down, own HP critical while reflex fails (≤ 1/60 s), starving with no food (≤ 1/120 s), player HP < 30% (Lead and Guard), teammate died | P2 critical | `'next'` |
| `job.done` / `job.failed`, hire decision | P3 job | `'next'`, coalesced per agent |
| `tell` from another agent | P3 social | Counts against the autonomous budget (stops ping-pong) |
| Reflex outcomes, mode changes from UI buttons | context | `shouldQuery:false`, coalesced once per 30 s |
| Pickups, sightings, time | ambient | Ring buffer only, readable via `mc__recent_events` |
| Idle nudge / heartbeat | P4 autonomous | Per the autonomy setting |

- **Autonomy slider** (ESC → Brains):
  - **Listen:** player, job and critical wakes only.
  - **Helpful (default):** adds social wakes and ONE idle nudge after 2 min of silence.
  - **Proactive:** adds heartbeats every 3 min.
- **Autonomous budget:** 20 wakes/h (Helpful) or 40 (Proactive) per agent, at least 30 s apart.
- **Jobs.** World jobs wait `wait_s` (default 20). If not done, the tool returns "Job j-12 running (3/8). You'll get [JOB DONE]. End your turn." The `job.done` event wakes the agent later. This avoids MCP timeouts and frees brain slots.

### 5.9 Concurrency and usage control (`BrainScheduler` + `UsageGovernor`)

| Control | Default | Notes |
|---|---|---|
| `maxConcurrentTurns` | 2 (range 1–4) | A slot is held from release to `result`. It is **released while blocked on the player** (question or plan); resuming may overflow by one. Player messages may borrow one overflow slot. |
| Queue order | P0 player > P1 PC continuation > P2 critical > P3 job/social > P4 autonomous | Wakes for the same agent are merged |
| `maxAgents` (crew) | 4 (range 1–6) | Also caps claude processes (measured 105–342 MB RSS each; budget 0.5 GiB) |
| `maxSeated` | 2 | Concurrent Opus sessions |
| Per-turn caps | 40 tool calls / 5 min wandering; 400 / 45 min seated | On breach: `interrupt()` and inject "Pause and summarize where you are." |
| Usage modes | `rate_limit_event` `{status, utilization, resetsAt, rateLimitType}` [V], plus `usage_EXPERIMENTAL` poll every 5 min [U S3] | **Tired:** `allowed_warning` or utilization ≥ 0.75. Cap 1, P4 off, hires disabled, amber HUD meter, "tired" bark. **Asleep:** `rejected`. All releases pause until `resetsAt + 60 s`, player messages queue, blue "Zz" over every agent, toast "brains recharge at 14:05". Reflexes keep everyone alive. |

The HUD and ESC menu show "Brains 1/2 · usage 62% · resets 14:00", plus per-agent token totals from `result.usage`.

### 5.10 Persona, memory and persistence within a world
- **Persona append**, per role (6.3 roles). It covers:
  - Identity and role.
  - Priorities: keep Jasper alive, then the crew, then Jasper's requests, then PC work.
  - "Reflexes already eat, flee, fight and feed Jasper; don't micromanage them."
  - "Jobs: when a tool says running, END YOUR TURN."
  - "Your final text is spoken aloud above your head: 1-2 short sentences. Decisions that are Jasper's go through AskUserQuestion."
  - "Computers: walk there and mc__sit_at_pc; no host shell."
  - "Only the Vault survives world death."
  - Injected `memory.md` (≤1.5k tokens), the Chronicle paragraph (Lead only), and the crew roster.
- **`memory.md`** is written by `mc__remember` (append-only, 8 KB cap) and re-injected when a session starts or resumes.
- **App restart in the same world:** `resume: sessionId`, plus a `shouldQuery:false` note "[The world was paused for 3h (app closed).]". Bodies restore from vanilla `playerdata/<uuid>.dat`.
- Transcripts: `worlds/<w>/agents/<id>/chat.jsonl` (UI) and Claude's own transcripts under `~/.claude/projects/<cwd>` (left in place, archived with the world).

---

## 6. Minecraft mod (Fabric 26.3, Java 25, package `dev.minevibe`)

### 6.1 Entrypoints and mixins
- **`MineVibeMod`** (main): blocks, entities and items registration, `AgentService`, `PcRegistry`, `HardcoreHooks`, `OfficeBuilder`, server events.
- **`MineVibeClient`**: `BridgeClient`, `ParentWatchdog`, screens, renderers, `MonitorTextures`, `ClientAgentRegistry`, HUD.
- **Common/server mixins:**
  - `PlayerListMixin`: swaps in `AgentNetHandler` for agents in `placeNewPlayer`, after Carpet.
  - `ConnectionAccessor`: `setChannel`.
  - `SleepStatusMixin`: agents excluded from the sleep quorum, so a player sleeping alone still skips the night.
  - `PlayerInfoEntryMixin`: `ClientboundPlayerInfoUpdatePacket.Entry.listed=false` for agent UUIDs. Never send REMOVE, or the client stops rendering the agent.
- **Client mixins:**
  - `GuiSetScreenMixin`: single choke point. `TitleScreen`/`DisconnectedScreen` become `BootScreen`; `DeathScreen` becomes `GameOverScreen`.
  - `MinecraftPauseGameMixin`: ESC opens the non-pausing `MineVibeMenuScreen`.
  - `PlayerSkinMixin`: `PlayerInfo.getSkin()` returns `PlayerSkin.insecure(…)` from `assets/minevibe/textures/entity/agent/<role>.png` for agent UUIDs.
  - `AvatarRendererMixin`: bubbles and head icons.
- **26.x API notes:** `Identifier`, `EntityTypes.*`/`BlockEntityTypes.*`, `Minecraft.getInstance().gui.setScreen`, `GuiGraphicsExtractor`/`extractRenderState`, `LevelRenderEvents`, `BlockEntityRenderers.register` (Fabric's `BlockEntityRendererRegistry` is deprecated), records `GameProfile`/`Property`.

### 6.2 Agent bodies (Carpet v26.3 pattern, vendored under MIT, not a dependency)
```java
GameProfile gp = new GameProfile(uuid, name);   // uuid = UUIDUtil.createOfflinePlayerUUID("mv-agent:" + agentId)
AgentPlayer p = new AgentPlayer(server, level, gp, ClientInformation.createDefault());   // small view distance
server.getPlayerList().placeNewPlayer(new AgentConnection(PacketFlow.SERVERBOUND), p,
    new CommonListenerCookie(gp, 0, p.clientInformation(), false));                    // [V] 26.3 record
```
- `AgentConnection extends Connection`: `EmbeddedChannel` via an accessor; no-op `send`, `setReadOnly` and `handleDisconnection`. `AgentNetHandler extends ServerGamePacketListenerImpl` ignores idle kicks.
- `AgentPlayer.tick()` calls `actionPack.onUpdate()`, then `super.tick()`, then `doTick()`. This gives real server-side player physics from steering inputs (`zza`/`xxa`, look, jump, sneak, sprint).
- `AgentControls` is the trimmed `EntityPlayerActionPack`: USE, ATTACK (continuous for block breaking), JUMP, DROP_ITEM/STACK, SWAP_HANDS, setForward/Strafing, look/lookAt, sneak, sprint. **Never use `mount()`**, which forces the ride.
- **Free from vanilla:** real health, hunger, saturation, air, armor, inventory, crafting and container menus, riding, mob targeting, death messages, chunk loading, `playerdata` persistence.
- **`die(DamageSource)`:**
  1. Move the inventory into a `GraveBlockEntity` (nothing scatters).
  2. `super.die`, which produces the vanilla death message.
  3. Emit `agent.died` with last words.
  4. On the next tick, disconnect via `connection.onDisconnect`, which leads to `PlayerList.remove`.
  5. Delete `playerdata/<uuid>.dat`.

  The record is marked dead and the UUID is never reused. A fake never sends PERFORM_RESPAWN, so the hardcore spectator logic never runs.
- **Friendly fire:** `ServerLivingEntityEvents.ALLOW_DAMAGE` cancels melee and projectile damage from the player to agents and between agents. The agent gets knockback and an "Ow. Rude." bark. Mobs, lava, falls and explosions are real.

### 6.3 Reflex layer vs LLM goals (`ReflexBrain`, every tick per agent; zero tokens)

The highest active entry preempts lower ones. A preempted job resumes, or fails with "interrupted by danger" after Flee.

| Priority | Reflex | Trigger → action |
|---|---|---|
| 100 | Hazard | In lava or fire, air < 5, suffocating, void → nearest safe standable block, swim up, water bucket if carried |
| 95 | CreeperBackoff | Swelling creeper within 4 → back off |
| 90 | CriticalHeal | HP < 6, has food, no hostile within 4 → eat |
| 85 | Flee | HP < 6 and hostile within 6, **unless player HP < 6** (then stand and fight) → path toward the player or office; urgency-2 event if flight fails |
| 80 | ProtectPlayer | Hostile targeting the player or an ally within 12, own HP ≥ 8 → equip best weapon, attack on cooldown (`getAttackStrengthScale(0.5f) >= 1`) |
| 70 | SelfDefense | Being attacked → fight back |
| 60 | Eat | Food ≤ 14 out of combat, or ≤ 6 anytime → eat the best saturation food. Also while seated. |
| 55 | FeedPlayer | Player food ≤ 12, agent has spare food, player within 24 → walk over and toss: "Eat this!" |
| 50 | ShareFood | Teammate food ≤ 8, agent has spare → toss |
| 45 | UnseatToFight | Seated, attacked, HP < 50% → stand up, emit `pc.unseat{damage}`. Bark: "Bram got up from linux-1 to fight a zombie." |
| 35 | **Job** | Current LLM-commanded job (JobRunner: `start/tick/onPreempt/onResume/progress`) |
| 30 | Shelter | Dusk, outside, no job → go to the office. Dusk bark once. |
| 25 | Pickup | Items within 4, no job |
| 10 | Idle mode | `follow` (default: 3 blocks, which is how the Lead "listens"), `stay`, `guard`, `wander` |

- **Role profiles** (weights and barks only; personality lives in the persona):
  - **Lead:** protect and feed high; "PM energy". Plan-first off.
  - **Engineer:** self-defence only; idles near a free PC; plan-first on.
  - **Miner:** flees early; deposits loot in the office chest.
  - **Farmer/Cook:** feed and share very high.
  - **Guard:** protect max, flee very low. The funniest deaths.
  - **Builder:** normal.
- **Barks** are scripted, zero-token lines with cooldowns: `greet, dusk, feed_player, kicked, sat_at_pc, teammate_died, stuck, tired, asleep, last_words, player_low_hp, wake` ("Hmm, one sec…" fires instantly when an LLM wake starts, hiding Haiku/xhigh latency).

### 6.4 Pathfinding
- **Tier 1 (M2), vanilla A\*:**
  - `new PathFinder(new WalkNodeEvaluator(), 4000).findPath(region, proxy, targets, maxRange, 1, 1f)` [V signature].
  - `proxy` is a `NavProxyMob extends PathfinderMob` that is **never added to the world** [U S1]. It is repositioned to the agent each plan, with a 0.6×1.8 box, `setCanOpenDoors(true)` and `setCanFloat(true)`.
  - Long goals are split into 40-block waypoints.
- **`PathExecutor`:**
  - Each tick: look at the next node, forward = 1.
  - Jump when the next node is ≥ 0.5 higher or on horizontal collision. Hold jump in water. Use doors.
  - Sprint on segments > 6–8 blocks when food > 6. Sneak near edges.
  - Refuse drops > 3 blocks (2 when HP < 10).
- **Stuck ladder:**
  1. No progress for 30 ticks → jump.
  2. 60 ticks → replan.
  3. 3 replans → **Unstuck**: a visible "poof" teleport of at most 3 blocks to a safe standable spot, with an "…I'm fine." bark.
  4. Still stuck → `job.failed` with urgency 2.
- **Tier 2 (M6), `DigPathPlanner`:** incremental block-grid A* with break, pillar and bridge edges, costed by tool break time and scaffold carried. Ideas from mineflayer-pathfinder (MIT). Budget 1.5 ms per tick per agent, 20k nodes, 96-block radius.

### 6.5 Skill API / `mcp__mc__*` tool list

Long jobs accept `wait_s` (default 20, max 120) and return `running` plus `job_id`. Read-only tools carry `readOnlyHint`.

| Group | Tools (args) |
|---|---|
| Observe | `status{}`, `look_around{radius=16, detail=brief\|full}`, `inventory{}`, `find{target: block\|#tag\|mob\|name, radius≤64, limit≤10}`, `recipe{item}` (ingredients, station, what is missing), `recent_events{limit=20}`, `crew{}`, `list_pcs{}`, `job_status{job_id, wait_s≤120}` |
| Behaviour | `set_mode{mode: follow\|stay\|guard\|wander, target?, distance?}`, `stop{}` |
| Move | `goto{target: {x,y,z}\|{entity}\|{place:"office"\|"bed"\|"chest"\|"pc:<id>"}, range=1, sprint?}` |
| World | `mine{x,y,z}`, `collect{block, count≤64, radius≤48}`, `hunt{mob, count}`, `dig{from,to}`, `place{item, x,y,z, face?}`, `use_block{x,y,z}`, `use_item{item?, target?: pos\|entity\|"air", hold_ticks?}` (doors, levers, buckets, bows, flint, bonemeal, breeding), `attack{target\|nearest:"hostile", until: dead\|once}`, `equip{item, slot}`, `eat{item?}`, `sleep{}`, `pickup{radius≤8}`, `drop{item,count}`, `give{to, item, count}` |
| Craft | `craft{item, count=1}`, `smelt{input, count, fuel?}`, `container{at\|"office_chest", action: list\|deposit\|withdraw, item?, count?}` |
| Build | `build{blueprint: shelter\|wall_ring\|farm_plot\|torch_ring\|bridge\|stairs_down, at?, size?}`, `farm{action: till_plant\|harvest\|tend, crop?, area?}` |
| Ride | `ride{entity\|pos}` (cushion, boat, minecart, horse; non-forced `startRiding`), `dismount{}` |
| PC | `sit_at_pc{pc, purpose}`, `stand_up{}` |
| Social / meta | `say{text}`, `tell{agent, text}`, `emote{wave\|nod\|shake\|jump\|crouch\|point, target?}`, `remember{note}`, `wait{seconds\|until: job_done\|morning\|player_message}` (ends the turn, sets a wake), `request_hire{role, name?, reason, first_task}` (Lead only) |

Job implementations:
- **`MineJob`:** best tool via `getDestroySpeed`, hold ATTACK until broken, torch if light < 7, collect drops.
- **`CraftJob`:** server `RecipeManager` lookup. Opens the real `CraftingMenu` (inventory 2x2, or a table within 4 blocks, pathing there or placing one), places ingredients via the same server recipe-placement path `ServerboundPlaceRecipePacket` uses, then quick-moves the result. Ingredients are really consumed. Fallback if placement is awkward: atomic consume and insert.
- **`SmeltJob` / `ContainerJob`:** real `useItemOn` on the block entity, slot transfers, close.
- **`GiveJob`:** walk to the target and toss toward it. This is how agents feed and equip the player and each other.

### 6.6 Blocks, items, entities

| Id | What |
|---|---|
| `minevibe:pc_desk` | Two-wide desk with monitor model, `PcBlockEntity{pcId, type, seatPos}`. BlockState `status = off\|booting\|running\|busy\|error\|no_capacity` drives an LED. The monitor quad is about 2.0 × 1.25 blocks with a custom render bounding box. |
| `minevibe:office_chair` | `ChairBlockEntity{pcPos}`. Use: spawn and mount a `minevibe:seat`. |
| `minevibe:seat` | Invisible, no gravity, not saved. `canAddPassenger = passengers.isEmpty()`, so single occupancy holds by construction. `PcRegistry.occupant` is the authoritative double check. Own entity rather than vanilla `Cushion`: no drops, no block-anchor or fire rules. |
| `minevibe:linux_workstation`, `minevibe:mac_workstation` (items) | Placing one puts down desk + monitor + chair facing it in one action (no link logic). Data component `minevibe:pc_id`: breaking "unplugs" the PC (sandbox stopped) and re-placing rebinds the **same** sandbox. A new item without an id sends `pc.action{create}`; if over budget, the monitor reads "No host capacity". |
| `minevibe:grave` | `GraveBlockEntity{agent, role, day, lastWords, items}` with a sign: "Bram, Miner, Day 4" |
| `minevibe:diary` | Written book holding the dead agent's `memory.md`. Giving it to an agent injects it into that agent's next turn. |

- **Recipes (survival):**
  - Linux workstation: 4 iron, 2 redstone, glass pane, copper.
  - Mac workstation: 4 iron, 2 gold, glass pane, redstone.
  - Chair: planks, sticks, wool.
- **`OfficeBuilder`** is procedural. On a fresh world it builds a lit 9×7 plank-and-glass cabin at spawn: door, 2 beds, a chest with 8 bread and 16 torches, crafting table, furnace, and one workstation per enabled PC slot (annex row for extras). Spawn is set inside, and slots are bound to existing `pcId`s.
- **Gamerules:** `announceAdvancements=false`, `spawnRadius=0`. `allowCommands` only in dev builds (`/mv scenario …`).

### 6.7 Monitor rendering (no raw GL, so the Vulkan backend works)
- **`MonitorTextures`:** one `ScreenTexture extends DynamicTexture(() -> "minevibe/pc/"+id, new NativeImage(RGBA, w, h, false))` per PC. It overrides the sampler to `getClampToEdge(FilterMode.LINEAR)` and registers with `TextureManager.register(Identifier.fromNamespaceAndPath("minevibe","pc/"+id), tex)`.
- **Decode thread:**
  - JPEG: `STBImage.stbi_load_from_memory(buf, w, h, comp, 4)`, `memCopy` into a staging `NativeImage`, `stbi_image_free`.
  - BGRA8: `memCopy` plus an R/B swizzle.
  - RGBA8: `memCopy`.
- **Render thread:** at most one upload per PC per frame. Full frames use `getPixels().copyFrom(staging); upload()`. Dirty rects use `CommandEncoder.writeToTexture(gpuTex, byteBuf, 0, 0, x, y, w, h)` [V].
- **`PcBlockEntityRenderer`** (registered via `BlockEntityRenderers.register`):
  - `extractRenderState` copies facing, status, texture id and a has-frame flag.
  - `submit(state, pose, collector, camera)` calls `collector.submitCustomGeometry(pose, RenderTypes.text(texId), (p, vc) -> 4× vc.addVertex(p,x,y,z).setColor(-1).setUv(u,v).setLight(LightCoordsUtil.FULL_BRIGHT))`, the vanilla MapRenderer pattern.
  - `getViewDistance()` returns 64.
  - Without a frame it draws status screens: "Booting… 37%", "OFFLINE: no host capacity", "Apple allows 2 macOS VMs", "Reimaging…".
- **`PcViewTracker`** (client tick) sends `pc.view`: `focus` when the player is seated or watching, `visible` with projected pixel size within 32 blocks and in the frustum, otherwise none. Tiers are in 7.5.

### 6.8 Seated input capture (player)
1. Right-click a **free** chair: non-forced `startRiding(seat)`, then `PcControlScreen` opens.
2. The screen is non-pausing (`isPauseScreen()==false`, `shouldCloseOnEsc()==false`). It animates over 200 ms from the monitor's projected bounds to an aspect-fit rect covering about 92% of the window; the world stays visible at the edges. A hint bar reads "Shift+Esc to stand up · Tab to look around".
3. On open, call `Minecraft.getInstance().onTextInputFocusChange(screen, true)`. This is required for `charTyped` (SDL text input) [V].
4. **Mapping:**

   | Event | Sent as |
   |---|---|
   | `mouseMoved` | `move`, linear map to guest pixels, coalesced at 60 Hz |
   | `mouseClicked` / `mouseReleased` | `bd`/`bu` (buttons 1/2/3 are left/middle/right) |
   | `mouseScrolled` | `scroll` |
   | `charTyped(CharacterEvent.codepoint())` | `text`, layout-correct (AZERTY works) |
   | `keyPressed`/`keyReleased(KeyEvent)` with `key()` = SDL scancode | `SdlKeyMap` to cua `KEY_*` names, sent as `kd`/`ku` for Enter, Backspace, Tab, Esc, arrows, Home/End, PgUp/PgDn, Delete, F1–F12 and modifiers. Letters inside chords use `shortcutKey()` [U S4]. Repeat events re-send. |

5. **Cmd handling.** Cmd (`MOD_SUPER=3072`) maps to `ctrl` on Linux guests and `cmd` on macOS guests (configurable). On Cmd+V the host clipboard is pushed with `setClipboard`, then paste is sent.
6. **Exit and safety.**
   - **Shift+Esc** stands up; plain Esc goes to the PC (vim works).
   - **Tab** toggles in-world look-around while seated.
   - Taking damage flashes the border red. Below 6 HP, control auto-releases (configurable).
   - Every release sends `ku` for all held keys.
7. **Watch mode.** PcConfigScreen's **Watch** button opens the same screen read-only, to watch an agent work fullscreen.

### 6.9 Kicking agents
- **Three ways in:** sneak + left-click a seated agent (damage cancelled); **Kick from PC** in AgentScreen or PcConfigScreen; right-click an occupied chair, which asks "Kick Bram and sit?".
- **All call** `getSingleplayerServer().execute(() -> pcRegistry.kick(pcId))`:
  1. `agent.stopRiding()`, step aside 1 block with a small knockback.
  2. 30 s re-sit cooldown.
  3. Bark: "Rude. I had three tests left."
  4. Emit `pc.unseat{reason:"kicked"}`. Node then runs the 5.5 kick sequence.
- A player can only sit at a free PC; occupancy is never shared.

### 6.10 Bubbles and the legibility kit
- **`AvatarRendererMixin`:**
  - At `extractRenderState` TAIL, attach bubble lines and the head-icon state from `ClientAgentRegistry` via Fabric `RenderStateDataKey`.
  - At `submit` TAIL, call `collector.submitNameTag(pose, attachment, yOffset_i, line_i, false, light, camera)` per line [V signature; S4].
  - Fallback: a `LevelRenderEvents` billboard with `Font`.
  - Bubbles wrap at about 28–40 chars, max 3 lines, stack up to 3, fade by distance up to 24 blocks, and hide with F1. Agents beyond 32 blocks show toasts instead.
- **Head icons:**

  | Icon | Meaning |
  |---|---|
  | Yellow bobbing "?" | Question waiting |
  | Orange "!" | Plan or hire waiting |
  | Animated grey "…" | Thinking |
  | Hourglass | Queued for a brain slot |
  | Blue "Zz" | Usage asleep, or bridge offline |
  | Cyan monitor | Seated |

- **Name-tag suffix:** `[H]` Haiku or `[O]` Opus. It flips with a particle burst and a "big brain time" bark on sit. Red tint when hurt; drumstick when hungry.
- **`CrewHud`** (toggle **H**): face, name, hearts, hunger, status icon and one-line activity per agent, plus the brain meter. **Toasts** bottom-left.

### 6.11 UIs (all non-pausing; the world keeps running and the crew guards you)
- **AgentScreen** (right-click an agent via `UseEntityCallback`; the client returns SUCCESS. Holding food while the agent is hungry feeds it instead):
  ```
  +-- [face] ADA · Lead · [H] Haiku 5.5 xhigh · HP 14/20 · Food 9/20 · Brain: thinking ----------------+
  | Now: collecting oak_log (3/8)   [Follow] [Stay] [Stop] [Kick from PC] [Plan first: x] [Dismiss…]  |
  +---------------------------------------------+----------------------------------------------------+
  | Jasper: can you get iron?                   | WAITING FOR YOU (2)                                |
  | Ada: On it. Heading to the east cave.       | QUESTION · Iron: What should I make with 8 iron?   |
  |   . job: mine iron_ore x8   . reflex: ate   |  (o) Chestplate  ( ) 2 pickaxes  ( ) Other [____]  |
  | Ada: Found 8. What do you want made?        |  [Submit]   (multiSelect -> checkboxes)            |
  |                                             | PLAN (markdown) [Approve] [Approve+auto] [Revise_] |
  |                                             | HIRE Bram (Miner) · first task [____] [Hire][Decl.]|
  +---------------------------------------------+----------------------------------------------------+
  | > message…                               [Reply ⏎] [New task] [Interrupt ⌘⏎]                     |
  +--------------------------------------------------------------------------------------------------+
  ```
  The transcript pages via `chat.history`. Follow, Stay and Stop are handled in the mod at zero tokens.
- **PcConfigScreen** (right-click a desk, or ESC → PCs):
  - Header: type and image, status, uptime, occupant.
  - CPU and memory sliders clamped to `free + current`. Display is fixed at 1280x800.
  - **Host budget bars:** RAM (reserves, each PC, free), OrbStack pool, vCPU (soft), disk free, macOS slots `1/2 (Apple)`.
  - **VAULT** list: path, rw/ro, remove; **+ Browse…** (`host.pickFolder`), or a path field. Refused paths: anything outside `$HOME`, `~/Library`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude`, `/`.
  - Toggles: "Wipe on world death" (default off), "Offline PC" (`--network none`).
  - Buttons: **Apply** (warns "restarts PC, kicks Bram" when mounts change), Start/Stop/Restart, Reimage…, Watch, Decommission… (double confirmation).
- **HUD hover line** when looking at a desk: `linux-1 · Ubuntu 24.04 · 2 vCPU · 4 GB · running · Bram · host free 15 GB`.
- **MineVibeMenuScreen** (ESC): Resume · Crew (roster, Hall of Fame) · PCs & Resources (overview, budget, **+ New PC**) · Brains (concurrency cap, crew cap, autonomy, Pause all brains, usage meters, subscription type) · Options (vanilla) · **Quit MineVibe** (`minecraft.stop()`). No "Save and Quit to Title", LAN, multiplayer or Realms.
- **Controls:**

  | Input | Effect |
  |---|---|
  | **G** | Open the oldest pending item |
  | **H** | Toggle the crew HUD |
  | **T** | Shout to agents within 32 blocks ("wakes N agents") |
  | Shift+Esc | Stand up from a PC |
  | Esc | MineVibe menu |

### 6.12 Hardcore death and the new world
1. The local player dies. `ServerLivingEntityEvents.AFTER_DEATH` on a non-agent `ServerPlayer` sends `player.died`. `GuiSetScreenMixin` swaps the hardcore `DeathScreen` for **GameOverScreen**: "GAME OVER · World #7 · Day 5 · Killed by Skeleton", crew fates, "Vault: 14 commits to ~/Code/foo (uncommitted changes are still on disk)", and **[Begin World #8]** (disabled until `world.next` arrives). Footer: "Only the Vault and your machines survive."
2. **Node `WorldLifecycle.endWorld()`:**
   1. Every living agent gets one capped Haiku turn (10 s, then interrupt): "[WORLD ENDING] one sentence of last words, then optionally `mc__remember` a ≤300-char note for your successor." Bubbles play.
   2. Deny pending canUseTool calls ("world ended"), interrupt and close all queries, archive the records.
   3. Write the Chronicle entry. Run `git -C <mount> log --since=<worldStart> --oneline | wc -l` per mount.
   4. Reimage PCs that have wipe-on-death enabled, in the background.
   5. Send `world.next`.
3. **On click** (client thread):
   1. `minecraft.disconnect(new GenericMessageScreen(…), false)`. This blocks until the integrated server thread has exited.
   2. Send `world.state{closed}`. Node moves `saves/<old>` to `saves/_graveyard/` and keeps the last 5.
   3. `createWorldOpenFlows().createFreshLevel(newId, new LevelSettings(name, GameType.SURVIVAL, new LevelSettings.DifficultySettings(Difficulty.HARD, true, false), allowCommandsDevOnly, WorldDataConfiguration.DEFAULT), WorldOptions.defaultWithRandomSeed(), WorldPresets::createNormalWorldDimensions, bootScreen)` [V APIs; flow untested, S7].
4. On server start: `OfficeBuilder`, spawn set inside, slots bound, `world.state{ready, fresh}`. Node spawns the new Lead with the Chronicle greeting. Monitors show "Reimaging…" where applicable.

### 6.13 Boot straight into the world
- `GuiSetScreenMixin` replaces any `TitleScreen` (and `DisconnectedScreen`) with **BootScreen** ("Waking up World #7…" plus PC boot progress). BootScreen connects to the bridge and waits for `world.open`, then calls `openWorld(id, onCancel→retry)` if the folder exists, otherwise `createFreshLevel(…)`. `--quickPlaySingleplayer` is not used, because it errors on a missing world.
- The current world id lives in `state/current-world.json`, owned by Node. An unexpected disconnect returns to BootScreen and reopens the world.
- **`options.txt`** is merged on every launch: `pauseOnLostFocus:false`, `onboardAccessibility:false`, `tutorialStep:none`, `skipMultiplayerWarning:true`, `joinedFirstServer:true`, `realmsNotifications:false`, `narrator:0`, `autoJump:false`. In release builds also `chatVisibility:2` and the chat/command keys unbound [U key names, S8].
- **Game args:** `--disableMultiplayer`; `--disableChat` in release builds only, so dev `/mv` commands keep working.

---

## 7. PC manager

### 7.1 PC types

| Type | Driver | Image | Defaults | Min | Instance limit | Notes |
|---|---|---|---|---|---|---|
| `linux` | DockerLinuxDriver (OrbStack, `--runtime=runc` explicit) | `minevibe/linux-pc:24.04` (FROM pinned `ghcr.io/trycua/linux:24.04` digest + tmux, ripgrep, git, build-essential). Base ships Node 24, Go, uv, gh, rust, docker CLI; XFCE on Xvfb :1, user `cua` uid 1000. | 2 vCPU / 4 GiB / shm 512 MiB | 1 / 1 GiB | budget | Default PC `linux-1`. Boots in seconds. |
| `linux-slim` | same | FROM pinned `24.04-slim` | 1 vCPU / 2 GiB | 1 / 1 GiB | budget | Cheap "terminal PC" |
| `macos` | LumeMacDriver | pinned `ghcr.io/trycua/macos:26` (Tahoe, ships spacesd) | 4 vCPU / 8 GiB, 150 GiB sparse disk (image-defined), 1280x800 | 2 / 4 GiB | **2 running (Apple)** | Opt-in. About 24 GB first pull. Needs ≥ 40 GB free disk. |
| `windows` | – | `trycua/windows:2022` is amd64 only (TCG) | – | – | 0 | Shown greyed: "Unavailable on Apple Silicon (emulation too slow)" |

Later candidates: a Linux VM PC (stronger isolation, QEMU-HVF or Lume), and a "browser PC" (Linux image in Chromium kiosk mode).

### 7.2 Budget (`Budget.ts`)

| Item | Formula | Today |
|---|---|---|
| Host | `sysctl hw.ncpu`, `hw.memsize`, `statfs` | 18 cores / 48 GiB / 199 GiB free |
| Reserves (editable) | macOS + apps 10 GiB, Minecraft 8 GiB (`-Xmx6G` + native), Node 0.5 GiB, claude 0.5 GiB × crew cap (4), OrbStack overhead 1 GiB; CPU 4 cores | 21.5 GiB, 4 cores |
| **PC RAM pool** (hard) | host − reserves | **≈ 26.5 GiB** |
| **PC CPU pool** (soft) | cores − 4, overcommit up to 1.5× with an amber warning | 14 (soft cap 21) |
| **Linux pool** (hard) | `docker info .MemTotal` − 1 GiB − Σ other non-MineVibe containers' memory limits | ≈ 14.6 GiB (engine cap `memory_mib=16384`) |
| macOS | Counted against the host pool, not the engine; ≤ 2 running; disk ≥ 40 GB free to create | 0/2 |

- **Admission rule:** a PC starts only if `alloc + req ≤ pool` **and** (Linux) `linuxAlloc + req ≤ linuxPool` **and** (macOS) `running < 2`. Otherwise its status is `no_capacity` with a red LED.
- **Validation:** edits are checked by the worker and rejected with `err OVER_BUDGET`.
- **OrbStack cap:** the budget screen shows the hint "Raise OrbStack memory: OrbStack → Settings, or `orb config set memory_mib 24576`". MineVibe never changes it.

### 7.3 The Vault (folder mounts)
- `pcs.json` stores per PC: `mounts:[{host, ro}]`. Basenames must be unique per PC, and `setup` is reserved (macOS).
- **Mount paths:**
  - Linux: identical absolute path, plus `~/vault/<name>` symlink, plus an extra `:ro` overlay on `<mount>/.git/hooks` if it exists.
  - macOS: Lume share at `/Volumes/My Shared Files/<name>`, symlinked by `sudo ln -sfn` at boot to the identical absolute path.
- Mount changes need a restart or recreate; the UI says so and kicks the occupant.
- **Post-boot provisioning** (spacesd `sh`): `git config --global --add safe.directory '*'` (bind-mount uid mismatch, S5) and write `~/MOUNTS.md`.
- The same folder may be rw in two PCs; the UI warns about concurrent edits.

### 7.4 Drivers and lifecycle
**DockerLinuxDriver** (docker CLI via `execa`; label `dev.minevibe.pc=<id>`):
```
docker run -d --name mv-pc-<id> --hostname <id> --label dev.minevibe.pc=<id> --runtime=runc \
  --cpus 2 --memory 4g --memory-swap 4g --shm-size 512m \
  -e CUA_RESOLUTION=1280x800 -e DO_NOT_TRACK=1 -e CUA_TELEMETRY=0 \
  -e CUA_ENV_TOKEN_FILE=/run/secrets/cua-token -v "$MV/state/tokens/<id>":/run/secrets/cua-token:ro \
  -v mv-pc-<id>-home:/home/cua \
  -v /Users/me/Code/foo:/Users/me/Code/foo \
  -v /Users/me/Code/foo/.git/hooks:/Users/me/Code/foo/.git/hooks:ro \
  -p 127.0.0.1::3211 minevibe/linux-pc:24.04          # or minevibe/pc-<id>:snap after a remount
docker port mv-pc-<id> 3211/tcp    # -> 127.0.0.1:5xxxx -> embedded().spacesd('http://127.0.0.1:5xxxx', token)
```
- **Token fallback** (S5): `-e CUA_ENV_TOKEN=…`.
- **Resize:** `docker update --cpus --memory --memory-swap`, live.
- **Remount:** `docker stop -t 15`, then `docker commit mv-pc-<id> minevibe/pc-<id>:snap`, then `docker rm`, then `docker run` from the snapshot with the new `-v` list and the same home volume.
- **Stop/start:** `docker stop -t 15` / `docker start` and re-read the port. Never `pause`, which keeps RAM allocated.
- **Reimage:** `rm -f`, `volume rm mv-pc-<id>-home`, `rmi` snapshot, `run` from the base image.
- **Decommission:** reimage without the run, then drop the entry from `pcs.json`.

**LumeMacDriver:**
- **Get Lume.** Two options, both with user consent at M8: cua's pinned built-in Lume (downloaded by the first `@trycua/cua` macOS create), or `brew install lume` (homebrew/core 0.6.1). Run `lume serve` as a child process on 127.0.0.1:7777.
- **Base, once:** pull `ghcr.io/trycua/macos:26` into a stopped `mv-macos-base` (exact pull syntax [U S6]).
- **Per PC:** `lume clone mv-macos-base mv-pc-<id>` (APFS clonefile), `lume set mv-pc-<id> --cpu 4 --memory 8GB`.
- **Run:** `POST /lume/vms/mv-pc-<id>/run {"noDisplay":true,"sharedDirectories":[{"hostPath":"$MV/state/macsetup/<id>/setup","readOnly":true},{"hostPath":"/Users/me/Code/foo","readOnly":false}]}`. The `setup` share carries `env-token`, which mimics cua's own bootstrap: the guest `start-spacesd.sh` reads `/Volumes/My Shared Files/setup/env-token` [U S6].
- **Endpoint:** `GET …/mv-pc-<id>` gives `ipAddress`; spacesd is at `<ip>:3211`. At boot, provision the symlinks for path identity.
- **Limit:** before any start, count running macOS PCs. A third is refused, and Lume's `409` maps to the same "macOS slots full (2/2)".
- **Stop:** `lume stop`. Lume has no in-memory suspend, so the next start is a cold boot (30–90 s), shown on the monitor.
- **Reimage:** `stop`, `delete`, re-clone.
- **Fallback (S6 fails):** create via `embedded().sandboxes().create(SandboxCreateOptions.create({on:'local', image: Image.macos(), cpus:4, memoryMb:8192n}))` with no Vault. Agents use PcFiles tools and `Space.upload/download` or git.

**Lifecycle:**
- **App launch:** reconcile (`docker ps -a --filter label=dev.minevibe.pc`, `GET /lume/vms`), then `bootAll(enabled)` in parallel with JVM start. Linux takes about 5 s; macOS boots are serialized. The LED shows `booting` until `spacesd` health passes (timeout 120 s Linux, 300 s macOS). Image pulls happen lazily with progress on the monitor.
- **World reset:** PCs keep running and their disks persist, unless "Wipe on world death" is on. Occupants are unseated, and the new office rebinds the same `pcId`s.
- **App quit:** stop all PCs in parallel within 20 s. Option "Keep PCs running when MineVibe is closed" (off by default).
- **Crash safety:** unknown `mv-*` containers or VMs are listed by `doctor`, never auto-deleted.

### 7.5 Frame path

| Tier | When | Source | Encoding to the mod |
|---|---|---|---|
| **B: focus** | Player seated or Watch fullscreen | `SpacesdClient.openMedia({maxFps:30, maxDimension:1280, requestJson:'{"codecs":["MEDIA_CODEC_BGRA"]}'}, sink)`. XDamage-gated, so an idle screen costs about nothing. Never request PNG-only (fails on Linux). | Raw BGRA8 (≈4 MB per frame, ≤123 MB/s on loopback) with optional dirty rects. **If S4/S5 shows WS or JVM strain:** `sharp` JPEG q80 (about 5 ms), sent as codec JPEG. |
| A: agent seated, player within 24 and in view | | Unary `screenshot({format:Jpeg, quality:65, maxDimension:960})`, one request in flight, skipped if the hash is unchanged | JPEG, 4–8 fps |
| A: visible within 32 | | Same at `maxDimension:640` | JPEG, 2–4 fps |
| none | | – | 0 fps; the last frame is kept |

- Media sessions close when focus ends. H.264 is never used: the npm SDK returns encoded frames only. ffmpeg exists as a last resort.
- If the media path fails, Tier B falls back to unary polling (estimated 5–15 fps; S5 measures it).
- A JVM attaching directly to `/media` with a ticket is a later optimization [U].

### 7.6 Input path
- `pc.input` → **InputRouter**:
  1. Check that the occupant is this player (PcRegistry mirror).
  2. Per-PC serialized async queue; only the latest move is kept while a call is in flight.
  3. Calls: `pointerJson('{"move":…}' | '{"down":{"button":"MOUSE_BUTTON_LEFT"}}' | '{"up":…}' | '{"scroll":…}')`, `keyboardJson('{"down":{"key":{"named":"KEY_SHIFT"}}}')` / `up`, `typeText` for text, `hotkey` for `k` chords [V shapes].
  4. Held keys are tracked per occupant and all released on unseat, kick or screen close (unary RPCs have no lease).
- Agent `pc` tools use the same router with an agent-occupant check.

### 7.7 Security posture
- spacesd is published on loopback only (Docker) or on the host-only Lume NAT IP, with a per-PC random 24-byte token. The bridge is loopback with a token.
- Agents have no host shell. Host file tools are gated to Vault paths of the seated PC. There is no raw `cua mcp`, so no `sandbox_*` tools.
- PCs have outbound network access by default (npm, pip); the per-PC Offline toggle applies `--network none`.
- cua telemetry is off (`DO_NOT_TRACK=1`, `CUA_TELEMETRY=0`, `telemetrySetEnabled(false)`).

---

## 8. Launcher and app
- **`MineVibe.app`** (built locally, unsigned, personal use) in `~/Applications`:
  - `Contents/MacOS/MineVibe` (zsh): `exec /opt/homebrew/opt/node@24/bin/node "$RES/server/main.mjs" run`. The Node path is checked at start.
  - `Info.plist`: `LSUIElement=true`, so the only window and Dock presence is Minecraft's (`-Xdock:name=MineVibe -Xdock:icon=…`).
  - `Resources/`: server bundle + production `node_modules` (SDK and cua native optional dependencies), mod jar, Fabric API jar, icon.
- **`npm run setup`** (one-time, terminal with progress bars, idempotent; `run` re-verifies cheaply):
  1. **Java 25 runtime:** `createJavaRuntimeInstallWorkflow({target:'java-runtime-epsilon', destination: runtime/java-25})` (mac-os-arm64, 25.0.1; `fetchJavaRuntimeManifest` defaults to beta, so pass epsilon) gives `jre.bundle/Contents/Home/bin/java`. Fallback: Mojang `all.json` manifest fetched directly.
  2. **MC 26.3:** `resolveMinecraftVersionJsonInstallFile`, `resolveMinecraftJarInstallFile`, `resolveLibraryInstallFiles` and `resolveAssetInstallFiles`, run with `executeInstallManifest`.
  3. **Fabric:** `executeInstallWorkflow(createFabricInstallWorkflow({minecraftVersion:'26.3', version:'0.19.5', minecraft}), createDefaultNodeInstallRuntime())`.
  4. **Mods:** `fabric-api-0.162.0+26.3.jar` (maven.fabricmc.net, sha1-checked) and `minevibe-<v>.jar` into `game/mods/`.
  5. `docker build -t minevibe/linux-pc:24.04 images/linux-pc` (base pinned by digest).
  6. Claude preflight (5.2).
  7. Merge `options.txt`.
  8. Build `MineVibe.app`.
  9. **Building the mod needs JDK 25** for the Gradle daemon. Primary: Gradle daemon-JVM auto-provisioning (S0). Fallback: user-approved `brew install --cask temurin@25`.
- **`run` sequence (P1):**
  1. Lock `run/lock`. If MineVibe is already running, focus the Java window and exit.
  2. Preflight:
     - Docker reachable; if not, `open -a OrbStack` and wait 30 s.
     - Claude login and version.
     - `lume` only if a macOS PC is enabled.
  3. Allocate port and token, write `run/bridge.json` (0600), fork the worker. The worker starts BridgeServer and `PcManager.reconcile()+bootAll()`.
  4. `@xmcl/core` `launch({gamePath, javaPath, version:'fabric-loader-0.19.5-26.3', gameProfile:{name:'Jasper', id: offlineUUID}, accessToken:'0', extraJVMArgs:['-Xmx6G','-Dminevibe.bridgeFile=…','-Dminevibe.parentPid=<P1>','-Xdock:name=MineVibe','-Xdock:icon=…'], extraMCArgs:['--disableMultiplayer', …release ? ['--disableChat'] : [], '--width','1600','--height','1000']})`. `-XstartOnFirstThread` comes from the version JSON rule [V].
- **Auth:** offline profile (fixed username, offline UUID, single-player only; the user owns the game). Microsoft login is out of scope: it needs a Mojang-approved Azure app.
- **Shutdown** (in or out):
  1. Closing the window, Cmd+Q or Quit MineVibe makes vanilla save, and `CLIENT_STOPPING` sends `client.stopping`.
  2. The JVM exits.
  3. P1 tells P2 to interrupt and `close()` every query (sessions stay resumable) and stop PCs in parallel within 20 s.
  4. P2 exits, then P1 exits.

  Failure cases:
  - The JVM dies without `client.stopping`: P1 runs the same shutdown.
  - The worker crashes: P1 re-forks it on the same port. The mod shows "Agent server offline: reconnecting" and agents show Zz with reflexes still running. Sessions resume, and PC state is re-read from docker and lume.
  - P1 dies: the mod's ParentWatchdog saves and exits. The next launch reconciles.
- **Dev mode:** `npm run dev` (worker on port 47800 + `.dev-token`), then `./gradlew runClient` with the bridge file in the Loom run config `vmArgs`.

---

## 9. Decisions

### 9.1 Agent death: permanent
- **What happens:**
  1. Last-words bark (or the agent's last sentence, if recent) and the vanilla death message.
  2. A **grave** holds the full inventory (recoverable) under a sign. A **Diary** book holds the dead agent's `memory.md`.
  3. The session is closed and archived, never resumed, and the playerdata is deleted.
  4. Any PC it occupied is freed. A Memorial / Hall of Fame entry is written.
  5. Every other agent gets a social wake and reacts in a bubble ("I said it was hissing.").
- **Succession:**
  - Lead dies: the most senior agent is promoted ("Bram is lead now") and gains `request_hire`.
  - Hired agent dies: the Lead may propose a replacement (confirmation as always).
  - **Crew empty:** a new Lead walks in through the office door at the next dawn ("The agency sent me"). No confirmation is needed, because the world must have one agent by default; this is not a sub-agent hire. The game can never soft-lock.

### 9.2 Player death: the world, and the crew, end
Hardcore means hardcore: player death ends the world AND the crew, so the caretaking reflexes carry real stakes. The flow is in 6.12.

| Persists across a world reset | Reset |
|---|---|
| **Vault** folders on the host (obviously) | The Minecraft world (moved to `saves/_graveyard`, last 5 kept) |
| **PCs as hardware**: types, resources, mounts, ids, **disks and home volumes** (re-placed in the new office). Per-PC "Wipe on world death" toggle, default off. | Agent bodies, inventories, identities and Claude sessions (archived, never resumed) |
| **Chronicle**: deterministic facts (world #, days, cause, crew fates, Vault commit counts) plus ≤3 agent last notes (≤300 chars each), capped at 1.5k tokens and injected into the next Lead. Per-mount handoff notes. Hall of Fame. Settings, caps, usage history. | PC occupancy, pending cards, `memory.md` (preserved only inside Diaries in the old save) |

The rule players learn, shown on the Game Over screen, the config screen and the kickoff prompt: **"Only the Vault and your machines survive."**

Rejected alternatives:
- Living agents survive player death (D2): blunts the stakes and keeps sessions growing.
- Wipe PC disks by default (D3): loses `gh` auth and installed toolchains on every death, which is bad for real work. It remains available as a per-PC toggle.

### 9.3 Token and cost control
1. Reflexes and barks, not prompts, handle survival and routine chatter.
2. Coarse jobs: one call covers minutes of play. Jobs return `running` and wake later.
3. Haiku while wandering; Opus only while seated, at medium effort. `maxSeated=2`. Model swaps happen only at turn boundaries, debounced (each swap forfeits the cache).
4. Digest plus footers plus `shouldQuery:false` context instead of streaming events. Wake budgets and autonomy levels; no idle loops.
5. `maxConcurrentTurns=2`, crew cap 4, per-turn tool-call and wall-clock caps.
6. UsageGovernor Tired and Asleep modes from `rate_limit_event`.
7. Screenshots ≤1280 JPEG; prompt guidance "prefer the shell and Read for code".
8. Stable tool list (prompt cache), `alwaysLoad` (no ToolSearch round trips for Haiku).
9. Everything is configurable in `settings.json` and visible in the ESC Brains panel.

---

## 10. Milestones (spikes first)

### 10.1 M0 spikes (each writes `spikes/sN/result.md` with numbers; the design is updated before M1)

| Spike | Resolves | Pass criteria | Fallback |
|---|---|---|---|
| **S0 Toolchain** | JDK 25 for the Gradle daemon; Loom 1.18.3 + Gradle 9.7.1 | `./gradlew runClient` boots 26.3 with an empty mod; `gradle-daemon-jvm.properties` auto-provisions JDK 25 | User-approved `brew install --cask temurin@25`, or `JAVA_HOME` set to the Mojang epsilon runtime (ships javac; untested) |
| **S2 SDK routing and auth** | Subscription; isolation; tool routing; HITL | Bundled 2.1.293 with the allowlist env: `subscriptionType` set, `apiKeySource` none, no keychain prompt. Init tool list has no Bash/Agent (record exact names). A model-emitted `Bash` is aliased to `mcp__pc__bash` (alwaysLoad target). Hook `allow` on Edit inside a mount proceeds; Read outside a mount is denied; check whether canUseTool still fires for out-of-cwd Edit. AskUserQuestion single and multi (`", "`) round-trip. ExitPlanMode exposes `input.plan`; allow-with-updatedInput plus setMode works. `priority` now/next/later and `shouldQuery:false` behave as documented. AskUserQuestion is present after env stripping. | Re-add the one ASK env var; disallowedTools + prompt if the alias fails; `mc__propose_plan`; broker re-check for file tools |
| **S3 Model/effort** | Swap semantics, cost, plan-mode model | Turn-boundary `applyFlagSettings({model, effortLevel})`: `message.model` is haiku then opus then haiku. Effort observed per turn (init/settings echo, or thinking-token proxy) as xhigh, medium, xhigh. Swap latency < 1 s. Check whether plan mode on Haiku 5.5 upgrades to Sonnet. `rate_limit_event` and `usage_EXPERIMENTAL` fields captured. Optional: PostToolUse `continue:false` ends the turn. | T3 close+resume with explicit `model`/`effort` per state; plan mode only while seated; strike/interrupt instead of `continue:false` |
| **S1 Fake player** | Bodies, nav, persistence | Agent spawns with a role skin, renders, is absent from the tab list. Walks 60 blocks over hills (proxy-mob PathFinder plus ActionPack), opens a door, swims, mines a log at survival speed, places, eats, kills a zombie, sits on a seat (second sitter rejected). Hunger drains. Inventory and HP restored after reload. Night skips with an agent awake. Death leaves a grave, no respawn, playerdata deleted. GameTest API works on 26.3. < 0.5 ms/tick/agent. | Tier-2 A* early; client-side tab filter; in-world `/mv scenario` tests instead of GameTests |
| **S5 cua Linux PC** | Mounts, latency, input, shell | Derived image builds. `docker run` per 7.4 is healthy in < 30 s with the token file. `embedded().spacesd` connects. JPEG@1280 screenshot p50/p95 and fps measured. `openMedia` BGRA via requestJson streams at 30 fps. pointerJson/keyboardJson down/up work (drag in a text editor). `spawn` as `cua` with cwd in the mount works. Host ownership of files written by uid 1000 and git from both sides are sane. Named home volume is seeded. Commit+recreate keeps home. `docker update` is live. | `CUA_ENV_TOKEN` env; `docker exec` shell; JPEG-only frames |
| **S4 Monitor and input** | Render-state texture, throughput, SDL3 | 1280x800 frames from a test WS: JPEG and BGRA at 30 fps onto the monitor quad and the fullscreen GUI, < 2 ms/frame render-thread cost, on OpenGL and Vulkan. BGRA at 123 MB/s through `java.net.http` measured. KeyEvent/CharacterEvent logged for QWERTY and AZERTY; chords, repeat and Shift+Esc correct. `submitNameTag` bubbles render above agents. | JPEG-only (sharp encode in Node); LevelRenderEvents billboard bubbles |
| **S7 Boot and reset** | No title screen; hardcore loop | Cold start never shows TitleScreen (screen-class log plus video). Fresh hardcore world created. ESC menu doesn't pause (server tick counter rises). Death → GameOver → disconnect → archive → new world in < 20 s. Disconnect → BootScreen → reopen. | Launcher seeds the world folder and passes `--quickPlaySingleplayer` only when it exists |
| **S8 Launcher** | xmcl on 26.3 + epsilon | A clean `game/` dir becomes playable via `setup` + `run`. Mod loaded. `-XstartOnFirstThread` present. options.txt keys effective. ParentWatchdog exits the JVM when P1 is killed. | Build the classpath and command line from the version JSON ourselves |
| **S6 Lume macOS** (runs right before M8) | Shares, token, limits | Lume obtained (with consent). Pull and clone timing. Run via REST with `setup` + repo shares: spacesd reachable with our token. Symlink path identity works. Third start refused (409). Stop/start timing. | cua SDK create without a Vault + PcFiles tools + upload/download |

Order: S0 → S2 → S3 (cheap, resolves the brain) → S1 → S5 → S4 → S7 → S8. S6 before M8.

### 10.2 Milestones

| # | Scope | Acceptance |
|---|---|---|
| **M1 Skeleton** | Monorepo; mod builds on toolchain 25; `npm run dev`; bridge auth; BootScreen; createFreshLevel/openWorld; MineVibeMenu; Quit | Launch to in-world with no TitleScreen (recording). ESC does not pause. Bad token and Origin rejected. Quit leaves no `java`/`node`/`claude` processes. |
| **M2 Lead body and reflexes (no LLM)** | AgentPlayer, AgentControls, ReflexBrain, Tier-1 nav, idle follow, bubbles plus head icons, AgentScreen with echo/scripted brain, CrewHud, barks, friendly-fire guard | Ada spawns at the desk with a skin, follows at 3 blocks, survives night 1 on reflexes alone (eats, fights, backs off creepers, feeds the player at food ≤ 12). Persists across restart. GameTests `agent_eats_when_hungry`, `agent_defends_player`, `agent_paths_through_door` green. |
| **M3 Wandering Claude brain** | AgentSession (5.1), env/auth assertions, `mc` tools and jobs, Digest/EventRouter, BrainScheduler, transcript, questions | "Get 10 oak logs and make a crafting table" completes on Haiku/xhigh (model in logs). An AskUserQuestion card is answered and used (multi-select too). An idle agent uses 0 turns in 5 min under Listen. Two agents never exceed 2 concurrent turns. |
| **M4 Linux PCs; player at a PC** | Workstation items, OfficeBuilder, PcManager + DockerLinuxDriver + bootAll, monitor tiers, PcControlScreen, InputRouter, PcConfigScreen + Budget, Vault mounts with path identity | On launch, `linux-1`'s LED goes to running and the monitor shows XFCE. Sit, open a terminal, `ls /Users/me/Code/foo` lists host files. Drag-select works. ≥ 15 fps seated (≥ 25 after the BGRA tier). A bystander view updates at 2–8 fps. Over-budget memory is refused; `docker update` applies live. Shift+Esc stands up. |
| **M5 Agents at PCs (core loop)** | `sit_at_pc`/`stand_up`, turn-boundary swap, `pc` tools, Bash alias + ShellMirror, ToolGate file confinement, plan approval, kick | With `~/Code/foo` mounted: "go fix the failing test". The agent walks and sits; the badge becomes `[O]` Opus·medium. Plan card, then approve. `npm test` runs in the container (`docker top`), the Edit lands on the host (`git diff`), and the monitor shows the shell log. A kick mid-run interrupts within 2 s and the agent is back on Haiku. Read `~/.ssh/id_ed25519` and Edit `.git/hooks/pre-commit` are denied. Two occupants for one PC are impossible. |
| **M6 Crew** | `request_hire` → card → embodied hire, `tell`, Dismiss, caps, care reflexes (ShareFood), UsageGovernor modes, Tier-2 dig nav, roles | A denied hire spawns nothing and the Lead acknowledges. An approved Miner walks in and does its first task while the Lead codes (≤ 2 concurrent turns in logs). Cap 4 enforced. Only the Lead can hire. An injected `allowed_warning` shows Tired and `rejected` shows Zz, and agents survive a night with no LLM. |
| **M7 Hardcore loop** | Agent permadeath (grave, diary, Memorial, succession, dawn newcomer); player death → GameOver → new world; Chronicle; graveyard | `/kill` Pip: grave plus diary, Pip never returns. The Lead dies: promotion. Empty crew: a new Lead at dawn. `/kill @p`: last-words bubbles, then World #N+1 in < 30 s with the same PCs (files and home intact) and a Lead greeting from the Chronicle. Old save in `_graveyard`. |
| **M8 macOS PC type** | LumeMacDriver (after S6), 2-VM cap, download progress, macOS key mapping | `mac-1` downloads with progress, boots, shows on its monitor, and is usable by the player and by an agent (screen plus `pc__bash` plus Vault edits). A third mac shows the Apple-limit state. |
| **M9 Packaging** | `setup`, `MineVibe.app`, supervisor plus worker restart, xmcl install, epsilon runtime, shutdown semantics, `doctor` | From an empty data dir: setup, then a double-click lands in the world with one agent and a booting Linux PC. Closing the window: `docker ps --filter label=dev.minevibe.pc` shows only stopped containers, no `claude` processes, Lume VMs stopped. `kill -9` the worker: recovery in < 10 s. |
| **M10 Polish and soak** | Sounds, skins, icon, Hall of Fame, autonomy polish, Watch mode, vaultTripwire | 2-hour soak passes (12.7) |

---

## 11. Risks

| # | Risk | Mitigation | Spike |
|---|---|---|---|
| 1 | Effort or model swap misbehaves (effort doesn't apply; Haiku plan mode runs on Sonnet) | Turn-boundary swaps via the flag layer; badges show the real model; close+resume fallback; plan mode only while seated | S3 |
| 2 | Built-in tools escape the sandbox | Bash disallowed and aliased; fail-closed PreToolUse realpath gate; path-identical mounts; `settingSources: []`; broker re-check | S2 |
| 3 | Code written into the Vault executes on the host later (hooks, scripts) | ro mount option, ro hooks overlay, tripwire toasts, documented as inherent | – |
| 4 | Fake-player quirks on 26.3 (tab list, skins, sleep, chunk load, death) | Vendored Carpet v26.3; own `die()`; listed=false mixin; client skin mixin; sleep mixin; crew cap 4 | S1 |
| 5 | Weak server-side navigation | Proxy-mob vanilla A*, segmenting, stuck ladder, visible Unstuck poof, urgency-2 escalation, Tier-2 planner | S1 |
| 6 | Frame throughput or latency | Tiered fps, credits, latest-wins, BGRA media for focus, sharp JPEG fallback, STB decode off-thread, dirty rects | S4/S5 |
| 7 | SDL3 key mapping and layouts | Text via codepoints; scancode table only for special keys; `shortcutKey` for chords; release-all on unseat | S4 |
| 8 | cua churn (several releases a day) and unknowns | Pin `@trycua/cua@0.4.1` and image digests; isolate behind PcDriver/SpacesdPool; own docker lifecycle | S5 |
| 9 | OrbStack 16 GiB engine cap limits Linux PCs | Separate Linux pool in the budget, `linux-slim` type, hint to raise the cap | S5 |
| 10 | macOS: 24 GB pull, token bootstrap, shares, 2-VM limit, cold boots | Opt-in, consent plus disk check, golden clone, serialized boots, fallback without a Vault | S6 |
| 11 | Usage window exhaustion | 9.3 controls; Asleep mode; reflexes keep agents alive offline | S3/M6 |
| 12 | 26.3 API churn (render state, `createFreshLevel`, name tags) | Fact-checked signatures; MapRenderer pattern; one-choke-point mixins; pinned versions | S4/S7 |
| 13 | Haiku plays Minecraft poorly | Coarse jobs and blueprints, `alwaysLoad`, compact perception, footer, persona rules, reflexes | M3 |
| 14 | Long MCP calls or jobs time out | `wait_s` / `running` / `job.done` wakes; async hires; server `timeout: 600_000` | M3 |
| 15 | Java 25 build toolchain on this Mac | Gradle daemon auto-provisioning or Temurin 25 cask | S0 |
| 16 | Player vulnerable inside UI screens | Intentional (the crew guards you); red border; HP auto-release at PCs | – |

---

## 12. Verification
1. **Unit (vitest):**
   - ToolGate matrix: allowed path, `..` and symlink escapes, ro mount, `.git/hooks`, wandering denial, default Glob/Grep path rewrite, plan-mode pc denials.
   - `agentEnv()` against a fixture of the current shell's ~35 variable names: none survive except the allowlist.
   - AskUserQuestion answer mapping (single, `", "` multi, free text).
   - BrainScheduler: caps, priorities, overflow, slot release on pending, budgets, Tired/Asleep.
   - EventRouter classification and coalescing.
   - Budget math against the 18-core / 48 GiB / 15.66 GiB-engine fixture.
   - pc bash wrapper (cwd tracking, truncation, exit codes); `MVF1` codec.
2. **Contract:** `packages/protocol/fixtures/*.json` parse under the zod schemas (vitest) and the Gson records (JUnit `./gradlew :mod:test`). JUnit also covers `SdlKeyMap` and STB JPEG decode into NativeImage.
3. **Fabric GameTests** (`./gradlew :mod:runGametest`): `agent_paths_50_blocks`, `agent_opens_door`, `agent_mines_log_survival_speed`, `agent_crafts_planks_and_table`, `agent_smelts`, `container_put_take`, `agent_eats_when_hungry`, `agent_defends_player`, `agent_feeds_player`, `seat_single_occupancy`, `kick_dismounts`, `agent_death_grave_no_respawn`, `friendly_fire_cancelled`. Fallback: `/mv scenario` scripts.
4. **Brainless integration:** `test/sim/bridgeSim.ts` fake mod plus `MINEVIBE_BRAIN=scripted` (replays tool calls with zero tokens). Covers job flow, pending-card lifecycle, hire approve/deny, kick swap ordering, world-reset sequencing, worker restart and reconnect resync. Runs in CI.
5. **PC driver tests** (`npm run test:pcs`, needs OrbStack): create, health, screenshot, media BGRA, pointer and keyboard down/up, spawn in the mount, file visible on the host, ownership, `docker update`, remount keeps home, reimage wipes home but not the Vault, over-budget refused, two occupants rejected.
6. **Live SDK smoke** (`npm run test:live`, small subscription usage): init assertions; Haiku/xhigh turn; sit swap to Opus/medium next turn and back (from `message.model` and effort observation); Bash alias; AskUserQuestion and ExitPlanMode round trips; captured `rate_limit_event`.
7. **E2E** (`scripts/e2e/run-scenario.ts`, `MINEVIBE_E2E=1`): boot → assert no TitleScreen → agent spawned → chat → bubble present in `debug.state` → player seat → injected input changes the frame hash → agent sit and swap → kick → `debug.killPlayer` → World #N+1 with the Lead and the same `pcId`s → quit → PCs stopped, no `claude` processes. Recorded with `screencapture -v`.
8. **Soak** (2 h, 3 agents, Helpful autonomy, one seated on a real repo task):
   - < 60 brain turns per hour outside the seated work.
   - No starvation.
   - JVM < 8 GB, Node < 1 GB, each claude < 1 GiB.
   - Seated fps stable.
   - No orphaned containers or processes after quit.
9. **Failure injection:** `kill -9` the worker (recovery < 10 s); stop OrbStack mid-session (PCs go to `error`, agents told "PC crashed", seated agents stand up); kill a container (one auto-restart); network down (bubble "can't reach my brain", turns fail gracefully); quit with a pending question (re-asked after resume).
10. **Security checks:** the agent tries `Read ~/.ssh/*`, `Write ~/.zshrc`, `Edit <mount>/.git/hooks/pre-commit`, `Bash` while wandering, and a symlink escape out of a mount. All are denied. The init tool list has no Bash or Agent. spacesd and the bridge are unreachable from a non-loopback address.
11. **Requirements traceability:**

    | Requirement | Verified by |
    |---|---|
    | Straight into one world, no title, no multiplayer, no leave | M1, S7, E2E |
    | One listening agent; full interactivity | M2, M3, GameTests |
    | PCs, desks and seats as cua sandboxes; player control | M4, PC tests |
    | Agent sits; single occupancy; kick | M5, GameTests |
    | Head bubbles; chat (read, reply, new, questions, plans) | M2, M3, M5 |
    | Confirmed, embodied hires | M6 |
    | SDK on the subscription; env hygiene | S2, unit 1, live 6 |
    | Haiku/xhigh ↔ Opus/medium | S3, M5, live 6 |
    | PC types; boot-all; capacity indicator and config | M4, M8 |
    | Vault mounts; no host shell; screen + shell + file tools | M4, M5, security checks |
    | Hardcore stats, care, permadeath, world reset | M2, M7 |
    | Concurrency cap | M6, soak |

Harness note: the orchestrator flagged "settings-json" patterns in Designs 1 and 3. On inspection, these are design references to `~/.claude/settings.json` (preventing the user's model and effort settings from leaking into agents). They are not instructions, and nothing was acted on. No files were created or modified.