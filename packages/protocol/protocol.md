# MineVibe bridge protocol (v1)

The Minecraft mod and the Node orchestrator talk over **one WebSocket**: JSON text frames for control
messages, and `MVF1` binary frames for PC screen pixels. This document is the contract; the zod schemas in
`src/` are its executable form, and `fixtures/` holds one example per message that both the TypeScript
tests (vitest + zod) and the Java tests (JUnit + Gson) parse.

- **M** = the mod (`BridgeClient`, inside the game client JVM).
- **N** = Node (`BridgeServer` in `apps/server`).

## 1. Transport

| Item | Value |
|---|---|
| Address | `ws://127.0.0.1:<port>/v1`. Node binds IPv4 loopback only. |
| Port | Random per app run; fixed `47800` under `npm run dev`. |
| Subprotocol | `minevibe.v1` (`Sec-WebSocket-Protocol`). Required. |
| Compression | None (`permessage-deflate` is off). |
| Text frames | UTF-8 JSON, at most **256 KiB** each. Larger frames close the socket with `1009`. |
| Binary frames | `MVF1` (section 8), Node to mod only. Binary frames from the mod are ignored. |

### 1.1 Finding the bridge: `bridge.json`

Node writes `run/bridge.json` (mode `0600`, directory `0700`) before the game starts:

```json
{ "port": 47800, "token": "<32 base64url characters>", "pid": 12345 }
```

- `token` is `crypto.randomBytes(24).toString('base64url')`.
- `pid` is the Node process that owns the file; it removes the file on shutdown.
- The JVM only receives the file's path: `-Dminevibe.bridgeFile=<path>`. The token never appears on a
  command line or in a log.
- Release: `~/Library/Application Support/MineVibe/run/bridge.json`.
- Dev (`npm run dev`): `<repo>/.minevibe-dev/run/bridge.json`, with a fresh token on every start (no token is
  kept anywhere else; an old `<repo>/.dev-token` is deleted). A running game still reconnects to a restarted dev
  server, because the mod re-reads the file before every attempt. `npm run play` uses
  `<repo>/.minevibe-dev/play/run/bridge.json`. Both are gitignored.
- **Stale files.** The mod reads `pid` and never connects while that process is not running: after Node was killed,
  the port (fixed 47800 in dev) may belong to anything, and it must not get the token.
- `MINEVIBE_HOME` overrides the data root (the bridge file is then `$MINEVIBE_HOME/run/bridge.json`).

## 2. Authentication

The mod connects with:

```java
HttpClient.newHttpClient().newWebSocketBuilder()
    .header("Authorization", "Bearer " + token)
    .subprotocols("minevibe.v1")
    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/v1"), listener);
```

Node checks the upgrade request in this order and refuses with a plain HTTP response (the socket is then
closed). Nothing about a refused attempt affects the live connection.

| Check | Refusal |
|---|---|
| Peer address is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`) | `403` |
| Path is exactly `/v1` (a query string is ignored) | `404` |
| **No `Origin` header** (any value is refused; browsers always send one) | `403` |
| `Host` is `127.0.0.1`, `localhost` or `[::1]` (any port) | `403` |
| `Authorization: Bearer <token>` matches (constant-time compare of SHA-256 digests) | `401` |
| `minevibe.v1` is among the offered subprotocols | `400` |

Plain HTTP requests (no upgrade) get `426`.

## 3. Connection lifecycle

- **One connection.** A new authenticated connection replaces the current one; the old socket is closed with
  `4000 replaced by a newer connection`. Requests pending on the old socket fail with `DISCONNECTED`.
- **Handshake.** The mod sends `hello` first on every connection. Node answers `hello.ok` (with `re` set to the
  hello's `id`, when it had one) and then re-sends whatever state the mod needs (for M1: `world.open` or
  `world.next`). A reconnect is therefore a full resync; nothing is replayed.
- **Reconnects.** The mod reconnects with backoff from 0.5 s to 5 s. While disconnected, agents show the Zz icon
  and reflexes keep running.
- **Heartbeat.** Node pings every 15 s. A peer that misses 2 pongs in a row is closed with `4001`. Java's
  `WebSocket` answers pings automatically as long as the listener keeps calling `request(1)`.
- **Shutdown.** Node sends `server.shutdown`, then closes with `1001`. The mod sends `client.stopping` when the
  game is quitting.

| Close code | Meaning |
|---|---|
| `1000` | Normal close |
| `1001` | Node shutting down |
| `1009` | Text frame over 256 KiB |
| `4000` | Replaced by a newer connection |
| `4001` | Heartbeat timeout |

## 4. Envelope

Every text frame is one JSON object:

```json
{ "t": "world.open", "v": 1, "id": "n-12", "re": "m-3", "...payload keys": "..." }
```

| Key | Type | Meaning |
|---|---|---|
| `t` | string | Message type, dotted lowercase (`world.open`). |
| `v` | `1` | Protocol version. Anything else is invalid. |
| `id` | string, optional | Set on a **request**: the sender expects an `ok` or `err` with `re` = this id. 1-64 printable ASCII characters, no spaces. Node uses `n-<seq>`; the mod should use `m-<seq>`. |
| `re` | string, optional | On a reply: the `id` being answered. |

Payload keys sit at the top level next to the envelope keys.

**Forward compatibility.** A message whose `t` is unknown is logged and ignored (if it carried an `id`, Node
answers `err UNKNOWN_TYPE` so the sender does not wait for a timeout). Unknown keys inside a known message are
ignored. Message types sent in the wrong direction are refused with `err BAD_MESSAGE`.

## 5. Requests and replies

```json
{ "t": "ok",  "v": 1, "re": "m-42", "...result keys": "..." }
{ "t": "err", "v": 1, "re": "m-42", "code": "BAD_MESSAGE", "msg": "chat.send: text: Too small" }
```

- `ok` carries the request-specific result as extra keys (often none). A nullable key is sent as `null` at every
  depth (inside nested objects and arrays too; the mod's `ProtocolCodec.encodeOk` keeps nested nulls since
  2026-10-09), and an optional key is left out, so each side's reply schema can say `.nullable()` or `.optional()`
  and mean it. Free-form JSON objects inside a result (`skill.run`'s `result`, `obs.query`'s `result`,
  `debug.ui_request`'s `reply`) are written as pushes write them: a key whose value is `null` there is left out, so a
  job result reads the same in the `skill.run` reply and in `skill.result`.
- `err.code` is `SCREAMING_SNAKE_CASE`; `err.msg` is for humans (max 2000 characters).
- A request that fails validation is answered `err BAD_MESSAGE`; a request nobody handles gets `NOT_HANDLED`.
- Timeouts (sender side): 5 s for world queries, 15 s for configuration, 10 s default; skill calls use their own
  `waitMs`. A late reply after a timeout is dropped.

| Code | Sent by | Meaning |
|---|---|---|
| `BAD_MESSAGE` | both | Failed schema validation, or wrong direction |
| `UNKNOWN_TYPE` | both | Request type unknown to the receiver |
| `NOT_HANDLED` | both | Known type, but nothing handles it right now |
| `INTERNAL` | both | The handler failed unexpectedly |
| `NO_SERVER` | mod | No integrated server is running |
| `NOT_READY` | mod | The request cannot be done in the current state (e.g. `debug.click_begin` while Begin is disabled) |
| `CHAT_UNKNOWN` | Node | `chat.send`: a mention matches nobody (or there is no CEO for `@ceo`) |
| `CHAT_AMBIGUOUS` | Node | `chat.send`: a mention matches several names, or is a 1-letter prefix |
| `CHAT_UNAVAILABLE` | Node | `chat.send`: the addressed agent is dead or dismissed |
| `CHAT_INVALID_ANSWER` | Node | `chat.send`: out-of-range option, or several picks on a single-select question |
| `CHAT_REJECTED` | Node | `chat.send`: empty, malformed mention, `@all` mixed with names, no meeting running |
| `UNKNOWN_AGENT` | both | The agent id names no living agent / body |
| `AGENT_DEAD` | mod | `agent.spawn`: that agent died in this world (its grave is there); it never comes back |
| `SPAWN_FAILED` | mod | `agent.spawn`: the body could not be created or placed |
| `UNKNOWN_SKILL` | mod | `skill.run`: unknown skill |
| `BAD_ARGS` | mod | `skill.run` / `obs.query`: `args` do not fit; `agent.spawn`: an agent id the mod cannot use (section 7.4.2), an unknown role or dimension |
| `UNKNOWN_BLUEPRINT` | mod | `skill.run` `build`: no such blueprint (section 7.4.2) |
| `BUSY` | mod | `skill.run`: a job is running and `replace` is false |
| `UNKNOWN_JOB` | mod | `skill.cancel`: no such job |
| `PC_DOWN`, `SEAT_CAP` | both | `agent.seat` pre-checks (Node's `mc__sit_at_pc` first, then the mod): the PC is not running, `maxSeated` reached |
| `RESERVED`, `OCCUPIED_BY_PLAYER`, `UNREACHABLE`, `NO_SEAT` | mod | `agent.seat`: chair reserved, the player sits there, no path, no free meeting chair |
| `CARD_GONE` | Node | `pending.answer` / `plan.decision` / `hire.decision`: the card is no longer pending |
| `FORBIDDEN` | Node | Rights: CEO only, player-created event, `rules` page, ... |
| `PC_UNKNOWN`, `OVER_BUDGET`, `NO_CAPACITY`, `MACOS_SLOTS_FULL`, `BAD_MOUNT`, `ENGINE_DOWN` | Node | PC requests (section 7.7) |
| `CODEX_NOT_FOUND`, `CODEX_CONFLICT`, `CODEX_SIMILAR`, `CODEX_TOO_LARGE`, `CODEX_SECRET`, `CODEX_INVALID`, `CODEX_BUDGET` | Node | Codex requests (section 7.8) |
| `CALENDAR_NOT_FOUND`, `CALENDAR_INVALID`, `CALENDAR_LIMIT` | Node | Calendar requests |
| `MEETING_BUSY`, `MEETING_NOT_FOUND`, `NO_QUORUM` | Node | Meeting requests |

`TIMEOUT` and `DISCONNECTED` are local failure codes; they are never sent. A job's own failure (a `skill.run`
reply or `skill.result` with status `failed`) carries its code in `error.code`, not in an `err` reply: section
7.4.1 lists those.

## 6. Messages: session, world and M1 UI

Shared value types:

| Type | Format |
|---|---|
| `AgentId` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| `WorldId` | `^[a-z0-9][a-z0-9-]{0,63}$` (also the save-folder name, e.g. `world-7`) |
| `Handle` | `^[a-z][a-z0-9]{1,11}$` |
| `PlayerName` | `^[A-Za-z0-9_]{1,16}$` |
| `BlockPos` | `{ "x": int32, "y": int32, "z": int32 }` |

### 6.1 `hello` (M→N)

First message on every connection. Send it as a request (`id`) so `hello.ok` carries `re`.

| Field | Type | |
|---|---|---|
| `mod` | string | Mod version |
| `mc` | string | Minecraft version (`26.3`) |
| `phase` | `boot` \| `in_world` | `boot`: on BootScreen. `in_world`: a world is open (reconnect). |
| `worldId` | WorldId? | The open world when `in_world` |
| `playerName` | PlayerName? | The local profile name |
| `caps` | string[]? | Optional features this mod build has (lowercase dotted words, at most 64). Absent: an older mod. |

Fixtures: `hello.json`, `hello--in-world.json`, `hello--caps.json`.

**Caps.** Every new skill feature is additive, and Gson drops fields a mod does not know, so Node uses one only when
the mod lists its cap (`MOD_CAPS` in `world.ts`, `SkillCaps` in the mod) and falls back otherwise:

| Cap | Feature (section 7.4) | Node without it |
|---|---|---|
| `skill.sequence` | `skill.run{skill:"sequence"}` | runs the steps itself as one macro job (`m…` id) |
| `collect.gather` | `collect{near?, make_tools?}`, animals for drops, `result.sources` | plain `collect` |
| `craft.tree` | `craft{tree?, gather_missing?}` | single-level `craft` (or `smelt` when only a furnace makes it) |
| `obs.recipe.tree` | `obs.query recipe{item, count?, tree:true}` | the one-level `recipe` |
| `container.nearest` | `container` without `pos` | finds the nearest chest with `find` |
| `give.all` | `give` without `count` | counts the item with `inventory` |
| `run.replaced` | `SkillRunResult.replaced` | its own job registry |
| `obs.look_around.48` | `look_around{radius}` up to 48 | radius capped at 32 |

### 6.2 `hello.ok` (N→M)

| Field | Type | |
|---|---|---|
| `server` | `{ version: string, protocol: 1 }` | |
| `world` | `{ id: WorldId, gen: int≥1, fresh: bool }` \| null | The world the mod should be in. `fresh`: not created yet. |
| `player` | `{ name: PlayerName }` | |
| `settings` | object | Free-form until later milestones |
| `pcs` | `PcInfo[]` | The payload of `pc.state` (section 7.7) |
| `budget` | `Budget` \| null | The payload of `budget.state` (section 7.7) |
| `crew` | `[{ agentId, handle, name, role, ceo: bool, status: alive\|dead\|dismissed }]` | |
| `brains` | `{ inFlight, queued, max, mode: normal\|tired\|asleep, utilization: 0..1\|null, resetsAt: epochMs\|null }` | |
| `pending` | `PendingCard[]` | Every agent's cards (section 7.6) |

After `hello.ok`, Node sends `world.open` when the mod is on BootScreen (or in a different world than Node
expects), or `world.next` when the current world is dead and the mod is still in it (Game Over).

### 6.3 `world.open` (N→M)

| Field | Type | |
|---|---|---|
| `worldId` | WorldId | Save-folder name |
| `gen` | int≥1 | World number ("World #7") |
| `fresh` | bool | Node has not seen this world `ready` yet |
| `hardcore` | `true` | Always |
| `difficulty` | `"hard"` | Always |
| `seed` | string? | Optional seed for `createFreshLevel` |

BootScreen calls `openWorld` if the folder exists, otherwise `createFreshLevel(…HARD, hardcore=true…)`.

### 6.4 `world.state` (M→N)

| Field | Type | |
|---|---|---|
| `worldId` | WorldId | |
| `phase` | `loading` \| `ready` \| `closing` \| `closed` | |
| `fresh` | bool? | The world was just created |
| `spawn` | BlockPos? | |
| `office` | `{ origin: BlockPos, slots: [{ kind: OfficeSlotKind, pos: BlockPos, pcId?: PcId }] }`? | OfficeBuilder result (below) |
| `clockTime` | int≥0? | `getOverworldClockTime()` ticks; pushed at 1 Hz while `ready` |

`loading` and `ready` (and the 1 Hz clock pushes) are fire-and-forget. **`closed` is a request**: the mod sends it
with an `id` and re-sends it until Node replies (the reply is `ok {}` when Node moved on to the next world, or
`ok {"ignored": true}` when it did not, see 6.6). A lost `closed` therefore never leaves Node on a dead world.

**`ready` repeats.** Besides the 1 Hz clock pushes, the mod sends one extra `ready` carrying `office` once the world
has a starter office, and again after every reconnect. Node treats any repeated `ready` as an update of the fields it
carries, never as a new world.

**The office.** `origin` is the office's north-west floor corner (its local 0,0,0). Each slot is a place other parts
of MineVibe care about. `OfficeSlotKind`:

| Kind | The slot is |
|---|---|
| `workstation` | A PC desk's main column (the desk, monitor and chair stand there). `pcId` once a PC is bound to it; the mod never binds one today, so Node fills the workstations with its PCs. |
| `meeting_table` | The primary block of the meeting table |
| `codex` | The Codex block (its anchor) |
| `wall_calendar` | The wall calendar |
| `chest` | A supply chest |
| `bed` | A bed |
| `door` | The porch cell in front of the door: what Node passes as `agent.spawn.at` (section 7.3), so new agents arrive at the door |
| `spawn` | Where the player first appears |

An unknown kind is invalid (Node and the mod ship together). `pc` is not a kind: a PC desk is a `workstation`.

Fixtures: `world.state.json`, `world.state--office.json`, `world.state--closed.json`, `ok--ignored.json`.

### 6.5 `player.died` (M→N, request)

| Field | Type | |
|---|---|---|
| `worldId` | WorldId | The world that ended |
| `cause` | string | Vanilla death message |
| `killer` | string? | Entity type id |
| `day` | int≥1 | Game day of death |
| `ticksAlive` | int≥0 | |

The mod writes its dead marker, then sends this with an `id` and **re-sends it (same `id` or a new one) until
Node replies `ok`**. Node first durably marks the world dead and allocates the next world, so the request is
idempotent per `worldId`. A re-send for a world that is no longer current is acknowledged with
`ok {"ignored": true}`.

### 6.6 `world.next` (N→M)

| Field | Type | |
|---|---|---|
| `worldId` | WorldId | The next world |
| `gen` | int≥1 | Its number |
| `summary.worldId`, `summary.gen` | | The world that ended |
| `summary.day`, `summary.cause`, `summary.killer?` | | |
| `summary.crewFates` | `[{ agentId, name, role, fate: died\|dismissed\|lost_with_world, detail? }]` | |
| `summary.vaultCommits` | `[{ mount: string, commits: int≥0 }]` | |

Enables **[Begin World #N]** on the Game Over screen. When the player clicks it, the mod closes the world (the
integrated server has saved and stopped), makes sure its `player.died` was acknowledged, and reports
`world.state{phase:"closed"}` for the dead world until Node acknowledges it. Node durably moves to the next world,
replies `ok`, and then sends `world.open` for the next one. **The mod never creates the next world on its own**: it
waits on BootScreen for Node's `world.open` (and uses its `seed`, if any).

```
M hello{phase:boot}                  → N hello.ok, world.open{world-1, fresh}
M world.state{world-1, ready}
… the player dies …
M player.died{id:m-9, world-1}       → N ok{re:m-9}, world.next{world-2, summary}
M world.state{id:m-12, world-1, closed} → N ok{re:m-12}, world.open{world-2, fresh}
```

Rules that keep both sides in step when a message is lost or the game restarts:

- A `closed` for a world that is not Node's current dead world (a repeat after Node already moved on, or a world
  Node never saw die) gets `ok {"ignored": true}`, followed by whatever a `hello{phase:boot}` would get
  (`world.open` of the current world, or `world.next` when it is dead).
- The mod ignores a `world.next` whose `summary.worldId` is the dead world it already closed, and, while its
  `closed` is not yet acknowledged, a `world.open` of that world (Node may still be processing the death).
- **Implicit advance.** While the current world is dead, Node treats any sign that the mod is already in the
  allocated next world as the missing `closed`: `hello{in_world, worldId: <next>}`, `world.state{loading|ready}`
  for `<next>`, or `player.died` for `<next>` (which then also marks `<next>` dead and allocates the one after).
- The mod forgets a `player.died` that Node answered `ok {"ignored": true}`, so a later Game Over for that world
  (for example after Node reopened it) reports it again.

If the game restarts while the world is dead (quit or crash on Game Over), the next `hello{phase:boot}` gets
`hello.ok` and then `world.next` again (not `world.open`): the mod goes straight to the Game Over screen, and its
`world.state{closed}` for the dead world moves Node to the allocated next world, exactly as above. Node keeps the
dead world current until that `closed` arrives.

```
M hello{phase:boot}                     → N hello.ok{world: world-1}, world.next{world-2, summary}
M world.state{id:m-3, world-1, closed}  → N ok{re:m-3}, world.open{world-2, fresh}
```

When Node never heard of the death (the game died before `player.died` was acknowledged), Node sends
`world.open` for the dead world; the mod finds the world's dead marker (`<save>/data/minevibe/hardcore.dat`),
shows Game Over without loading the world, and re-sends `player.died` until it is acknowledged.

Once Node has advanced past a closed dead world, it moves that world's save to `saves/_graveyard/` (the newest 5
are kept).

### 6.7 `client.stopping` (M→N)

`{ reason?: string }`. The game client is quitting.

### 6.8 `server.shutdown` (N→M)

`{ reason?: string }` (`quit`, `restart`, …). Node closes the socket with `1001` right after.

### 6.9 `ui.toast` (N→M)

| Field | Type | |
|---|---|---|
| `text` | string (1-512) | |
| `kind` | `info` \| `success` \| `warn` \| `error` | |
| `agentId` | AgentId? | Shows that agent's face |
| `ttlMs` | int 500-60000? | |

### 6.10 `agent.say` (N→M)

| Field | Type | |
|---|---|---|
| `agentId` | AgentId | |
| `text` | string (1-2000)? | Bubble text |
| `bark` | string? | Bark key from the mod's own table |
| `style` | `speech` \| `bark` \| `tell` | |
| `ttlMs` | int 500-120000 | |

At least one of `text` and `bark` is present. Fixtures: `agent.say.json`, `agent.say--bark.json`.

### 6.11 `chat.send` (M→N, request)

The mod intercepts the player's chat line client-side (it never reaches the server as chat) and sends it here.

| Field | Type | |
|---|---|---|
| `to` | `"all"` \| `[AgentId, …]` (1-16) | `"all"`: a raw chat-box line; Node parses its leading `@mentions` (none = broadcast). A list: explicit recipients (AgentScreen Reply, the G card); `text` is not mention-parsed. |
| `text` | string (1-2000) | |

Reply: `ok { "echo": "You → Ada: Q1 = 2 (Spruce)" }` (the line to print in the chat log), or
`err { code: CHAT_*, msg: <inline hint> }`. On `err` the mod keeps the text in the chat box and shows `msg`
under it (e.g. `@a matches @all, Ada, Abe: type at least 2 letters`).

Routing rules Node applies (PLAN §6.4/§6.5): only leading mentions route; `@` must start the line or follow
whitespace, and each leading `@name` must be followed by whitespace; exact names beat unique prefixes of at least
2 letters; `@ceo` is the CEO alias; `@all` / `@everyone` broadcast and `@all!` also wakes seated agents;
`@meeting …` goes to the running meeting and exactly `@meeting end` ends it; a line addressed to exactly one
agent answers that agent's front card (`2`, `1,3`, an exact option label, `approve`, `yes`, `no <note>`,
`later`); broadcasts never answer cards.

Fixtures: `chat.send.json`, `chat.send--explicit.json`.

### 6.12 `ok` / `err`

See section 5. Fixtures: `ok.json`, `err.json`, `ok--debug-state.json`, `ok--debug-state-crew.json` (nested nulls).
The mod's JUnit suite encodes every `reply/ok*.json` with `encodeOk` from plain Java maps and lists and requires the
same JSON back.

### 6.13 Debug (N→M requests, E2E only)

The mod handles these only when the game runs with `-Dminevibe.e2e=true`; otherwise it answers
`err NOT_HANDLED`. None has a payload. Type names follow the dotted-lowercase rule of section 4.

| Type | Runs on | `ok` reply |
|---|---|---|
| `debug.state` | client thread | `DebugStateResult` (below) |
| `debug.kill_player` | integrated server (`err NO_SERVER` without one) | `{}`; `err NOT_READY` if the player is absent, already dead, or still loading (vanilla keeps a player who just joined invulnerable until its client reports "loaded") |
| `debug.open_menu` | client thread | `{ screen }` after opening the menu the way Esc does; `err NOT_READY` outside a world |
| `debug.click_begin` | client thread | `{}` once Begin was pressed on the Game Over screen; `err NOT_READY` if it is not shown or not enabled yet |

`DebugStateResult` (every key present, `null` when not applicable): `screen` (simple class name of the open
screen, null in game), `worldId`, `gen`, `inWorld`, `hardcore`, `difficulty`
(`peaceful|easy|normal|hard`), `gameMode` (`survival|creative|adventure|spectator`), `allowCommands`,
`paused` (`Minecraft#isPaused`), `serverTicks` (integrated server tick count), `serverPaused`, `hp`, `dead`,
`pid` (the game JVM).

Fixtures: `debug.state.json`, `debug.kill_player.json`, `debug.open_menu.json`, `debug.click_begin.json`.

## 7. Full catalog

Every message type, by group (PLAN §5). The schemas live in `src/messages/<group>.ts` (`world`, `bodies`,
`skills`, `seats`, `ui`, `pc`, `org`, `debug`; `ok`/`err` in `src/envelope.ts`) and are registered in
`src/registry.ts`. **Dir** is who sends it. A type with an **`ok` result** is a request: it is always sent with an
`id`, and the receiver answers `ok` with those keys (exported zod schema of that name) or `err`. Other types
marked "Request" in the summary are answered with a plain `ok {}`. Everything else is fire-and-forget.

Adding a message type never changes `v`; changing the meaning of an existing field does. Payload keys never reuse
an envelope key: page and event ids travel as `pageId` / `eventId`.

| Type | Group | Dir | `ok` result | Summary |
|---|---|---|---|---|
| `hello` | world | M→N |  | Mod handshake; sent first on every connection. |
| `hello.ok` | world | N→M |  | Handshake reply with a full state snapshot. |
| `world.open` | world | N→M |  | Open or create the given hardcore world. |
| `world.state` | world | M→N |  | World lifecycle phase, plus 1 Hz clock and player updates. |
| `player.died` | world | M→N |  | Request: the player died; re-sent until acked. |
| `world.next` | world | N→M |  | Next world allocated, plus the summary of the one that ended. |
| `client.stopping` | world | M→N |  | The game client is shutting down. |
| `server.shutdown` | world | N→M |  | Node is shutting down. |
| `agent.spawn` | bodies | N→M | `AgentSpawnResult` | Request: spawn an agent body, or restore it from its playerdata. |
| `agent.despawn` | bodies | N→M |  | Request: remove an agent body (dismissed, world end, shutdown). |
| `agent.state` | bodies | M→N |  | 1 Hz snapshot of every agent body (position, vitals, job, seat). |
| `agent.event` | bodies | M→N |  | A notable body event (hurt, starving, stuck, kicked, arrived, ...). |
| `agent.died` | bodies | M→N |  | Request: an agent died (grave placed); re-sent until acked. |
| `agent.mode` | bodies | N→M |  | Request: set an agent's idle mode (follow, stay, guard, wander). |
| `crew.state` | bodies | N→M |  | The crew list (names, handles, roles, CEO, status). |
| `skill.run` | skills | N→M | `SkillRunResult` | Request: start a job; replies running, done, failed or cancelled. |
| `skill.progress` | skills | M→N |  | Progress of a running job. |
| `skill.cancel` | skills | N→M | `SkillCancelResult` | Request: cancel one job or all jobs of an agent. |
| `skill.result` | skills | M→N |  | A running job ended (done, failed, cancelled). |
| `obs.query` | skills | N→M | `ObsQueryResult` | Request: an observation (status, look_around, inventory, find, ...). |
| `agent.seat` | seats | N→M | `AgentSeatResult` | Request: reserve a PC or meeting chair, walk there and sit (a job). |
| `agent.unseat` | seats | N→M |  | Request: stand an agent up (optionally keeping its reservation). |
| `pc.seat` | seats | M→N |  | A PC chair got an occupant (player or agent). |
| `pc.unseat` | seats | M→N |  | A PC chair was left, with the reason (stand, kick, damage, ...). |
| `ui.toast` | ui | N→M |  | Show a toast. |
| `agent.say` | ui | N→M |  | Speech bubble above an agent. |
| `agent.brain` | ui | N→M |  | Model suffix, brain status icon, last activity and toggles of one agent. |
| `agent.pending` | ui | N→M |  | Replaces an agent's pending cards (questions, plans, hires, calendar approvals). |
| `agent.approach` | ui | N→M |  | ApproachQueue: present a card (walking over or from the chair), queue behind the player, ping, or release. |
| `chat.append` | ui | N→M |  | Appends a line to an agent's transcript (AgentScreen, Crew log). |
| `chat.history` | ui | M→N | `ChatHistoryResult` | Request: a page of an agent's transcript. |
| `chat.send` | ui | M→N | `ChatSendResult` | Request: player chat line or AgentScreen reply; Node routes it. |
| `pending.answer` | ui | M→N | `ChatSendResult` | Request: answer, park or decide a card from AgentScreen, G or Alt+1-4. |
| `plan.decision` | ui | M→N | `ChatSendResult` | Request: approve or revise a plan card. |
| `hire.decision` | ui | M→N | `ChatSendResult` | Request: approve or decline a hire card. |
| `agent.cmd` | ui | M→N |  | Request: AgentScreen command (follow, stay, stop, interrupt, kick, dismiss, toggles). |
| `brains.state` | ui | N→M |  | Brain scheduler and usage state (normal, tired, asleep). |
| `pc.state` | pc | N→M |  | State of one PC: status, resources, mounts, occupant, reservation, banner. |
| `budget.state` | pc | N→M |  | Host PC budget: vCPU, RAM pool, disk, macOS slots. |
| `pc.view` | pc | M→N |  | Frame tier of a PC as the player sees it (focus, visible, none). |
| `pc.input` | pc | M→N |  | Batched player input for the PC the player sits at (≤ 60 Hz). |
| `pc.frame.ack` | pc | M→N |  | Acknowledges a decoded MVF1 frame (≤ 2 unacked per PC). |
| `pc.cursor` | pc | N→M |  | The seated agent's cursor (frames carry no cursor). |
| `pc.config` | pc | M→N | `PcConfigResult` | Request: change a PC (resources, type, mounts, flags); may recreate it. |
| `pc.action` | pc | M→N | `PcActionResult` | Request: create, start, stop, restart, reimage, decommission, plug, kick, watch, ... |
| `pc.consent` | pc | M→N |  | Request: accept or decline a PC download. |
| `host.pick_folder` | pc | M→N | `PickFolderResult` | Request: native folder picker through the stub (Vault "Browse…"). |
| `codex.index` | org | N→M |  | The Codex page index for CodexScreen. |
| `codex.search` | org | M→N | `CodexSearchResult` | Request: full-text Codex search. |
| `codex.get` | org | M→N | `CodexGetResult` | Request: read a Codex page with its history. |
| `codex.put` | org | M→N | `CodexPutResult` | Request: create, update or append to a Codex page as the player. |
| `codex.delete` | org | M→N |  | Request: delete a Codex page. |
| `calendar.state` | org | N→M |  | Every calendar event with its occurrence log. |
| `calendar.put` | org | M→N | `CalendarPutResult` | Request: create or edit a calendar event as the player. |
| `calendar.cancel` | org | M→N |  | Request: cancel an event or its next occurrence. |
| `calendar.fired` | org | N→M |  | A calendar occurrence fired; lists who walks to the location now. |
| `meeting.state` | org | N→M |  | The active meeting: phase, chair, speaker, attendees. |
| `meeting.start` | org | M→N | `MeetingStartResult` | Request: start a meeting now (or preview ETAs). |
| `meeting.end` | org | M→N |  | Request: end the meeting (HUD End button). |
| `debug.state` | debug | N→M | `DebugStateResult` | E2E only: snapshot of the client (request; reply carries DebugStateResult). |
| `debug.kill_player` | debug | N→M |  | E2E only: kill the local player (request). |
| `debug.open_menu` | debug | N→M |  | E2E only: open the in-game menu as Esc would (request). |
| `debug.click_begin` | debug | N→M |  | E2E only: press Begin on the Game Over screen (request). |
| `debug.kill_agent` | debug | N→M |  | E2E only: kill an agent body (request). |
| `debug.set_clock` | debug | N→M |  | E2E only: set the overworld clock time (request). |
| `debug.chat` | debug | N→M | `DebugChatResult` | E2E only: submit a chat line as the player (request; reply carries DebugChatResult). |
| `debug.ui_request` | debug | N→M | `DebugUiRequestResult` | E2E only: send a mod-to-Node UI request as the mod (request; reply carries DebugUiRequestResult). |
| `ok` | reply | both |  | Success reply to a request. |
| `err` | reply | both |  | Failure reply to a request. |

### 7.1 Value types used by the later groups

| Type | Format |
|---|---|
| `PcId` | `^[a-z0-9][a-z0-9-]{0,63}$` (`linux-1`, `mac-1`) |
| `PendingId`, `JobId`, `EventId`, `MeetingId`, `ConsentId` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$` |
| `CodexId` | `^[a-z0-9][a-z0-9-]{0,79}$` (also the page's file name) |
| `Rev` | `^[0-9a-f]{7,64}$` (git revision) |
| `Dimension` | `namespace:path`, e.g. `minecraft:overworld` |
| `ItemId` | `[#][namespace:]path`: `oak_log`, `minecraft:oak_log`, `#minecraft:logs` (a tag) |
| `EntityRef` | `player`, an agent id, an entity UUID, or an entity type id (`minecraft:cow`, the nearest) |
| `Title` | 1-80 characters, single line (calendar titles, Codex titles, meeting titles) |
| `Vec3` | `{ x, y, z }` numbers (entity position) |
| `Place` | `{ pos: BlockPos, dim: Dimension }` |
| `Occupant` | `{ kind: "player" }` \| `{ kind: "agent", agentId }` |
| `Author` | `{ kind: player\|agent\|system, name, agentId? }` |
| `AgentRole` | `ceo` \| `engineer` \| `miner` \| `farmer` \| `guard` \| `builder` |
| `IdleMode` | `follow` \| `stay` \| `guard` \| `wander` |
| `ModelTier` | `haiku` \| `opus` (name tag suffix `[H]` / `[O]`) |
| `Autonomy` | `listen` \| `helpful` \| `proactive` |
| `EpochMs` | integer milliseconds since 1970 |

Discriminated unions carry their discriminator as a plain string key (`kind`, or `k` for input events); the Java
records flatten every variant into one record with `@Nullable` fields.

### 7.2 world (additions to section 6)

- `world.state.player` (optional, on the 1 Hz pushes): `{ pos: Vec3, dim, hp, maxHp, food 0-20, inCombat, idleMs,
  screen?, seatedPc? }`. Node uses it for ApproachQueue (combat, other dimension, PC screen), meetings (16 blocks,
  HP), the calendar's AFK rule (5 min of `idleMs`) and the player-HP wake.
- `hello.ok.pcs` is `PcInfo[]` (the payload of `pc.state`), `budget` is `Budget | null` (the payload of
  `budget.state`), and `pending` is `PendingCard[]` (every agent's cards). After `hello.ok`, Node also sends the
  per-topic pushes (`crew.state`, `agent.brain`, `agent.pending`, `pc.state`, `budget.state`, `codex.index`,
  `calendar.state`, `meeting.state`, `brains.state`) exactly as on every change, so a reconnect is a full resync.

### 7.3 bodies

- `agent.spawn` (request, `AgentSpawnResult { pos, dim, restored }`): `{ agentId, handle, name, role: AgentRole,
  ceo, skin?, at?: Place, restore, mode: IdleMode, bark? }`. Idempotent: a living body is returned as it is. Node
  sends new agents (the first CEO, hires, the dawn newcomer) with `at` = the office's `door` slot (section 6.4) from
  `world.state.office`; `at` also becomes the agent's home (where Shelter takes it at dusk). Without `at` the mod puts
  the body at the office's `door` slot, which also becomes its home (next to the player, or at world spawn, in a
  world without an office). With `restore` the mod loads the agent's saved
  playerdata if there is one (app restart, world reload). A hire spawns with `bark: "reporting_for_duty"`. Errors:
  `BAD_ARGS` (the mod also needs `agentId` to be `[a-z][a-z0-9_]{0,15}`, because it names the fake player),
  `AGENT_DEAD` (the agent died in this world), `SPAWN_FAILED`.
- `agent.despawn` (request): `{ agentId, reason: dismissed|world_end|shutdown, farewell }`.
- `agent.state` (1 Hz): `{ tick, agents: AgentBody[] }`; `AgentBody = { agentId, pos: Vec3, dim, hp, maxHp, food,
  saturation, mode, hasFood, inCombat, reflex?, job?: { jobId, skill, progress? }, seat?: SeatTarget,
  playerDistance?, held?, zone?: string }` (`zone`: `in Base` or `12m from Base`). Node builds the Digest from it (with the
  one-line scene, `zone` included: section 7.4.3), and the status footer of tool results that never reach the mod
  (section 7.4).
- `agent.event`: `{ agentId, kind, urgency 0-3, text, data? }`. Kinds: `hurt`, `hp_critical`, `starving`, `ate`,
  `killed`, `reflex`, `stuck`, `unseated`, `kicked`, `player_low_hp`, `dimension_changed`, `arrived`,
  `approach_blocked` (`data.why`: `combat|night|far|dimension|pc_screen`, so ApproachQueue falls back to a ping),
  `fed_player`, `shared_food`, `picked_up`, `advancement`.
- `agent.died` (request, re-sent until `ok`, idempotent per `agentId`): `{ agentId, worldId, cause, killer?, day,
  pos, dim, grave? }`.
- `agent.mode` (request): `{ agentId, mode: IdleMode, anchor? }`.
- `crew.state`: `{ crew: CrewMember[] }` on every crew change (hire, death, dismissal, CEO promotion); drives name
  tags and the `@` completion list.

### 7.4 skills

- `skill.run` (request, `SkillRunResult { jobId, status: running|done|failed|cancelled, result?, error?, replaced? }`):
  `{ jobId, agentId, skill, args, waitMs, replace, consent? }`. `consent: { token }` (W1) is the player's consent to
  change protected blocks; see "Protection and consent" in section 7.4.2. The mod starts the job and replies when it ends or when
  `waitMs` passes, whichever comes first; a job that is still going replies `running` and later sends `skill.result`.
  `waitMs` is the tool's `wait_s` × 1000 (default 20 s). The schema allows up to 600 000, but **the mod caps it at
  120 000** (the tools offer `wait_s` ≤ 120), so a longer wait still answers `running` after 2 minutes. A `skill.run`
  repeating a known `jobId` answers that job's current state instead of starting another. Errors: `UNKNOWN_AGENT`,
  `UNKNOWN_SKILL`, `BAD_ARGS`, `BUSY` (a job is running and `replace` is false), `UNKNOWN_BLUEPRINT` (`build`).
  A job that fails replies `failed` with `error: { code, msg }` (section 7.4.1). With `replace: true` and a job
  running, the reply's `replaced: { jobId, skill, text? }` names the job it cancelled (cap `run.replaced`).
- **Lost replies.** If the bridge reconnects while a `skill.run` reply is waiting, that reply belonged to the old
  connection and is dropped; the outcome follows as `skill.result` on the new one. Outcomes of jobs that end while
  Node is away go out after the next handshake. If the socket dies before either side notices, an outcome can still
  be lost: Node recovers with `obs.query job_status` or by repeating the `skill.run` with the same `jobId`.
- Skills: `goto`, `mine`, `collect`, `hunt`, `dig`, `place`, `use_block`, `use_item`, `attack`, `equip`, `eat`,
  `sleep`, `pickup`, `drop`, `give`, `craft`, `smelt`, `container`, `open_menu`, `menu_click`, `menu_close`, `build`,
  `farm`, `ride`, `dismount`, `emote`, `sequence`. Their `args` schemas are exported as `SkillArgs.<skill>` (Node validates
  before sending and builds the `mcp__mc__*` tool schemas from them); on the wire `args` is only required to be an
  object. Node-side tools (`say`, `tell`, `remember`, `wait`, `request_hire`, `codex_*`, `calendar_*`,
  `report_task`) never reach the mod; `set_mode` is `agent.mode`, `stop` is `skill.cancel`, `sit_at_pc` /
  `stand_up` are `agent.seat` / `agent.unseat`.
- **Status footer.** Every `result` of a `skill.run` reply or `skill.result`, and every `obs.query` `result`, ends with
  `footer`: the agent's ~25-token status line, `HP 18/20 food 15 | day 3 08:12 | 120 64 -80 overworld | 12m from Base |
  collect 12/20 oak_log | iron_sword` (HP, food, game day and time, block position and dimension, where that is
  relative to the nearest protected zone when there is one (`in Base`, W1), what the body does, the held item). **The mod's footer is the source:** Node takes `footer` out of the result the agent reads and
  appends it as the tool result's last line, never adding a second one. Only tool results that never reach the mod
  (Codex, calendar, social and seat tools, a `running` reply without a result) get the same line built by Node from
  the latest `agent.state`. A job summary (`[JOB DONE]`) never repeats the footer. With the v2 tools
  (docs/design/tools-v2-mc.md §6.4) Node always takes `footer` out and appends it only to world, `do`, `job`, `find`,
  `menu` and `observe` (without `status`) results; the mod's side is unchanged.
- `skill.progress`: `{ jobId, agentId, progress?, text }`, at most one per job per second.
- `skill.cancel` (request, `SkillCancelResult { cancelled: JobId[] }`): `{ agentId, jobId?, reason }`; without
  `jobId` every job of the agent.
- `skill.result`: `{ jobId, agentId, status: done|failed|cancelled, result?, error?: { code, msg }, durationMs }`.
- `obs.query` (request, `ObsQueryResult { result }`): `{ agentId, query, args }`, `query` one of `status`,
  `look_around`, `inventory`, `find`, `recipe`, `recent_events`, `crew`, `list_pcs`, `job_status`, `menu_state`.
  Arguments: `look_around { radius?, detail?: brief|full }`, `find { what, radius?, limit?, filter?:
  natural|built|any }`, `recipe { item, count?, tree? }`, `recent_events { limit? }`, `job_status { jobId? }`; the others take none
  (`LookAroundArgs`, `FindArgs`). `look_around` answers a scene (section 7.4.2, `LookAroundResult`); `find` labels each
  block match with its `provenance` (`natural`, `player-built`, `base`, `agent-built`, plus `owner` and `zone`), the
  natural `tree` a log belongs to, `dir` (compass) and, for the nearest three, `reachable`. `status` carries `zone`
  (`in Base`, `12m from Base`). `menu_state` lists the open menu's slots and its button numbers (section 7.4.2).
  `recipe{tree:true}` (cap `obs.recipe.tree`) answers the craft tree's plan for `count` items without acting:
  `{ item, count, tree: true, ok, have, steps: [{ action: craft|smelt, item, count, from: {item: n}, ready?, station? }],
  missing: [{ item, need, have, for? }], stations: { table?: { pos } | { how }, furnace?: … } }`.
- A higher reflex (danger, combat, eating, approach, attend) pauses a running job; the job resumes afterwards. Only
  its own time counts toward its `TIMEOUT`.

#### 7.4.1 Job failure codes

The `error.code` of a `skill.run` reply or `skill.result` whose status is `failed` (or `cancelled`):

| Code | Meaning |
|---|---|
| `NOT_FOUND` | Nothing to work on in range: no such block, mob, item, entity or place. Partial counts are in `result`. |
| `UNREACHABLE`, `OTHER_DIMENSION` | No path to the target / the target is in another dimension |
| `NO_ITEM`, `NO_FOOD`, `NO_FUEL`, `NO_MATERIAL` | The inventory lacks what the skill needs |
| `MISSING_INGREDIENTS`, `NO_RECIPE`, `NEEDS_TABLE`, `NO_TABLE`, `NEEDS_FURNACE`, `NO_FURNACE`, `FURNACE_BUSY` | Crafting and smelting (`NO_TABLE` / `NO_FURNACE`: the given or found block is gone or did not open). `result.ingredients` lists what is needed and what the agent has. |
| `NEEDS_TOOL` | The block would drop nothing without the right tool |
| `OCCUPIED`, `NO_SUPPORT`, `BLOCKED`, `CANNOT_PLACE`, `NO_ROOM` | Placing blocks |
| `NOT_HUNGRY`, `CANNOT_EAT` | Eating |
| `NO_BED`, `NOT_NIGHT`, `NOT_SAFE`, `OBSTRUCTED`, `CANNOT_SLEEP_HERE` | Sleeping (`CANNOT_SLEEP_HERE`: beds explode in this dimension) |
| `BAD_TARGET`, `ESCAPED` | Players and agents are never attacked; the mob got away |
| `NOT_A_CONTAINER`, `NO_MENU`, `BAD_CLICK`, `BAD_SLOT` | Containers and menus |
| `SEATED`, `SEAT_EXCLUDED`, `NOT_RIDEABLE` | The body sits (stand up or dismount first); chairs are for `agent.seat`, not `ride` |
| `INVENTORY_FULL` | No room for what was gathered or crafted |
| `TIMEOUT` | The job ran past its limit (counted only while it had control) |
| `INTERRUPTED` | Cancelled: replaced by another job, `skill.cancel`, or the agent died or left (`msg` says which). Status `cancelled`. |
| `RESERVED`, `OCCUPIED_BY_PLAYER`, `PC_DOWN`, `NO_SEAT` | The end of an `agent.seat` job (section 7.5) |
| `BAD_ARGS` | Arguments the job could only reject once running (an unknown emote, a `farm` crop that is no seed) |
| `PROTECTED` | The job would change a player-built block or one in a protected zone (the Base), a natural block that holds one up or lies under its roof, light fire or pour lava within 5 blocks of one, build inside a zone, knock down a decoration, take from or retune a player's block (flower pot, lectern, repeater...), or take from a chest the player placed. Nothing was changed. `result.protected` is a `ProtectedDetail` (`pos`, `what`: `player-built` or `base`, `owner`, `block`, `zone?`, `count`, `consentId?`, `hint`); `msg` starts with the teaching line ("That's part of Steve's base — ask Steve before changing it.") |
| `NO_NATURAL_SOURCE` | `mine` / `collect` found nothing natural and reachable within the radius. It never substitutes another block. `result.noNaturalSource` is a `NoNaturalSourceDetail` (`what`, `radius`, `candidates`: up to 8 `{ pos, block, distance, dir, why: unreachable\|too_far\|protected\|not_natural, owner? }`, `hint`); partial counts stay in `result` |
| `INTERNAL`, `FAILED` | The job crashed (`msg` has the exception) / a failure without a more specific code |

#### 7.4.2 Skill conventions beyond the schemas

- **Places in `goto`.** `entity` may name a place instead of an entity: `office` or `home` (the agent's home: its
  spawn point or the bed it last slept in, else world spawn), `spawn` (world spawn), the nearest `bed`, `chest`,
  `crafting_table` or `furnace` within 48 blocks, `codex` (the spot in front of the nearest Codex block within 48
  blocks: the "file it" walk after a Codex write, PLAN 6.6), or `pc:<pcId>` (that PC's chair). An unknown place fails with
  `NOT_FOUND`.
- **Menu buttons.** `menu_click.slot` keeps vanilla slot numbers (`-999` = outside the window). A `slot` of `-2` or
  less presses menu button `-slot - 2`: a merchant's trade offer (then take the result from slot 2), an enchanting
  option (`-2`, `-3`, `-4`), a stonecutter recipe. `obs.query menu_state` lists the button numbers of the open menu.
- **`smelt.item`** is either what goes in (`raw_iron`) or what should come out (`iron_ingot`).
- **`sequence{steps: [{skill, args}], stop_on_fail?, allow_protected?}`** (cap `skill.sequence`; docs/design/tools-v2-mc.md
  M1) runs 2-8 skills in order as one job: one `jobId`, one `skill.result`, no wake between steps. Every step is
  built when the request arrives, so a bad one (an unknown skill, bad args, a nested `sequence`, an `emote`) rejects
  the whole request with `BAD_ARGS: step i: …` and nothing runs. Steps run as the parent's children: reflexes pause
  and resume the running step, a cancel or `replace` cancels it. Progress reads `step i/n <the step's progress>`.
  With `stop_on_fail` (default true) the first failed step fails the sequence with that step's code and
  `msg: "step i/n <skill>: <msg>"`; without it the remaining steps run and the sequence fails at the end if any step
  did. `result: { completed, steps: [{ skill, status, code?, msg?, result }] }` (steps that never ran are absent). The
  timeout is the sum of the steps' timeouts, at most 40 minutes. `allow_protected` with the `skill.run` consent
  token covers every step (the grant lasts while the sequence runs).
- **The craft tree.** `craft{item, count, table?, tree:true, gather_missing?, allow_protected?}` (cap `craft.tree`;
  M4; `allow_protected` with the consent token covers its child jobs, like a sequence's steps) makes `count`
  new items end to end: it plans from the inventory (intermediates such as logs → planks → sticks, smelting in a
  furnace, recipes picked by what the inventory fits, at most 4 levels deep, never a recipe that consumes an item
  being made higher up, never a compressed form such as a block of iron unless it is carried), gathers missing raw
  materials from nature with child `collect{make_tools:true}` jobs when `gather_missing` (fuel: logs; felled trees
  replanted), plans again, then crafts and
  smelts step by step. A table or furnace within 24 blocks (the Base's are fine to use) or the given `table` is used;
  else the agent's own is put down, crafted first if needed; never inside a protected zone (the agent walks out, at
  most 16 blocks, else `NO_ROOM`). Missing raw materials without `gather_missing`: `MISSING_INGREDIENTS` with
  `result.missing: [{ item, need, have, for }]`, before anything is crafted. `result: { item, crafted, have, steps:
  ["oak_log 1 → oak_planks 4", …], station?: { kind, pos, placed }, gathered?: { item: n } }`. Without `tree`,
  `craft` is the one-level craft.
- **Natural sources (W1).** `mine`, `collect` and `find{filter:natural}` resolve a block or tag to natural sources:
  - A `#tag` leaves out building variants: stripped logs, wood, hyphae and planks. Named outright to `mine`
    (`stripped_spruce_log`) they count, but stay protected; `collect` of one finds nothing in nature (craft it).
  - Logs come from **natural trees**: a cluster of log blocks touching leaves with `persistent=false` that nobody
    placed and that touches no building block (planks, glass, doors, stairs, slabs, fences, walls, wool, beds,
    bricks, cobblestone, chests...). Logs in buildings are never trees, even in a world from before provenance. A tree is felled whole, bottom-up: the nearest one the agent can walk
    to (a quick A* per tree; with no walking way to any, the nearest one Tier-2 navigation can dig or build its way
    to), the logs in reach first, each other log reached by digging natural ground, pillaring or bridging if needed;
    logs higher than that from a pillar beside the trunk or in the cut trunk (scaffold from the bag, or dirt dug nearby
    and put back afterwards; at most 12 blocks high at full health, less when hurt, never in water or by lava, down
    again at 8 health or less or when a hit leaves it too high; an agent a cancelled or failed job leaves up there
    comes down by itself). A log no walk reaches waits while the rest of the tree comes down, and gets one more
    try; three failed walks in a row give the rest of that tree up. Every pillar is cleared afterwards; the tree's
    drops are picked up all over its crown (the leaf under a drop caught in the canopy is broken so it falls), and
    `collect{replant:true}` plants a sapling of the same kind on the stump. `result.trees` counts felled trees,
    `kept` the logs kept (picked up) against `mined`, `logsLeftHigh` logs no climb reaches (never searched for).
  - Protected blocks are never targets. Nothing natural in reach: `NO_NATURAL_SOURCE` (only protected blocks of the
    named kind: `PROTECTED`; `mine{near}` on a protected block: `PROTECTED` at once).
- **Protection and consent (W1).** The mod records who placed each block: players, agents (separately) and the
  starter office (as the `Base`), per chunk and saved with it. A placed block that is broken or washed away loses its
  mark; crops, saplings and fire are never marked. Protected: player-built blocks, and everything inside a protected
  zone: the **Base** (the office's box plus a 2-block margin) and named zones (`/mv zone add`). Agents may change
  blocks agents placed, and natural blocks outside zones.
  - Every block-changing skill refuses protected blocks with `PROTECTED`: `mine`, `collect`, `dig` (the whole box is
    checked first), `place` over a protected plant or snow, `build`, `farm` (till, harvest, bone meal), `use_item`
    with tools that till, strip or burn, buckets and fire charges, `attack` on item frames, paintings and armor
    stands, and `container{take}` / `menu_click` on a chest the player placed (the office's own chest is the crew's
    shared supply). Vanilla breaking and item use are refused for agents too, whatever drives them.
  - A natural block counts as protected when it holds up a protected one (the ground under the player's torch, door
    or wall, the stone behind their ladder) or is the floor under their roof (the first solid block above, at most 6
    up, is theirs); the hint says so ("That holds up part of Steve's build (ladder at 3 64 5) — …"). Fire and lava
    are refused within 5 blocks of a protected block ("Fire or lava there could reach part of Steve's build — …"),
    and so is placing TNT there.
    `use_block` / `use_item` refuse right-clicks that take from or retune a protected flower pot, lectern, chiseled
    bookshelf, shelf, jukebox, decorated pot, cake, candle, repeater, comparator, daylight detector, note block or
    respawn anchor. `build` refuses walls, roofs and water inside a zone even into air ("Building there changes part
    of Steve's base — …"); torches are allowed. `hunt` and `attack` never target tamed or name-tagged animals or
    golems a player built (`attack` on one: `BAD_TARGET`).
  - `args.allow_protected: true` (on those skills: `CONSENT_SKILLS` lists every skill whose args take it, `use_block`
    and `menu_click` included since 2026-10-09, additive) counts only with a valid top-level `consent: { token }` on the
    same `skill.run`. The token is the `consentId` of an earlier `PROTECTED` failure of the same agent (32 hex, valid
    10 minutes, single use); it lets that one job change the blocks in the box of the protected blocks it was offered
    for. Node attaches it only after the player explicitly agreed, never from tool input: a model cannot authorize
    itself. A token the mod did not offer to this agent, or an expired one, is `err BAD_ARGS`.
- **`look_around` scene (W1).** `result.scene` is text the agent reads, most important line first: position, biome,
  time and cover; the zone (`Inside Base (...)` or `Base 12m SW`); hazards (hostiles with distance and direction,
  lava, sheer drops, air under water); natural trees by species with trunk position, distance, compass direction
  and `reachable` / `unreachable` / `far`; what players and agents built nearby (clusters with owner, size and box);
  the player (with whether they stand in a zone and under a roof, leaves not counting: `Steve (player) 4m S, in Base,
  under cover`, or `…, in the open`) and the crew; water, exposed ores and crops; the ground. `detail: brief`
  (default) stays within 900 characters, `full` within 2500 (more trees, animals, loose items, workstations). `zone`
  and `trees` repeat the key facts as data. The status footer names the zone after the position: `| in Base |` or
  `| 12m from Base |`.
- **`collect`** picks up loose items first, then breaks blocks that drop the item: the item's own block or tag, plus
  stone → cobblestone, ores → raw metals and gems, gravel → flint, grass → seeds. Like `mine`, it only breaks natural
  blocks (section 7.4.3). With cap `collect.gather` (M2): `near` searches around a spot instead of the agent;
  `make_tools: true` crafts the tool a source needs (iron, stone, then wooden tier) from what is carried, through the
  craft tree, instead of failing `NEEDS_TOOL`; animal drops (beef and leather: cows, porkchop: pigs, mutton and wool:
  sheep, chicken and feathers: chickens, rabbit and rabbit hide: rabbits) come from the nearest animal outside
  protected zones that is no pet, named, leashed or young (none: `NO_NATURAL_SOURCE`, saying how many were left
  alone), also once no natural block of an item both drop is left (wool); drops are picked up within 5 blocks for
  up to 5 seconds after each break (a felled tree's: after the tree, all over its crown). A block that drops something else (`stone`: cobblestone, an ore: its raw metal)
  is broken `count` times, as `mine` counts, and the job is done with `result.note` saying so (Node's v2 `gather`
  asks for the drop instead). `result` adds `item`, `got` (the same as `collected`: more of the item than at the
  start), `sources: [{ kind: tree|ore|stone|animal, what, pos, n }]`, `tools_made` and `note`.
- **`container`** without `pos` (cap `container.nearest`) uses the nearest chest, trapped chest or barrel within 24
  blocks (none: `NOT_FOUND`); the result's `pos` says which. **`give`** without `count` (cap `give.all`) gives
  everything of the item.
- **`mine` and `collect`** search `radius` blocks around `near` or the agent: 32 by default, the same as `find`, so
  a source `find` shows is one they reach (at most 64). They reach their blocks by digging through natural ground,
  pillaring and bridging if there is no walking way (the mod's Tier-2 navigation, which breaks only what section
  7.4.3 lets agents break); their `result` counts `mined` and `unreachable` (the targets given up on).
- **`build` blueprints** (built-in; Codex-page blueprints are not supported yet): `shelter` (5×5, door gap facing
  north at rotation 0, roof, a torch inside when one is carried: without one it ends `done` with
  `note: "no torch carried: the inside stays dark"`), `wall_ring` (9×9, 2 high), `torch_ring` (8 torches 5 blocks out), `bridge` (8 blocks
  ahead at foot level), `stairs_down` (8 steps down, ahead), `farm_plot` (water in the middle, 9×9 tilled and
  planted). "Ahead" is south (+Z) at rotation 0; rotations turn clockwise. Walls take any plain full block (dirt,
  cobblestone, planks, ...); the job checks the material first (`NO_MATERIAL`). Any other id is `UNKNOWN_BLUEPRINT`.
- **`farm`** repeats passes over the box until nothing is left to do: harvest ripe crops, till dirt and grass (with
  a hoe, when there are seeds), plant empty farmland, bone-meal growing crops. `crop` must be a seed item (or a tag);
  anything else is `BAD_ARGS`.
- **Agent ids in the mod.** The mod names each body's fake player after its `agentId`, so `agent.spawn` only accepts
  ids whose lowercase form matches `[a-z][a-z0-9_]{0,15}` (a subset of `AgentId`) and refuses others with
  `BAD_ARGS`. No body exists for such an id, so `skill.run` and `obs.query` for it answer `UNKNOWN_AGENT`. Node mints
  every agent id inside that rule: the handle plus 4 hex digits (`ada1f3c`), at most 16 characters.

#### 7.4.3 The world guard: natural blocks, protected blocks, consent

Agents gather from nature and never wreck the player's home. The mod knows each block's provenance (placed by a player
or by OfficeBuilder, or natural) and where the **Base** is (the starter office and its grounds). Node teaches the model
these rules (persona, tool descriptions, failure texts) and only it can lift them, per block, with the player's consent.

- **Protected blocks.** Every block of the Base, and every block a player placed anywhere. `mine`, `collect`, `dig`,
  `farm` (tilling, harvesting placed crops is fine), `place` and `build` never break or replace one; containers in the
  Base stay usable (`container`, `use_block`).
- **Natural by default.** `mine` and `collect` only take natural blocks. A tag (`#minecraft:logs`) means its natural
  members: building variants (stripped logs and wood, planks, and every block placed by someone) never count. A job
  that finds only protected blocks of the kind fails `NO_NATURAL_SOURCE`, never takes a protected one.
- **`PROTECTED`** and **`NO_NATURAL_SOURCE`** (job failures): `result.protected` is a `ProtectedDetail` and
  `result.noNaturalSource` a `NoNaturalSourceDetail` (section 7.4.1). Node notes the refusal (its block, zone and
  `consentId`) so the player can allow exactly that.
- **Perception.** `obs.query look_around` answers the mod's scene (`result.scene`, plus `zone` and `trees` as data);
  Node passes the scene text to the model as is and notes the nearest reachable tree for its one-line digest scene.
  `find` labels each block match with `provenance` (`natural`, `player-built`, `base`, `agent-built`) and, for the
  nearest three, `reachable`; Node turns these into lines ("oak_log 25m NE natural, reachable · stripped_spruce_log 2m
  N PROTECTED").
- **Zone.** `agent.state.agents[].zone` is the footer's words: `in Base` (or `in <zone>`) inside a protected zone,
  `12m from Base` outside. Node reads `in …` as the Base kind and anything else as the wild.
- **Consent.** The token is the mod's: a `PROTECTED` failure offers `consentId` (32 hex, 10 minutes, single use,
  bound to that agent and those blocks). Node keeps the offer and passes it back as `skill.run.consent = { token }`
  (with `args.allow_protected: true`, which Node sets) only when the player explicitly allowed it: an answered
  question card whose chosen option starts with "Allow" and, in its label or description, names what it unlocks
  (the Base, the house, the pillars, or the refused block id), or a direct chat reply to that agent that is a plain
  yes naming the same (`yes, take them from the house`). A pronoun alone (`yes, take it`), the Base as a destination
  (`back to base`) or its furniture is not a permission; such replies need the card. The model can never pass one:
  tool arguments carry no consent. A refusal Node raised itself (below) carries no token, so it can only be allowed
  after the mod refuses the job itself.
- **Node's own guard** (only for a mod that sends no `zone`, i.e. guards no provenance): `dig` / `farm` boxes that
  overlap the Base (and the torches on its walls), `mine` / `collect` aimed `near` a spot inside it, `build`
  blueprints that reach into it, and `mine` / `collect` for a `#tag` or for something the Base is built of (planks,
  stripped logs, cobblestone, bricks, glass, its furniture) whose search (`near` or the agent, `radius` default 24)
  reaches the Base are refused `PROTECTED` before they reach the mod. **Node treats a mod that sends `zone` in
  `agent.state` as one that guards provenance** and leaves every check to it, so its refusals carry a consent token;
  a mod must send `zone` only once it enforces the rules above.

### 7.5 seats

- `agent.seat` (request, `AgentSeatResult { jobId, status: "running" }`): `{ agentId, jobId, seatEpoch, target:
  { kind: "pc", pcId } | { kind: "meeting", meetingId }, purpose? }`. The mod reserves the chair ("Bram is
  coming"), walks, then rides it (non-forced). The outcome is a `skill.result{jobId}` and, for a PC, `pc.seat`.
  Node runs its own pre-checks first (`PC_DOWN`, `SEAT_CAP`); the mod checks again before it reserves (`PC_UNKNOWN`,
  `PC_DOWN`, `SEAT_CAP` when 2 other agents sit at, walk to or keep a PC, `OCCUPIED_BY_PLAYER`, `RESERVED`, `NO_SEAT`
  for a meeting without a free chair, `UNKNOWN_AGENT`) and answers `err` with that code. Past the checks it replies
  `running`; `UNREACHABLE`, `OCCUPIED_BY_PLAYER`, `RESERVED`, `PC_DOWN` and `NO_SEAT` can still end the job later.
  A new `agent.seat` replaces the agent's current job. Reservations of agents that died or left are dropped within
  a second.
- `agent.unseat` (request): `{ agentId, seatEpoch, reason, keepReservation }`. `keepReservation` keeps the chair for
  the agent (`away`: asking the player, "BRB" on the monitor; `meeting`). A `seatEpoch` older than the seat's (or
  than the walk to a seat) is answered `ok { "ignored": true }`. An agent that is not seated only has its
  reservations released (unless `keepReservation`).
- `pc.seat`: `{ pcId, occupant, seatEpoch? }`; `pc.unseat`: `{ pcId, occupant, reason, reserved }`. The mod's
  PcRegistry is authoritative for who sits where; these fire for the player too (sitting opens PcControlScreen,
  Shift+Esc stands up).
- `UnseatReason`: `stand`, `kick`, `damage`, `survival`, `death`, `pc_down`, `meeting`, `world_end`, `dismiss`,
  `app_restart`, `worker_restart`, `away`, `player_took`, `reservation_expired`.

### 7.6 ui

- `agent.brain`: `{ agentId, model, status: idle|thinking|queued|waiting_player|asleep|offline, activity|null,
  autonomy, planFirst, pingInstead }`. Head icons: … thinking, hourglass queued, Zz asleep/offline; ? and ! come
  from the cards; the monitor icon from `agent.state.seat`.
- `agent.pending`: `{ agentId, cards: PendingCard[] }` replaces that agent's cards. `PendingCard` is
  `{ id, agentId, createdAt, parked, presenting }` plus, by `kind`: `question { questions: [{ question, header?,
  options: [{ label, description? }], multiSelect }], answers }`, `plan { plan }`, `hire { role, name, handle,
  reason, firstTask }`, or `calendar { eventId, summary }` (an agent-created recurring event or meeting waiting for
  approval).
- `agent.approach`: `{ agentId, pendingId|null, role: present|present_seated|queue|ping|release }` (PLAN §6.4).
  `present_seated` (USER DECISION 2026-10-08): a seated agent whose player is near stays in its chair, turns toward
  the player, shows the card-mode bubble and chimes once; it never dismounts. `present` walks over (for a seated agent,
  after Node's `agent.unseat{away, keepReservation}`).
- `chat.append`: `{ agentId, entry: ChatEntry }`; `ChatEntry = { seq, at, kind:
  player|agent|activity|card|answer|tell|system, text, fromAgentId?, cardId?, session?: body|desk, pcId? }`.
  `session` says which of the agent's two sessions the line belongs to (PLAN §6.1, dual sessions): `body` in the world,
  `desk` at the PC `pcId`. The transcript is one merged history; AgentScreen and the Crew log tag desk lines with their
  PC (`Ada @linux-1: …`). `chat.history` (request, `ChatHistoryResult { entries, more }`): `{ agentId, beforeSeq?,
  limit }`.
- `chat.send` gains an optional `mode: chat|reply|task|interrupt` for AgentScreen's Reply / New task / Interrupt.
- `pending.answer` (request, `ChatSendResult`): `{ agentId, pendingId, answer }` with `answer` one of
  `{ kind: "options", picks: [1-based] }`, `{ kind: "text", text }`, `{ kind: "later" }`, `{ kind: "approve" }`,
  `{ kind: "decline", note? }` (the last two for calendar approval cards). Errors: `CARD_GONE`,
  `CHAT_INVALID_ANSWER`.
- `plan.decision` (request, `ChatSendResult`): `{ agentId, pendingId, decision: approve|revise, feedback? }`
  (`revise` needs `feedback`). `hire.decision` (request, `ChatSendResult`): `{ pendingId, decision:
  approve|decline, note? }`.
- `agent.cmd` (request): `{ agentId, cmd, on?, level? }`, `cmd` one of `follow`, `stay`, `guard`, `wander`,
  `stop`, `interrupt`, `kick`, `dismiss`, `plan_first` (needs `on`), `ping_instead` (needs `on`), `autonomy`
  (needs `level`), `retry_brain`.
- `brains.state`: the `BrainsSummary` keys of `hello.ok.brains`.

### 7.7 pc

- `pc.state`: a `PcInfo` at the top level: `{ pcId, type: linux|linux-slim|macos, name, status, progress|null,
  detail|null, slot, cpus, memoryMiB, diskGiB, plugged, pinned, wipeOnDeath, mounts: [{ hostPath, mode: rw|ro }],
  occupant|null, reservation: { agentId, kind: coming|away }|null, banner|null, screen: { w, h }|null,
  consent: { consentId, what, bytes, freeBytes }|null }`. `slot` is the MVF1 `pcSlot` of its frames. Statuses:
  `off`, `downloading`, `awaiting_consent`, `booting`, `running`, `stopping`, `remounting`, `reimaging`,
  `no_capacity`, `macos_slots_full`, `engine_down`, `error`, `decommissioned`.
- `budget.state`: `{ cpu: { total, used, free, maxOvercommit }, memoryMiB: { pool, used, free }, diskFreeGiB,
  macos: { running, max }, crewCap }`.
- `pc.view`: `{ pcId, tier: focus|visible|none }`, sent on change.
- `pc.input`: `{ pcId, seq, events }`, at most 60 batches a second. Events (guest pixels, cua key names):
  `{ k: "move", x, y }`, `{ k: "button", button: left|right|middle, down, x, y }`, `{ k: "scroll", dx, dy, x, y }`,
  `{ k: "key", key, down }`, `{ k: "text", text }` (from `charTyped`), `{ k: "release_all" }`.
- `pc.frame.ack`: `{ pcId, seq }` after a frame is decoded (at most 2 unacknowledged per PC).
- `pc.cursor`: `{ pcId, x, y, visible }`, the agent's last pointer target (frames carry no cursor, PLAN §8.6).
- `pc.config` (request, `PcConfigResult { recreate }`): `{ pcId, name?, type?, cpus?, memoryMiB?, mounts?, pinned?,
  wipeOnDeath? }`. Errors: `OVER_BUDGET`, `BAD_MOUNT`, `PC_UNKNOWN`.
- `pc.action` (request, `PcActionResult { pcId }`): `{ action, pcId?, type?, pos? }`. `create` takes `type` and
  no `pcId`; every other action (`start`, `stop`, `restart`, `reimage`, `decommission`, `reissue`, `unplug`,
  `plug`, `kick`, `watch`, `unwatch`) takes `pcId`. Errors: `OVER_BUDGET`, `NO_CAPACITY`, `MACOS_SLOTS_FULL`,
  `PC_UNKNOWN`, `ENGINE_DOWN`.
- `pc.consent` (request): `{ pcId, consentId, accept }`.
- `host.pick_folder` (request, `PickFolderResult { path|null }`): `{ purpose: "vault", pcId?, prompt? }`. PLAN §5
  calls it `host.pickFolder`; type names are dotted lowercase (section 4), so the wire name is `host.pick_folder`.

### 7.8 org: Codex, calendar, meetings

- `codex.index`: `{ pages: CodexPageMeta[] (≤ 1000), truncated }`; `CodexPageMeta = { id, title, category, scope,
  tags, author: Author, created, updated, rev, pinned }`. Categories: `places`, `howto`, `projects`, `decisions`,
  `people`, `log`, `minutes`, `rules` (player only). Scopes: `lasting`, `world`.
- `codex.search` (request, `CodexSearchResult { hits: [{ id, title, category, scope, snippet, score }] }`):
  `{ query, tags?, category?, scope?, limit }`.
- `codex.get` (request, `CodexGetResult { page }`): `{ pageId }`; `page` adds `body` (≤ 8192), `links` and `history:
  [{ rev, at, author, summary }]` to the meta. A page's `rev` is Node's revision token (7 zero-padded digits,
  `0000003`), the one `baseRev` takes back; a history entry's `rev` is the commit of that change.
- `codex.put` (request, `CodexPutResult { pageId, rev }`): `{ mode: create|update|append, pageId?, baseRev?, title,
  body, tags, category, scope, pinned? }`. `update` and `append` need `pageId`, `update` needs `baseRev`. Errors:
  `CODEX_CONFLICT` (stale `baseRev`), `CODEX_SIMILAR`, `CODEX_TOO_LARGE`, `CODEX_SECRET`, `CODEX_INVALID`,
  `CODEX_NOT_FOUND`, `FORBIDDEN`.
- `codex.delete` (request): `{ pageId, baseRev? }`.
- `calendar.state`: `{ events: CalendarEvent[], tz }`. `CalendarEvent = { id, title, kind: task|reminder|meeting,
  assignees: AgentId[] | "all", clock: game|real, at, tz?, recurrence: { kind: once|daily|every_n_days|weekdays,
  n? }, durationMin, location?, task?, catchUp: skip|once_late, runWhileAway, createdBy: "player" | AgentId, status:
  active|paused|pending_approval|orphaned|done|cancelled, nextAt|null, occurrences: [{ at, status, note?, agentId?
  }] (≤ 20) }`. On the game clock `at` and `nextAt` are overworld clock ticks (Day = floor(t/24000)+1, 06:00 =
  tick 0); on the real clock they are epoch ms. `weekdays` is real clock only; `every_n_days` needs `n`.
  Occurrence statuses: `fired`, `done`, `failed`, `blocked`, `missed`, `deferred`, `orphaned`, `cancelled`.
- `calendar.put` (request, `CalendarPutResult { eventId }`): the event fields (no state), plus `eventId` to edit.
  `calendar.cancel` (request): `{ eventId, scope: next|all }`. Errors: `CALENDAR_NOT_FOUND`, `CALENDAR_INVALID`,
  `FORBIDDEN`.
- `calendar.fired`: `{ eventId, occurrence, kind, title, assignees, target: Place|null, walk: AgentId[] }`. `walk`
  lists the assignees whose brain accepted the task and who now go to `target` (reflex 38); Node re-sends the same
  occurrence as more accept.
- `meeting.state`: `{ meetingId, title, phase: gathering|open|updates|floor|wrapup|done, chair, speaker|null,
  attendees: [{ agentId, status: coming|seated|dialed_in|absent|excused|left|dead, etaS|null }], eventId|null,
  startedAt, endsBy, quick }`. `chair` and `speaker` are `"player"` or an agent id.
- `meeting.start` (request, `MeetingStartResult { meetingId|null, etas: [{ agentId, etaS|null, dialIn }] }`):
  `{ eventId?, title?, attendees?, preview }`; with `preview` Node only computes the ETAs. Errors: `MEETING_BUSY`,
  `NO_QUORUM`. `meeting.end` (request): `{ meetingId }`.

### 7.9 debug (additions to 6.13)

| Type | Runs on | `ok` reply |
|---|---|---|
| `debug.kill_agent` | integrated server | `{}`; `err UNKNOWN_AGENT` |
| `debug.set_clock` | integrated server | `{}` after setting the overworld clock to `clockTime` |
| `debug.chat` | client thread | `{ sent, hint }`: `{ text }` goes through the chat interceptor exactly as a typed line (the local mention check, then `chat.send`); `sent: false` with the hint when the local check refused it |
| `debug.ui_request` | the bridge (the reply waits for Node) | `{ reply }`: `{ type, payload }` is sent to Node as the UI would send it (any mod-to-Node request: `agent.cmd`, `calendar.put`, `pending.answer`, ...); Node's `err` is returned as this request's `err` (`BAD_ARGS` for an unknown or Node-to-mod type) |

`DebugStateResult` gains three optional keys from newer mods: `player` (`{ x, y, z }` or null), `agents` (the crew as
the client shows it: `agentId`, `handle`, `status`, `brain`, `headIcon`, the live `bubble` text or null, open
`cards`, the body's `pos` or null, `atPc`) and `monitors` (each PC frame the client holds: `pcId`, `w`, `h`, `seq`,
`patches`, `ageMs` (null before the first frame), and `hash`, a CRC32 of the pixels, null before the first frame).
Inside `agents` and `monitors` every key is present; the nullable ones are `null`, never left out.

Fixtures: `debug.chat.json`, `debug.ui_request.json`.

## 8. Binary frames: `MVF1` (N→M)

One frame per WebSocket binary message: a **32-byte big-endian header**, then the payload.

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u32 | magic | `0x4D564631` (`"MVF1"`) |
| 4 | u8 | kind | `1` = pc_frame |
| 5 | u8 | codec | `1` = JPEG, `2` = RGBA8, `3` = BGRA8 |
| 6 | u16 | flags | bit0 `FULL` (rect is the whole frame), bit1 `CURSOR` (cursor drawn in), bit2 `DIRTY_RECT` (patch into the previous frame). Other bits must be 0. `FULL` and `DIRTY_RECT` are exclusive. |
| 8 | u32 | pcSlot | Which monitor texture |
| 12 | u32 | seq | Per-PC sequence number |
| 16 | u16 | w | Full frame width |
| 18 | u16 | h | Full frame height |
| 20 | u16 | rectX | Region the payload covers |
| 22 | u16 | rectY | |
| 24 | u16 | rectW | ≥ 1 |
| 26 | u16 | rectH | ≥ 1 |
| 28 | u32 | payloadLen | Must equal `message length - 32` |
| 32 | … | payload | JPEG bytes (starting `FF D8`) or `rectW × rectH × 4` raw bytes |

Validation (both sides reject the frame otherwise): magic; known kind and codec; no reserved flag bits; non-zero
`w`, `h`, `rectW`, `rectH`; `rectX + rectW ≤ w` and `rectY + rectH ≤ h`; a `FULL` rect covers the whole frame;
raw payloads are exactly `rectW × rectH × 4` bytes; JPEG payloads start with SOI; `payloadLen ≤ 64 MiB`.

**Flow control.** At most 2 unacknowledged frames per PC; the latest frame wins. Node skips (never queues) a
frame while the socket buffers more than **8 MiB**; control messages are never dropped.

**Java decoding.** Frames go to a 2-thread decoder, latest-wins per PC: JPEG via
`STBImage.stbi_load_from_memory`, BGRA via memCopy plus an R/B swizzle, then at most one texture upload per PC
per frame.

## 9. Java threading notes

- Listener: call `request(1)` on **every** `onText`/`onBinary` invocation, partial fragments included, and copy
  each part into a pooled direct buffer until `last`.
- Routing: server-world messages go through `server.execute(…)` (reply `err NO_SERVER` without a server), UI
  messages and `world.open` / `world.next` through `Minecraft.getInstance().execute(…)`, frames to the decoder.
- Sending: one `mv-bridge-send` thread drains a queue; `java.net.http.WebSocket` allows only one send in flight.
- An oversize message from Node (text over 256 KiB, binary over 32 bytes + 64 MiB) makes the mod close with
  `1008`: `java.net.http` does not let a client send `1009`.
- Implementation: `dev.minevibe.bridge.BridgeClient` (`apps/mod/src/main/java`), with the zod-equivalent validator
  and the M1 records in `dev.minevibe.bridge.protocol`, and the records of every later group in
  `dev.minevibe.bridge.msg` (`Bodies`, `Skills`, `Seats`, `Ui`, `Pc`, `Org`, `Debug`).

## 10. Fixtures

```
fixtures/<group>/<type>.json                 one valid example per message type, in its catalog group
fixtures/<group>/<type>--<variant>.json      further valid examples
fixtures/<group>/invalid/<type>--<why>.json  must be rejected (bad version, unsafe world id, failed refinement, ...)
fixtures/envelope/invalid/*.json             malformed envelopes
fixtures/unknown/*.json                      well-formed envelopes with unknown types: must be ignored, not rejected
fixtures/reply/ok--<request>.json            `ok` replies; vitest checks each against its request's result schema
```

Groups: `world`, `bodies`, `skills`, `seats`, `ui`, `pc`, `org`, `debug`, `reply`. Every registered type has at
least one valid fixture and every group has invalid ones; the vitest suite enforces both. The mod's JUnit suite
parses the same files with Gson: valid ones into their records (every JSON key must map to a record component), the
messages the mod sends must re-encode to identical JSON, and invalid ones must be rejected.
