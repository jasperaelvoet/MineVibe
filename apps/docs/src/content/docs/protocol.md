---
title: Wire protocol
description: A summary of the WebSocket protocol between the Minecraft mod and MineVibe's Node orchestrator, and how its fixtures keep both sides in step.
---

:::note[Summary only]
The authoritative contract is
[`packages/protocol/protocol.md`](https://github.com/jasperaelvoet/MineVibe/blob/main/packages/protocol/protocol.md),
next to the zod schemas (`packages/protocol/src/`) and the JSON fixtures (`packages/protocol/fixtures/`). Both
sides parse the same fixtures, so they can't drift apart (see [Fixtures](#fixtures)). A reference generated from
the zod schemas is **planned** for this site.
:::

## Transport and auth

- **One WebSocket** between the mod and Node. The bridge listens on `ws://127.0.0.1:<random port>/v1` with the
  subprotocol `minevibe.v1`.
- **Token.** Node writes the port, a random token and its pid to `run/bridge.json` (mode 0600). The JVM only
  receives the path, as `-Dminevibe.bridgeFile=...`; the token never appears on a command line or in a log.
- **Auth.** The mod sends `Authorization: Bearer <token>`. The server rejects any request with an `Origin`
  header and any peer that is not on loopback.
- **Reconnects.** After a reconnect the mod sends `hello`, and Node answers with `hello.ok` and a full state resync;
  nothing is replayed.
- **Development.** `npm run dev` uses the fixed port 47800 and a fresh token on every start. The mod re-reads
  `run/bridge.json` before every connection attempt and never connects when the file's `pid` is not running, so a
  stale file can never hand the token to whatever listens on that port later.

## Message envelope

Every text message is one JSON object, with the payload keys next to the envelope keys:

```json
{ "t": "chat.send", "v": 1, "id": "m-42", "to": "all", "text": "dinner time, everyone inside" }
```

| Field | Meaning |
| --- | --- |
| `t` | Message type, dotted lowercase with snake_case words, for example `agent.say` or `host.pick_folder` |
| `v` | Protocol version, currently `1` |
| `id` | Request id: the sender expects an `ok` or `err` answering it. Node uses `n-<seq>`, the mod `m-<seq>`. |
| `re` | On a reply: the `id` being answered |

Requests are answered with `ok` (plus result keys) or with `err` carrying `{code, msg}`. Unknown message types are
ignored (and answered `err UNKNOWN_TYPE` when they carried an `id`), unknown keys inside a known message too. Adding
a message type never changes `v`.

Two requests must arrive: `player.died` and `world.state{phase: closed}`. The mod re-sends them until Node
acknowledges, and Node answers a repeat with `ok {"ignored": true}`.

## Message groups

| Group | Messages |
| --- | --- |
| World | `hello`, `hello.ok`, `world.open`, `world.state`, `world.next`, `player.died`, `client.stopping`, `server.shutdown` |
| Bodies | `agent.spawn`, `agent.despawn`, `agent.state` (1 Hz), `agent.event`, `agent.died`, `agent.mode`, `crew.state` |
| Skills | `skill.run` → `running` / `done` / `failed` / `cancelled`, `skill.progress`, `skill.cancel`, `skill.result`, `obs.query` |
| Seats | `agent.seat`, `agent.unseat`, `pc.seat`, `pc.unseat` |
| UI | `ui.toast`, `agent.say`, `agent.brain`, `agent.pending`, `agent.approach`, `chat.append`, `chat.history`, `chat.send`, `pending.answer`, `plan.decision`, `hire.decision`, `agent.cmd`, `brains.state` |
| PCs | `pc.state`, `budget.state`, `pc.view`, `pc.input` (batched, at most 60 Hz), `pc.frame.ack`, `pc.cursor`, `pc.config`, `pc.action`, `pc.consent`, `host.pick_folder` |
| Org | `codex.index` (push), `codex.search`, `codex.get`, `codex.put`, `codex.delete`, `calendar.state` (push), `calendar.put`, `calendar.cancel`, `calendar.fired`, `meeting.state`, `meeting.start`, `meeting.end` |
| Debug | `debug.*`: end-to-end test builds only (`-Dminevibe.e2e=true`) |

Page, event and meeting ids travel as `pageId`, `eventId` and `meetingId`, never as `id` (that key belongs to the
envelope). Meeting phases are `gathering`, `open`, `updates`, `floor`, `wrapup` and `done`.

`protocol.md` also holds the conventions that the schemas alone don't show: the job failure codes, the place names
`goto` understands, how `menu_click` presses menu buttons, the built-in `build` blueprints, the `waitMs` cap of
2 minutes, and the office slot kinds in `world.state` (`workstation`, `meeting_table`, `codex`, `wall_calendar`,
`chest`, `bed`, `door`, `spawn`).

## Fixtures

Every message type has example JSON files in `packages/protocol/fixtures/`, sorted by group:

```text
fixtures/<group>/<type>.json                 one valid example per message type
fixtures/<group>/<type>--<variant>.json      further valid examples
fixtures/<group>/invalid/<type>--<why>.json  must be rejected (bad version, unsafe world id, unknown slot kind, ...)
fixtures/envelope/invalid/*.json             malformed envelopes
fixtures/unknown/*.json                      well-formed messages of unknown types: ignored, never rejected
fixtures/reply/ok--<request>.json            `ok` replies, checked against their request's result schema
```

The groups are `world`, `bodies`, `skills`, `seats`, `ui`, `pc`, `org`, `debug` and `reply`.

- **vitest** (`npm test -w packages/protocol`) parses every fixture with the zod schemas. It also checks that every
  registered message type has at least one valid fixture and every group except `debug` has invalid ones.
- **JUnit** (`./gradlew test` in `apps/mod`) parses the same files with Gson into the mod's records. Every JSON key
  must map to a record component, so no field is dropped silently. Messages the mod sends must re-encode to
  identical JSON, and invalid fixtures must be rejected.

To change a message, edit its schema in `packages/protocol/src/messages/<group>.ts`, the matching Java record in
`apps/mod` (`dev.minevibe.bridge.protocol` for the world messages, `dev.minevibe.bridge.msg` for the rest) and the
fixtures, then the text in `protocol.md`. Both test suites fail until all of them agree.

## Binary frames: MVF1

PC screens travel as binary WebSocket messages, from Node to the mod. Each frame starts with a 32-byte
big-endian header, followed by the payload:

| Header field | Meaning |
| --- | --- |
| `magic` | `MVF1` |
| `kind` | Frame kind (`1` = PC frame) |
| `codec` | `1` = JPEG, `2` = RGBA8, `3` = BGRA8 |
| `flags` | `FULL`, `CURSOR`, `DIRTY_RECT` |
| `pcSlot` | Which monitor texture the frame belongs to |
| `seq` | Sequence number, per PC |
| `w`, `h` | Frame size in pixels |
| rect | The region the payload covers |
| `payloadLen` | Payload length in bytes |

**Flow control.** At most 2 unacknowledged frames per PC are in flight (the mod acknowledges with `pc.frame.ack`),
and the latest frame wins. Frames are skipped while the socket buffers more than 8 MiB. Control messages are never
dropped.

## Threading in the mod

- **Receiving.** The listener calls `request(1)` on every `onText` and `onBinary` invocation, partial
  fragments included, and copies each part into a pooled direct buffer.
- **Routing.** Server-world messages run on the integrated server thread (`server.execute`), UI messages on
  the client thread, and frames on a 2-thread decoder pool.
- **Sending.** One sender thread drains a queue, because only one WebSocket send can be in flight.
