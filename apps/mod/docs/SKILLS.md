# Agent skills in the mod (PLAN 7.3, 7.4)

The integrated server's side of the skill API: how the mod handles `skill.run`, `obs.query` and the other body
messages, and the reflexes around the jobs. Code: `dev.minevibe.agent.skill` (service, bridge handlers,
observations, emitters, seats), `dev.minevibe.agent.job` (jobs) and `dev.minevibe.agent.brain` (reflexes).

**The contract lives in `packages/protocol/protocol.md`**, not here: the wire schemas (§7.3-7.5), the error codes
(§5, including `AGENT_DEAD`, `SPAWN_FAILED` and `UNKNOWN_BLUEPRINT`), the `waitMs` cap of 120 000, lost replies and
the status footer (§7.4), the job failure codes (§7.4.1) and the conventions beyond the schemas (§7.4.2: `goto`
place names, menu-button slots, `smelt`, `collect`, `build` blueprints, `farm`, the mod's agent-id rule). Change
them there first, then here.

## Messages the mod handles

All run on the integrated server thread (`err NO_SERVER` without one).

| Message | Handling |
|---|---|
| `skill.run` | Starts the job, then answers when it ends or when `waitMs` (capped at 120 000) passes. A job still going is answered `running`; its end follows as `skill.result`. Repeating a known `jobId` answers that job's state. A reply still waiting when the bridge reconnects is dropped and the outcome follows as `skill.result`; outcomes of jobs that end while Node is away go out on the next handshake. |
| `skill.progress` | Sent while a job runs, at most once a second per job, when its text changes ("12/20 oak_log"). |
| `skill.cancel` | Cancels the agent's current job (or only `jobId`); each cancelled job also gets `skill.result{cancelled}` unless its `skill.run` was still waiting, which then answers `cancelled`. |
| `obs.query` | `status`, `look_around`, `inventory`, `find`, `recipe`, `recent_events`, `crew`, `list_pcs`, `job_status`, `menu_state`. |
| `agent.spawn` | Spawns or restores the body (idempotent). Without `at` it appears next to the player; `at` also becomes the agent's home. Bodies follow the local player. |
| `agent.despawn` | `dismissed` removes the agent for good; `world_end` / `shutdown` save it. A seat is left first (`pc.unseat`). |
| `agent.mode` | Idle mode `follow` / `stay` / `guard` / `wander`, around `anchor` (default: where it stands). |
| `agent.seat` | Pre-checks, reserves the chair (`coming`), answers `running`, walks and sits (protocol §7.5). The end is `skill.result{jobId}` and, for a PC, `pc.seat{seatEpoch}`. |
| `agent.unseat` | Stands up and sends `pc.unseat{reason, reserved}`; stale epochs are ignored (protocol §7.5). |
| `agent.approach` | Observed (other modules may observe it too): `present` / `queue` drive the Approach reflex, `ping` / `release` stop it. |
| `calendar.fired` | Observed: each agent in `walk` goes to `target` (Attend reflex). |
| `debug.kill_agent`, `debug.set_clock` | Only with `-Dminevibe.e2e=true`. |

Every skill result and observation carries `footer` (protocol §7.4).

## Reflexes (zero tokens, every tick)

Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, Protect 80, SelfDefense 70, Eat 60,
**FeedPlayer 55** (player food ≤ 12: toss food, every 15 s at most), **ShareFood 50** (a teammate at food
≤ 6 with nothing to eat), **UnseatToSurvive 47** (seated, food ≤ 6, no food), **UnseatToFight 45**
(seated, hit by a hostile, HP < 50%), **Approach 40**, **Attend 38**, Job 35, **Shelter 30** (dusk, a home
set, not following the player), **Pickup 25** (loose items within 6 blocks in sight), idle 10.
A seated agent (or one in a vehicle) only runs reflexes at 45 and above, and never Protect,
SelfDefense, FeedPlayer or ShareFood: it stands up only for its own survival (47) or to fight (45). Approach reports `agent.event approach_blocked{why}` (`combat`,
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
