# S1: fake-player agent bodies

Date: 2026-10-08. Minecraft 26.3, Fabric Loader 0.19.5, Fabric API 0.162.0+26.3, Loom 1.18.3, Java 25.
PLAN sections: 7.1 bodies, 7.2 tier-1 pathfinding, 7.3 reflexes, 7.5 seats, 12.1 S1.

**Verdict: PASS.** Carpet-style fake `ServerPlayer` bodies work on 26.3. They spawn with a role skin,
stay out of the tab list, walk 50+ blocks over uneven terrain (doors, swimming, detours), mine at
survival speed, eat, fight, back off from creepers, escape lava, sit (one sitter per chair), persist
across a world reload, and die for good with a grave. Four agents cost about **0.05 ms per agent per
tick**, against a 0.5 ms target. The never-added `NavProxyMob` approach for vanilla A* works.

## How to reproduce

```bash
cd apps/mod
./gradlew build               # compile + JUnit + server GameTests: 17 agent tests, 19 in total (needs the EULA opt-in, see README)
./gradlew runClientGameTest   # opens a window: skins, tab list, reload (about 20 s, exits by itself)
# every agent test prints one line of numbers starting with [S1] on the Gradle console
```

In a dev world with cheats on: `/mv agent spawn Ada ceo`, `/mv agent goto Ada ~10 ~ ~`,
`/mv agent mine Ada <x y z>`, `/mv agent sit Ada <x y z>`, `/mv agent follow Ada`, `/mv agent list`,
`/mv agent kill Ada`.

## What was built

| Area | Where | Notes |
|---|---|---|
| Body | `agent/AgentPlayer` | `extends ServerPlayer`. Tick: brain, navigator, controls, `ServerPlayer.tick()`, `doTick()`. Server-authoritative (`isClientAuthoritative() == false`), not listed in the server status sample. |
| Connection | `agent/AgentConnection`, `agent/AgentNetHandler` | `EmbeddedChannel`, every send is a no-op. The handler ignores idle/flying kicks and server-shutdown disconnects (playerdata is already saved). Installed through `PlayerListMixin` (MixinExtras `@WrapOperation` on the `new ServerGamePacketListenerImpl`). |
| Controls | `agent/AgentControls` | Trimmed Carpet `EntityPlayerActionPack`: use block/item, held attack (survival destroy progress via `START/STOP_DESTROY_BLOCK`), charged melee, jump, drop, swap hands, forward/strafe, look/lookAt, sneak, sprint (only when food > 6). |
| Service | `agent/AgentService`, `agent/AgentRegistry` | Spawn by agent id, giving a stable offline UUID `nameUUIDFromBytes("mv-agent:" + id)`. The game profile carries a `minevibe:role` property. Restore from playerdata on `SERVER_STARTED`; despawn; dismiss; team `mv_agents` (`CollisionRule.NEVER`, no friendly fire); `ALLOW_DAMAGE` friendly-fire filter; graves. The crew list lives in `<world>/minevibe/agents.json`. |
| Nav tier 1 | `agent/nav/*` | `PathFinder(WalkNodeEvaluator, 4000)` on `NavProxyMob`, 40-block waypoints, `PathExecutor`, stuck ladder, `Steering.safeAhead` for paths without A*. |
| Brain | `agent/brain/*` | `ReflexBrain` with Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, ProtectPlayer 80, SelfDefense 70, Eat 60, Job 35, IdleFollow 10 (3 blocks). |
| Jobs | `agent/job/*` | `Job` (start/tick/onPreempt/onResume/cancel), `JobRunner`, `GotoJob`, `MineJob` (best tool, hold attack, pick up drops), `SitJob`. |
| Seats | `world/seat/*` | `minevibe:office_chair` (facing, `kind=pc|meeting`) and invisible `minevibe:seat` (never saved, no gravity, `canAddPassenger` only when empty). Agents sit with the non-forced `startRiding(seat)`. |
| Death | `AgentPlayer#die`, `world/grave/*` | Inventory goes into a `minevibe:grave` block entity. An oak sign above reads "Name / Role / Day N". Vanilla death message and Fabric `AFTER_DEATH` fire, the agent is marked dead, the body is removed on the next tick, and playerdata, stats and advancements are deleted. It never respawns: `spawn` refuses dead ids. |
| Mixins | `mixin/agent/*`, `client/agent/mixin/*` | Tab list (`listed=false`, never REMOVE), sleep quorum, agent join message muted, no chunk packets for agents. Client: `PlayerInfo#getSkin` returns the role skin. |
| Commands | `agent/AgentCommands` | `/mv agent ...`, requires `Commands.LEVEL_GAMEMASTERS`, so it only works where commands are allowed. |
| Assets | `assets/minevibe/...`, `data/minevibe/...` | Placeholder 64x64 role skins (`gen_skins.py`), chair and grave models built from vanilla textures, lang entries, loot tables. |

## Numbers (from `./gradlew build`, GameTest server, M-series Mac)

| Test | Result |
|---|---|
| `agent_paths50_blocks` | 51 blocks straight-line over the `path_course` structure: 1-block hills, a 2-high wall with a side gap, a log, a 2-deep pool across the course (swim), a 2-block drop. Takes **301 ticks (15 s, 3.4 blocks/s)**, 2 plans (40-block waypoints), 36 sprint ticks, 0 poofs, no damage. |
| `nav_plan_benchmark` | 39-block segment, 39 nodes: **1.0 to 1.3 ms average, under 2 ms max**, with a warm JIT. On a cold JIT, the first plans in a run take 3 to 6 ms. |
| `agent_perf_four_agents` | 4 agents patrolling 11-block legs in a 16x16 arena, measured over 300 ticks after 100 ticks of warm-up: **0.034 to 0.062 ms average per agent tick**, worst single tick 0.3 to 0.7 ms. Replans average 0.14 to 0.23 ms. |
| `agent_mines_log_survival_speed` | Oak log with an iron axe picked from slot 5 out of dirt and a wooden pickaxe: **9 ticks**. Vanilla expects 10 (by hand: 60). The drop is picked up. |
| `agent_opens_door` | Oak door opened on the way and **closed behind**. |
| `agent_eats_when_hungry` | Food 4 to 20 eating 2 cooked beef (best food). Bread and rotten flesh untouched. |
| `agent_defends_player` | Zombie targeting a survival stand-in player, agent with an iron sword in slot 3: zombie killed by the agent in **38 to 50 ticks**. Agent ends at 15.5 to 17.8 HP, the player is untouched. |
| `agent_backs_off_from_creeper` | Ignited creeper 2 blocks away: the agent is **8.3 blocks** away at the blast, at full HP. |
| `agent_escapes_lava` | Spawned in a lava pit: the agent climbs out, walks into a water pit 3 blocks away, and the fire goes out. HP 13. |
| `agent_stuck_ladder_poof` | 1-wide corridor blocked by a shulker (A* does not see entities): jump, replan, then **poof** past it, arriving after 109 ticks. |
| `agent_stuck_ladder_fails` | Corridor full of shulkers: the ladder ends in `nav.failed{reason=stuck}`. |
| `seat_single_occupancy` | Agent A walks over and sits. B is rejected by the same chair (one seat entity). After A stands up, B sits on the same seat and is still seated 40 ticks later. |
| `agent_death_grave_no_respawn` | Grave at the death spot with all 9 items, sign "Doomed_xxxx / Day 1". Gone from the player list next tick, playerdata deleted, `spawn` refused, still gone 40 ticks later. |
| `agent_spawns_hidden_from_tablist` | Player-info entry `listed=false` (both the init packet and `UPDATE_LISTED`), profile still sent with the role property. UUID derives from `mv-agent:<id>`. Survival, team `mv_agents`, `CollisionRule.NEVER`. Sleep quorum with 1 human + 1 agent needs 1 sleeper. |
| `friendly_fire_cancelled` | Player to agent, agent to agent (hurt and `Player.attack`), and agent to player are all cancelled. Generic damage still applies. |
| `agent_restores_from_playerdata` | Despawn, then spawn elsewhere: position, health 13, food 11 and inventory come back from playerdata. |
| `agent_places_block` | Cobblestone placed with `useBlock`, one item used (survival). |
| Client test | 3 agents known to the client but not listed (`listed=1` is only the host), and every body wears its role skin ([screenshot](agent-skins.jpg)). After quitting and reopening the world, all 3 agents are restored (miner HP 11, food 10, 5 torches). |

The perf number is the agent's own tick (brain, navigation, controls, `ServerPlayer.tick`, physics). It
does not include what an agent costs the server by existing as a player. See the open issues for
chunk tickets and mob spawning.

## NavProxyMob verdict: works, keep it

- **What it is.** `NavProxyMob extends PathfinderMob` with its own entity type, `minevibe:nav_proxy`:
  0.6 x 1.8, `noSave`, `noSummon`, default mob attributes registered through
  `FabricDefaultAttributeRegistry`. It is never added to a level.
- **One per agent.** Each agent creates one per dimension (the constructor takes an entity id), and
  `syncFrom(agent)` moves it onto the agent before every search.
- **What the evaluator reads.** `WalkNodeEvaluator`/`PathFinder` only use position, `onGround`, bounding
  box, fluid flags, path-type maluses and `getMaxFallDistance()`. The proxy delegates
  `isInWater/isInLava/isInFloatableFluid` to the agent and caps drops at 3. It sets FIRE and POWDER_SNOW
  to -1, damaging and fire neighbours to 16, and water to 4.
- **Doors.** The evaluator runs with `canOpenDoors/canPassDoors/canFloat`. `PathExecutor` opens wooden
  doors with a real right-click and closes them once clear.
- **Cost.** 1 to 2 ms for a 40-block segment with a warm JIT, about once per 40 blocks. The shared
  `ServerLevel#getPathTypeCache()` helps.
- **Limits.** A* ignores entities, which the stuck ladder covers. It cannot dig, pillar or bridge; that
  is tier 2. Planning is synchronous on the server thread.
- **Alternative if needed later.** Copy `WalkNodeEvaluator` and give it a player-backed context. Nothing
  in S1 needs it.

## 26.3 findings worth knowing (not in API_MAP yet)

- **Vehicles must be serializable.** `Entity#startRiding` refuses vehicles whose type cannot serialize
  (`!entityToRide.type.canSerialize()` on the server). So the seat type must not use
  `EntityType.Builder.noSave()`. "Not saved" is `shouldBeSaved() == false` instead.
- **Fresh players are invulnerable.** `ServerPlayer#isInvulnerableTo` is true until the client reports
  "loaded" (60 ticks or `ServerboundPlayerLoadedPacket`). `AgentService` calls
  `connection.handleAcceptPlayerLoad(...)` right after spawning.
- **Players are client-authoritative.** `Player#isClientAuthoritative()` is true, so the server skips
  fall damage and the `onGround` update for players. Agents override it to false, as vanilla's GameTest
  mock players do.
- **Fake connections never tick.** `ServerGamePacketListenerImpl#tick()` (idle kick and the vanilla
  `doTick`) never runs for a fake connection, because it is not in `ServerConnectionListener`. The
  agent calls `doTick()` itself, as Carpet does.
- **Chunk sending stalls without acks.** Without chunk-batch acks, `PlayerChunkSender` sends one 9-chunk
  batch and then stops. `PlayerChunkSenderMixin` skips it entirely for agents, so no chunk or
  entity-tracking packets are ever built for them. Tickets and loading are unaffected.
- **Renamed or reshaped APIs:**
  - `LivingEntity#swing(hand)` is now `swing(hand, SwingAnimation, sendToSwingingEntity)`, with the
    animation from `ItemStack#getAttackAnimation/getInteractAnimation`.
  - Entity type constants live in `EntityTypes`.
  - `PushReaction.BLOCK` is now `IMMOVEABLE`.
  - `ValueInput#read(MapCodec)` is deprecated, but vanilla still uses it for `SavedPosition`.
- **Structure SNBT format.** GameTest structure palettes use `id{prop:value}`, not `id[prop=value]`.
  Files go in `data/<ns>/gametest/structure/<name>.snbt`; see `gen_structures.py`.
- **GameTest timing.** `GameTestHelper#onEachTick` uses `setRunAtTickTime`, which allows one action per
  tick and overwrites `runAfterDelay`. Use `startSequence().thenExecuteFor(...)` for per-tick probes.
  The GameTest server ticks unthrottled: 19 tests take about 2 s.
- **Locator bar.** Agents appear as waypoints on the locator bar above the hotbar (see the screenshot),
  because they are players with a waypoint transmit range.

## Deviations from PLAN / task

1. **Mixin package.** The common mixins live in `dev.minevibe.mixin.agent` (the package
   `minevibe.mixins.json` requires), not under `dev/minevibe/agent/**`. The client mixin is in
   `dev.minevibe.client.agent.mixin` with its own `minevibe.agent.client.mixins.json`, as asked.
2. **Common entrypoint.** It is `dev.minevibe.agent.AgentModInit`, added to `main`, so `MineVibeMod` is
   untouched.
3. **Skin lookup.** The skin is chosen from the `minevibe:role` property on the agent's game profile,
   which travels in the player-info packet. There is no client-side table of agent UUIDs. This also
   tells the client which players are agents.
4. **Agent to player damage.** It is cancelled too, as a hardcore safety net (sweeps, stray arrows).
   The task only asked for player to agent and agent to agent.
5. **Quiet arrivals and exits.** Agents are added and removed without "joined" or "left the game" chat
   lines. Death still prints the vanilla death message.
6. **Extra mixin for performance.** `PlayerChunkSenderMixin` was not in the task list.
7. **Grave sign.** The grave has a real oak sign on top, waxed, with the epitaph. The grave block entity
   stores the same lines. There is no Diary book (PLAN 7.1); it needs the Node-side `memory.md`.
8. **Restore under GameTests.** Restore-on-load is skipped when `fabric-api.gametest` is set, so scratch
   worlds never bring back leftovers. It is covered instead by `agent_restores_from_playerdata` and the
   client reload test.
9. **Extras.** Additional commands (`mine`, `sit`, `follow`, `list`); `SitJob`; `Steering.safeAhead` on
   paths without A* (final approach, melee, creeper backoff); a lingering hazard reflex; protect and
   self-defence never provoke neutral mobs (endermen, zombified piglins).
10. **Extra tests.** Restore, place, nav-plan benchmark, creeper, lava, both stuck-ladder outcomes, and a
    client GameTest (`AgentClientGameTests`). The client test is not part of `./gradlew build`.

## Open issues

- **Agents are real players to the server.** Each holds a player chunk ticket at server view distance,
  counts for mob spawning and simulation distance, and earns advancements. Vanilla announces those in
  chat, and `usercache.json` gets their names. A distant agent keeps an area loaded and spawning. Decide
  before M2 whether to keep this (it is "real survival") or limit it, for example with spawn rules or by
  hiding advancement announcements for agents.
- **Locator bar.** Agents show on it. Hide them by setting `waypoint_transmit_range` to 0, or keep it as
  a crew finder.
- **No death animation.** The body is removed one tick after death, so clients do not see the fall-over
  animation. Delaying removal by about 20 ticks would show it.
- **Seat visuals.** Chair model, seat height and sitting pose were not checked in a client screenshot
  with a seated agent.
- **Reflexes not done in S1.** Edge-sneaking (PLAN 7.2) and the lower reflexes (feed and share food,
  unseat, approach, shelter, pickup) are not implemented. Burning with no water nearby does not take
  control; the fire just burns out.
- **Planning is synchronous.** A* runs on the server thread, 1 to 2 ms warm per 40-block segment. With
  many agents replanning at once, add a per-tick planning budget or async planning.
- **ProtectPlayer is coarse.** It protects the follow target and other agents within 12 blocks. The
  follow target is set by `/mv agent spawn` (the command source) or by tests. It will come from Node
  later.

## Update after the M1 review (2026-10-08)

The open issues above were decided, and review findings on agent bodies fixed (PLAN 7.1):

- **Agents stay real players**: chunk tickets, mob spawning around them, the locator bar and advancements are kept
  (survival-realistic; the crew cap bounds the cost). Their advancement announcements are no longer broadcast, and
  their names stay out of `usercache.json`.
- **Dimension changes**: `AgentPlayer#teleport` clears `isChangingDimension` (Carpet's pattern); before, an agent that
  went through a portal stayed invulnerable for good and could never use a portal again. The End exit portal no longer
  removes an agent forever: `showEndCredits` counts the credits as seen and the portal takes it home.
- **No phantoms**: `TIME_SINCE_REST` is reset every tick (agents never sleep; `PhantomSpawner` counts every player).
- **Graves** no longer replace waterlogged stairs, slabs or fences (they hold a fluid but are real blocks).
- **Dead bodies**: `AgentService#agent` never returns a dead body waiting for removal; removal runs at server stop if
  the death was in the last tick, and dead agents' leftover files are swept at every start and stop.
- **GameTests**: 7 new (`AgentLifecycleGameTests`), 26 in total, all failing without the fixes. The GameTest world now
  has natural monster spawning off: with more agents spawned side by side, a natural creeper or zombie walked into
  `agent_paths50blocks` in 2 of 10 runs.
