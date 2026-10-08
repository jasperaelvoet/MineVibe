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

- `ok` carries the request-specific result as extra keys (often none).
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

`TIMEOUT` and `DISCONNECTED` are local failure codes; they are never sent.

## 6. Messages (M1)

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

Fixtures: `hello.json`, `hello--in-world.json`.

### 6.2 `hello.ok` (N→M)

| Field | Type | |
|---|---|---|
| `server` | `{ version: string, protocol: 1 }` | |
| `world` | `{ id: WorldId, gen: int≥1, fresh: bool }` \| null | The world the mod should be in. `fresh`: not created yet. |
| `player` | `{ name: PlayerName }` | |
| `settings` | object | Free-form until later milestones |
| `pcs` | `[{ pcId, … }]` | Pinned in M4 |
| `budget` | object \| null | Pinned in M4 |
| `crew` | `[{ agentId, handle, name, role, ceo: bool, status: alive\|dead\|dismissed }]` | |
| `brains` | `{ inFlight, queued, max, mode: normal\|tired\|asleep, utilization: 0..1\|null, resetsAt: epochMs\|null }` | |
| `pending` | `[{ id, agentId, kind: question\|plan\|hire, … }]` | Pinned in M3 |

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
| `office` | `{ origin: BlockPos, slots: [{ kind, pos: BlockPos, pcId? }] }`? | OfficeBuilder result |
| `clockTime` | int≥0? | `getOverworldClockTime()` ticks; pushed at 1 Hz while `ready` |

`loading` and `ready` (and the 1 Hz clock pushes) are fire-and-forget. **`closed` is a request**: the mod sends it
with an `id` and re-sends it until Node replies (the reply is `ok {}` when Node moved on to the next world, or
`ok {"ignored": true}` when it did not, see 6.6). A lost `closed` therefore never leaves Node on a dead world.

Fixtures: `world.state.json`, `world.state--closed.json`, `ok--ignored.json`.

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

See section 5. Fixtures: `ok.json`, `err.json`, `ok--debug-state.json`.

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

## 7. Later milestones

The full catalog (bodies, skills, seats, cards, Codex, calendar, meetings, PCs) is sketched in PLAN §5 and is
added here, with schemas and fixtures, as each milestone lands. Adding a message type never changes `v`;
changing the meaning of an existing field does.

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
- Implementation: `dev.minevibe.bridge.BridgeClient` (`apps/mod/src/main/java`), with the Gson records and the
  zod-equivalent validator in `dev.minevibe.bridge.protocol`.

## 10. Fixtures

```
fixtures/<type>.json              one valid example per message type
fixtures/<type>--<variant>.json   further valid examples
fixtures/invalid/*.json           must be rejected (bad version, unsafe world id, empty recipients, …)
fixtures/unknown/*.json           well-formed envelopes with unknown types: must be ignored, not rejected
```

Every registered type has at least one valid fixture; the vitest suite enforces it, and the mod's JUnit suite
parses the same files with Gson.
