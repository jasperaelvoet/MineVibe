# Agent skills in the mod (PLAN 7.3, 7.4)

The integrated server's side of the skill API: what the mod does with `skill.run`, `obs.query` and the
other body messages, which failure codes a job can end with, and the reflexes around the jobs. Code:
`dev.minevibe.agent.skill` (service, bridge handlers, observations, emitters, seats),
`dev.minevibe.agent.job` (jobs) and `dev.minevibe.agent.brain` (reflexes). The wire schemas are
`packages/protocol` (protocol.md §7.3-7.5).

## Messages the mod handles

All run on the integrated server thread (`err NO_SERVER` without one).

| Message | Handling |
|---|---|
| `skill.run` | Starts the job, then answers when it ends or when `waitMs` passes, whichever comes first. `waitMs` is capped at 120 000 (the tools' `wait_s` ≤ 120). A job still going is answered `running`; its end follows as `skill.result`. Errors: `UNKNOWN_AGENT`, `UNKNOWN_SKILL`, `BAD_ARGS`, `BUSY` (a job runs and `replace` is false), `UNKNOWN_BLUEPRINT`. Repeating a known `jobId` answers that job's state. |
| `skill.progress` | Sent while a job runs, at most once a second per job, when its text changes ("12/20 oak_log"). |
| `skill.cancel` | Cancels the agent's current job (or only `jobId`); each cancelled job also gets `skill.result{cancelled}` unless its `skill.run` was still waiting, which then answers `cancelled`. |
| `obs.query` | `status`, `look_around`, `inventory`, `find{what, radius?, limit?}`, `recipe{item}`, `recent_events{limit?}`, `crew`, `list_pcs`, `job_status{jobId?}`, `menu_state`. |
| `agent.spawn` | Spawns or restores the body (idempotent). Without `at` it appears near the player (Node sends the office door as `at`). Bodies follow the local player. `at` also becomes the agent's home (shelter at dusk). Errors: `BAD_ARGS` (ids are `[a-z][a-z0-9_]{0,15}` in the mod), `AGENT_DEAD`, `SPAWN_FAILED`. |
| `agent.despawn` | `dismissed` removes the agent for good; `world_end` / `shutdown` save it. A seat is left first (`pc.unseat`). |
| `agent.mode` | Idle mode `follow` / `stay` / `guard` / `wander`, around `anchor` (default: where it stands). |
| `agent.seat` | Pre-checks (`PC_UNKNOWN`, `PC_DOWN`, `SEAT_CAP` with 2 agents at PCs, `OCCUPIED_BY_PLAYER`, `RESERVED`, `NO_SEAT` for meetings), reserves the chair (`coming`), answers `running`, walks and sits. The end is `skill.result{jobId}` (failures: `UNREACHABLE`, `OCCUPIED_BY_PLAYER`, `RESERVED`, `PC_DOWN`, `NO_SEAT`) and, for a PC, `pc.seat{seatEpoch}`. |
| `agent.unseat` | Stands up (an older `seatEpoch` is ignored: `ok{ignored: true}`), sends `pc.unseat{reason, reserved}`; `keepReservation` keeps the chair (`away`). Not seated: releases the agent's reservations unless `keepReservation`. |
| `agent.approach` | Observed (other modules may observe it too): `present` / `queue` drive the Approach reflex, `ping` / `release` stop it. |
| `calendar.fired` | Observed: each agent in `walk` goes to `target` (Attend reflex). |
| `debug.kill_agent`, `debug.set_clock` | Only with `-Dminevibe.e2e=true`. |

Every skill result and observation ends with `footer`, a ~25-token status line:
`HP 18/20 food 15 | day 3 08:12 | 120 64 -80 overworld | collect 12/20 oak_log | iron_sword`.

## Conventions beyond the schemas

- **Places in `goto`.** `entity` may name a place: `office` / `home` (the agent's home: its spawn point
  or the bed it last slept in; else world spawn), `spawn`, the nearest `bed`, `chest`,
  `crafting_table`, `furnace`, or `pc:<id>` (that PC's chair).
- **Menu buttons.** `menu_click{slot}` keeps vanilla slot numbers (`-999` = outside the window). A
  `slot` of `-2` or less presses menu button `-slot - 2`: a merchant's trade offer (then take slot 2),
  an enchanting option (`-2`, `-3`, `-4`), a stonecutter recipe. `menu_state` lists the button numbers.
- **`smelt.item`** is what goes in (`raw_iron`) or what should come out (`iron_ingot`).
- **`collect`** picks up loose items first, then breaks blocks that drop the item (the item's own
  block or tag, plus stone → cobblestone, ores → raw metals and gems, gravel → flint, grass → seeds).
- **`build`** blueprints: `shelter` (5x5, door gap facing north at rotation 0, roof), `wall_ring`
  (9x9, 2 high), `torch_ring` (8 torches 5 blocks out), `bridge` (8 blocks ahead at foot level),
  `stairs_down` (8 steps down, ahead), `farm_plot` (water in the middle, 9x9 tilled and planted).
  "Ahead" is south (+Z) at rotation 0; rotations turn clockwise. Walls take any plain full block
  (dirt, cobblestone, planks...); the job checks the material first (`NO_MATERIAL`).
- **`farm`** repeats passes over the box until nothing is left: harvest ripe crops, till dirt and grass
  (with a hoe, when there are seeds), plant empty farmland, bone-meal growing crops.

## Job failure codes

`skill.result.error.code` / the `error` of a `skill.run` reply:

| Code | Meaning |
|---|---|
| `NOT_FOUND` | Nothing to work on in range (no such block, mob, item, entity or place); partial counts are in `result`. |
| `UNREACHABLE`, `OTHER_DIMENSION` | No path / the target is in another dimension. |
| `NO_ITEM`, `NO_FOOD`, `NO_FUEL`, `NO_MATERIAL` | The inventory lacks what the skill needs. |
| `MISSING_INGREDIENTS`, `NO_RECIPE`, `NEEDS_TABLE`, `NEEDS_FURNACE`, `FURNACE_BUSY` | Crafting and smelting. `result.ingredients` lists need/have. |
| `NEEDS_TOOL` | The block would drop nothing without the right tool. |
| `OCCUPIED`, `NO_SUPPORT`, `BLOCKED`, `CANNOT_PLACE`, `NO_ROOM` | Placing blocks. |
| `NOT_HUNGRY`, `CANNOT_EAT` | Eating. |
| `NO_BED`, `NOT_NIGHT`, `NOT_SAFE`, `OBSTRUCTED`, `CANNOT_SLEEP_HERE` | Sleeping (`CANNOT_SLEEP_HERE`: beds explode in this dimension). |
| `BAD_TARGET`, `ESCAPED` | Players and agents are never attacked; the mob got away. |
| `NOT_A_CONTAINER`, `NO_MENU`, `BAD_CLICK`, `BAD_SLOT` | Containers and menus. |
| `SEATED`, `SEAT_EXCLUDED`, `NOT_RIDEABLE` | The body sits (stand up or dismount first); chairs are for `agent.seat`. |
| `INVENTORY_FULL` | No room for what was gathered or crafted. |
| `TIMEOUT` | The job ran past its limit (counted only while it had control). |
| `INTERRUPTED` | Cancelled: replaced, `skill.cancel`, the agent died or left (`msg` says which). |

A higher reflex (danger, combat, eating, approach, attend) pauses a job; the job resumes afterwards.

## Reflexes (zero tokens, every tick)

Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, Protect 80, SelfDefense 70, Eat 60,
**FeedPlayer 55** (player food ≤ 12: toss food, every 15 s at most), **ShareFood 50** (a teammate at food
≤ 6 with nothing to eat), **UnseatToSurvive 47** (seated, food ≤ 6, no food), **UnseatToFight 45**
(seated, hit by a hostile, HP < 50%), **Approach 40**, **Attend 38**, Job 35, **Shelter 30** (dusk, a home
set, not following the player), **Pickup 25** (loose items within 6 blocks in sight), idle 10.
A seated agent (or one in a vehicle) only runs reflexes at 45 and above, and never Protect or
SelfDefense: it stands up to fight at 45. Approach reports `agent.event approach_blocked{why}` (`combat`,
`night`, `far`, `dimension`, `pc_screen`) once and stays put, so Node can fall back to a ping.

## Body messages

- `agent.state`: one message a second for the whole crew (mode, vitals, food in the bag, combat, reflex,
  skill job with progress, seat, distance to the player, held item).
- `agent.event`: `hurt` (0/1), `hp_critical` (2), `starving` (2), `ate`, `killed`, `reflex` (1 for hazard,
  creeper, flee, critical heal), `stuck` (1), `unseated` (1, or 2 for survival/damage), `kicked` (2),
  `player_low_hp` (2, to the nearest agent), `dimension_changed`, `arrived`, `approach_blocked` (1),
  `fed_player`, `shared_food`, `picked_up`. Repeats of a kind are throttled per agent.
- `agent.died`: re-sent until acknowledged.
- `world.state.clockTime` comes from the server's overworld clock (`WorldClock`), right in every
  dimension.

## Integration points

- **PC chairs**: `PcRegistry` (`agent.skill.seat`) is what seats need from the PC blocks: chair per PC,
  status from `pc.state`, occupant, reservations, `onSeated` / `onUnseated` (which send `pc.seat` /
  `pc.unseat`). The PC blocks install theirs with `Seats.installPcRegistry(...)`; until then
  `SimplePcRegistry` serves (`/mv pcbind <pcId> <chair pos>`). A kick should call
  `agent.brain().noteStand("kick")` before dismounting so the unseat reports `kick`.
- **Meeting chairs**: `Seats.installMeetingSeats((server, meetingId, agentId) -> chair)`.
- **Bridge**: `BridgeClient#handleAsync` (reply when a future completes) and `BridgeClient#observe`
  (several listeners for one push) were added for this layer.

## Dev commands (worlds with commands on)

```
/mv skill <agent> <skill> [args json]      /mv obs <agent> <query> [args json]
/mv mode <agent> <mode>                    /mv approach <agent> <role>
/mv pcbind <pcId> <x y z>                  /mv sit <agent> <pcId>     /mv stand <agent>
```
