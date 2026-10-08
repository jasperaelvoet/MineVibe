---
title: Wire protocol
description: A summary of the WebSocket protocol between the Minecraft mod and MineVibe's Node orchestrator.
---

:::note[Summary only]
The authoritative catalog lives in
[`packages/protocol/protocol.md`](https://github.com/jasperaelvoet/MineVibe/blob/main/packages/protocol/protocol.md),
next to the zod schemas and the JSON fixtures. The fixtures are round-tripped by both vitest (Node) and
JUnit (the mod), so the two sides can't drift apart. A reference generated from the zod schemas is
**planned** for this site.
:::

## Transport and auth

- **One WebSocket** between the mod and Node. The bridge listens on `ws://127.0.0.1:<random port>/v1`.
- **Token.** Node writes the port and a random token to `run/bridge.json` (mode 0600). The JVM only receives
  the path, as `-Dminevibe.bridgeFile=...`; the token never appears on a command line.
- **Auth.** The mod sends `Authorization: Bearer <token>`. The server rejects any request with an `Origin`
  header and any peer that is not on loopback.
- **Reconnects.** After a reconnect the mod sends `hello`, and Node answers with a full state resync.
- **Development.** `npm run dev` uses the fixed port 47800 and a `.dev-token` file, which is never committed.

## Message envelope

Every text message is a JSON object. An illustrative example (exact field types are defined in
`protocol.md` and the schemas):

```json
{ "t": "chat.send", "v": 1, "id": "42", "to": "all", "text": "dinner time, everyone inside" }
```

| Field | Meaning |
| --- | --- |
| `t` | Message type, for example `agent.say` |
| `v` | Protocol version, currently `1` |
| `id` | Optional request id |
| `re` | Optional id of the request this message answers |

Requests are answered with `ok`, or with `err` carrying `{code, msg}`.

## Message groups

| Group | Messages |
| --- | --- |
| Session | `hello` |
| World | `world.open`, `world.state`, `world.next`, `player.died` |
| Bodies | `agent.spawn`, `agent.despawn`, `agent.state` (1 Hz), `agent.event`, `agent.died`, `agent.mode` |
| Skills | `skill.run` → `running` / `done` / `failed`, `skill.progress`, `skill.cancel`, `obs.query` |
| Seats | `agent.seat`, `agent.unseat`, `pc.seat`, `pc.unseat{reason}` |
| UI | `agent.say`, `agent.brain`, `agent.pending`, `chat.append`, `chat.history`, `chat.send{to: [agentIds] \| "all", text}`, `pending.answer`, `plan.decision`, `hire.decision`, `agent.cmd`, `agent.approach{agentId, pendingId \| null}`, `ui.toast`, `brains.state` |
| Codex | `codex.index` (push), `codex.search`, `codex.get`, `codex.put`, `codex.delete` |
| Calendar | `calendar.state` (push), `calendar.put`, `calendar.cancel`, `calendar.fired{eventId, occurrence}` |
| Meetings | `meeting.state{id, phase, attendees, speaker}`, `meeting.start`, `meeting.end` |
| PCs | `pc.state`, `budget.state`, `pc.view`, `pc.input` (batched, at most 60 Hz), `pc.config`, `pc.action`, `pc.consent`, `host.pickFolder` |
| Debug | End-to-end test builds only |

Meeting phases are `gathering`, `open`, `updates`, `floor`, `wrapup` and `done`.

## Binary frames: MVF1

PC screens travel as binary WebSocket messages, from Node to the mod. Each frame starts with a 32-byte
big-endian header, followed by the payload:

| Header field | Meaning |
| --- | --- |
| `kind` | Frame kind |
| `codec` | `1` = JPEG, `2` = RGBA8, `3` = BGRA8 |
| `flags` | Frame flags |
| `pcSlot` | Which PC the frame belongs to |
| `seq` | Sequence number |
| `w`, `h` | Frame size in pixels |
| dirty rect | The region that changed |
| `len` | Payload length in bytes |

**Flow control.** At most 2 unacknowledged frames per PC are in flight, and the latest frame wins. Frames are
skipped while the socket's `bufferedAmount` is above 8 MB. Control messages are never dropped.

## Threading in the mod

- **Receiving.** The listener calls `request(1)` on every `onText` and `onBinary` invocation, partial
  fragments included, and copies each part into a pooled direct buffer.
- **Routing.** Server-world messages run on the integrated server thread (`server.execute`), UI messages on
  the client thread (`Minecraft.getInstance().execute`), and frames on a 2-thread decoder pool.
- **Sending.** One sender thread drains a queue, because only one WebSocket send can be in flight.
