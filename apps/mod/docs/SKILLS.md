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
| `hello` | Lists the optional skill features of this build in `caps` (`SkillCaps`): `skill.sequence`, `collect.gather`, `craft.tree`, `obs.recipe.tree`, `container.nearest`, `give.all`, `run.replaced`, `obs.look_around.48`. Node uses an additive argument only when its cap is there. |
| `skill.run` | Starts the job, then answers when it ends or when `waitMs` (capped at 120 000) passes. With `replace` and a job running, the reply's `replaced` names the cancelled job. A job still going is answered `running`; its end follows as `skill.result`. Repeating a known `jobId` answers that job's state. A reply still waiting when the bridge reconnects is dropped and the outcome follows as `skill.result`; outcomes of jobs that end while Node is away go out on the next handshake. |
| `skill.progress` | Sent while a job runs, at most once a second per job, when its text changes ("12/20 oak_log"). |
| `skill.cancel` | Cancels the agent's current job (or only `jobId`); each cancelled job also gets `skill.result{cancelled}` unless its `skill.run` was still waiting, which then answers `cancelled`. |
| `obs.query` | `status`, `look_around` (a scene, `detail` brief or full, radius up to 48), `inventory`, `find` (with provenance, `filter` natural / built), `recipe` (`tree:true`: the craft tree's plan), `recent_events`, `crew`, `list_pcs`, `job_status`, `menu_state`. |
| `agent.spawn` | Spawns or restores the body (idempotent). Without `at` it appears at the office door (the `door` slot of the world's starter office; next to the player in a world without one). Bodies follow the local player. `at`, or the door it appeared at, also becomes the agent's home. |
| `agent.despawn` | `dismissed` removes the agent for good; `world_end` / `shutdown` save it. A seat is left first (`pc.unseat`). |
| `agent.mode` | Idle mode `follow` / `stay` / `guard` / `wander`, around `anchor` (default: where it stands). |
| `agent.seat` | Pre-checks, reserves the chair (`coming`), answers `running`, walks and sits (protocol §7.5). `RESERVED` also answers for 30 s after a kick off that PC. A PC's chair is the chair of its desk; a meeting seat is a free chair of the office's meeting table (else the table nearest the agent), one per walker, and never counts toward `SEAT_CAP`. The end is `skill.result{jobId}` and, for a PC, `pc.seat{seatEpoch}`. |
| `agent.unseat` | Stands up and sends `pc.unseat{reason, reserved}`; stale epochs are ignored (protocol §7.5). |
| `agent.approach` | Observed (other modules may observe it too): `present` / `queue` drive the Approach reflex, `ping` / `release` stop it. |
| `calendar.fired` | Observed: each agent in `walk` goes to `target` (Attend reflex). |
| `debug.kill_agent`, `debug.set_clock` | Only with `-Dminevibe.e2e=true`. |

Every skill result and observation carries `footer` (protocol §7.4); after the position it names the nearest
protected zone (`in Base`, `12m from Base`).

## Composite skills (tools v2)

The v2 `mc` tools (docs/design/tools-v2-mc.md) send one request per intent; the mod runs it as one job. The wire
contract is protocol §6.1 (caps) and §7.4.2.

- **`sequence`** (`SequenceJob`): 2-8 skills as one job. `SkillFactory` builds every step first (a bad one rejects
  the request: `BAD_ARGS: step i: …`); the steps then run through a `ChildRunner`, which gives each child the
  lifecycle the `JobRunner` would (start, preempt, resume, cancel, `onEnd` once). `stop_on_fail` (default true) ends
  it at the first failure with that step's code. Result: `{completed, steps:[{skill, status, code?, msg?, result}]}`.
- **The craft tree** (`CraftTreeJob`, `RecipeTree`): `craft{tree:true}` plans from the inventory with the server's
  recipes (`Recipes.book`), gathers what is missing when `gather_missing` (child `collect` jobs, natural only, logs
  for fuel), then runs child `craft` / `smelt` jobs step by step. It crafts a table or furnace first when none is
  within 24 blocks or carried, and walks out of a protected zone before one is put down. `RecipeTree` is pure (unit
  tested with a hand-written book): fewest missing raw materials wins, 2x2 first, at most 4 levels, no recipe that
  consumes an item being made higher up, no compressed form (iron block, nuggets) the agent does not carry, fuel
  from what the plan leaves over. `recipe{tree:true}` answers the same plan without acting.
- **`collect` for v2's gather**: `near` (search around a spot), `make_tools` (craft the tool a source needs from the
  inventory, iron then stone then wooden tier, through `CraftTreeJob`), animals for drops (cows, pigs, sheep,
  chickens, rabbits: never in a protected zone, never pets, named, leashed or young animals), and `result.sources`
  (`Miner.Source`: felled trees by species and trunk, ores and stone by kind). Drops are picked up within 5 blocks for
  up to 100 ticks after each break (was 3.5 and 40, which lost items).
- **`container`** without `pos` takes the nearest chest or barrel within 24 blocks and says which (`result.pos`);
  **`give`** without `count` gives everything of the item.

## World awareness and protection (W1)

What the agents know about the world around them, and what they must leave alone. The wire contract (`PROTECTED`,
`NO_NATURAL_SOURCE`, `skill.run.consent`, the `look_around` scene, `find` filters) is in protocol §7.4.1 and §7.4.2.

- **Block provenance** (`dev.minevibe.world.provenance`). `BlockItemMixin` wraps `BlockItem#place` for server
  players, so every block a player or an agent places through an item (both halves of doors and beds included) is
  recorded with its owner: `Owner.player` (UUID and name), `Owner.agent` (agent id), or `Owner.base` for what
  `OfficeBuilder` builds. `LevelChunkMixin` sees every change of a server chunk (`LevelChunk#setBlockState`): a new
  block set while someone places is marked, a marked block that turns into air or a fluid loses its mark, and a block
  that only changes in place (a door opening, copper weathering, a log stripped) keeps it. Crops, stems, saplings,
  berry bushes, cocoa, nether wart and fire are never marked. The marks (`ChunkMarks`, one int per block plus a short
  owner list) are a persistent Fabric data attachment (`minevibe:provenance`) saved with the chunk.
- **Zones** (`Zones`). The Base is the starter office's box (foundation top to roof, porch included) plus a 2-block
  margin, provided by `OfficeZone` from the world's office. Named zones live in `<world>/minevibe/zones.json`
  (`/mv zone add|remove|list`); `Zones.addProvider` adds computed ones.
- **Protection** (`Protection`). Agents never change player-built blocks or anything inside a zone; blocks agents
  placed are theirs. Jobs check first and fail with `PROTECTED` (the teaching line, the owner, a consent offer):
  `mine`, `collect`, `dig` (the whole box first), `place` over a protected plant, `build`, `farm` (till, harvest,
  bone meal), `use_item` (tools that till or strip, buckets, fire), `attack` on item frames, paintings and armor
  stands, `container{take}` and `menu_click` in a chest the player placed (either half of a double chest; the
  office's own chest is shared).
  `ProtectionGuard` is the backstop for any code driving an agent's hands: `PlayerBlockBreakEvents.BEFORE`,
  `UseBlockCallback` and `UseItemCallback` refuse protected changes for agents and remember the refusal (`use_block`
  and `use_item` report it as `PROTECTED`).
  - A **natural block counts as the player's** when breaking it would harm their build: it holds up a protected
    block (the ground under their torch, door, rail, carpet, sand or wall, the stone behind their ladder or wall
    torch, the ceiling their lantern hangs from), or it is the floor under their roof (the first solid block above
    it, at most 6 up, is theirs). Only that one layer: the ground below it is free.
  - **Fire and lava** (flint and steel, fire charges, lava buckets) are refused within 5 blocks of a protected block,
    whatever they are aimed at (TNT next to a house included), and so is placing TNT there.
  - **Right-clicks** that take from or retune a protected block are refused (`use_block`, `use_item` and the guard):
    flower pots, lecterns, chiseled bookshelves, shelves, jukeboxes, decorated pots, cakes, candles, repeaters,
    comparators, daylight detectors, note blocks, respawn anchors. Doors, levers, chests and workstations work as
    usual. `menu_click` knows whose container a menu shows however it was opened (`AgentControls#useBlock` records
    every menu a right-click opens).
  - **`build`** refuses walls, roofs, clearing and water inside a zone even where they only fill air (a `wall_ring`
    in the office); torches are fine. A `farm_plot`'s field that holds protected soil fails the build with the
    field's `PROTECTED`.
  - **Pets**: `hunt` and `attack` never target tamed or name-tagged animals or golems a player built (`attack` on
    one: `BAD_TARGET`; by kind it takes the nearest one that is nobody's).
- **Consent** (`Consents`). A `PROTECTED` failure offers a 32-hex token bound to the agent and the box of the
  protected blocks, valid 10 minutes, single use. `skill.run{args.allow_protected:true, consent:{token}}` redeems it
  (else `BAD_ARGS`) and the job runs with a grant `Protection` honours inside that box until the job ends.
  `allow_protected` alone does nothing; Node attaches `consent` only after the player agreed. Every skill that can be
  refused takes it, right-clicks (`use_block`: the player's pot) and menu clicks (`menu_click`: their chest) included.
- **Natural resources** (`agent.perception`). Tags leave out building variants (`Sources.naturalTag`: stripped logs,
  wood, hyphae, planks); `collect` of planks, stripped logs or wood finds nothing in nature (`NO_NATURAL_SOURCE`:
  craft them). Requests for logs work on natural trees (`Trees`: log clusters touching non-persistent leaves, nobody's
  blocks, and no building block: planks, glass, doors, trapdoors, stairs, slabs, fences, gates, walls, wool, beds,
  bricks, cobblestone, chests, barrels, crafting tables, furnaces, bookshelves. A log cabin is never a tree, even in a
  world from before provenance and even when a real tree grows against it; the whole cluster is searched once):
  `Miner` picks the nearest tree the agent can walk to (`Reach`: one A* per tree; with no walking way to any, the
  nearest tree for Tier 2 to dig, pillar or bridge to, unreachable if it finds no way either), fells it bottom-up (each
  log reached with Tier 2; failing that, stepping into the cut trunk, pillaring at most 2 blocks with dirt or
  cobblestone; every pillar cleared),
  picks up the logs at the stump and replants on request. Nothing natural in reach: `NO_NATURAL_SOURCE` with the
  candidates it saw (unreachable, too far, protected, not a tree); it never substitutes another block.
- **Perception** (`Scene`). `look_around` answers a scene, most important first: position, cover and time; the zone;
  hazards; natural trees with trunk, distance, compass direction and reachability; what players and agents built
  (clusters of marks); people (a player with whether they stand in a zone and under a roof, leaves not counting:
  `Jasper (player) 4m S, in Base, under cover`, or `…, in the open`); water, exposed ores, crops; terrain. Brief ≤ 900
  characters, full ≤ 2500. `find` labels block matches with their provenance, tree and reachability, and filters
  `natural` / `built`.

## Reflexes (zero tokens, every tick)

Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, Protect 80, SelfDefense 70, Eat 60,
**FeedPlayer 55** (player food ≤ 12: toss food, every 15 s at most), **ShareFood 50** (a teammate at food
≤ 6 with nothing to eat), **UnseatToSurvive 47** (seated, food ≤ 6, no food), **UnseatToFight 45**
(seated, hit by a hostile, HP < 50%), **Approach 40**, **Attend 38**, Job 35, **Shelter 30** (dusk, a home
set, not following the player), **Pickup 25** (loose items within 6 blocks in sight), idle 10.
A seated agent (or one in a vehicle) only runs reflexes at 45 and above, and never Protect,
SelfDefense, FeedPlayer or ShareFood: it stands up only for its own survival (47) or to fight (45). Approach reports `agent.event approach_blocked{why}` (`combat`,
`night`, `far`, `dimension`, `pc_screen`) once and stays put, so Node can fall back to a ping.

## Navigation (PLAN 7.2)

Jobs walk through `dev.minevibe.agent.job.Walk`, which drives `dev.minevibe.agent.nav.AgentNavigator`:

| Walk call | Used by | Navigation |
|---|---|---|
| `toMine(block)` | `mine`, `collect` (`Miner`) | Tier 2 straight away: a cell with the block in hand reach and a face open toward the eyes, beside, above or below it, never standing on it. Cells are planned by their middle (3.75 blocks), so it arrives only once the eyes are within 4.0 of the block, stepping to the middle of the last cell (crouched) when it entered at the far edge |
| `toTrunk(log)` | (for tree jobs) | Tier 2: any standable cell next to the trunk, at any height a pillar reaches |
| `toBlock(block)` | `craft`, `place`, `use_block`, `build`, `farm`, menus | Tier 1, then Tier 2 if it finds no way |
| `toDig(point)` | `goto` (`pos`, places) | Tier 1, then Tier 2 if it finds no way |
| `toItem(pos)` | drops after mining, `collect`'s loose items, `pickup` | Tier 1, then Tier 2 to anywhere the pickup box reaches the item (a drop caught in leaves) |
| `to(point)`, `toEntity` | `hunt`, `give`, beds, seats | Tier 1 only: mobs and people move, and are never dug for |

A job's walks share one navigator: `Walk.stop()` (a walk arrived, the job acts) stops whatever still moves the body,
so a walk left running for a vanished item never keeps digging while the job works. A walk asked for the same block
more than 8 times without getting there gives up (`no_progress`). Reflexes call the navigator directly and stay on
Tier 1. Tier 2 (`DigPathPlanner`) breaks natural blocks nobody placed and the scaffold agents placed to get somewhere
only (`NavBlocks.mayBreak`: never a crew build, never the office, never a block with a block entity, never what
`Protection.check` protects), pillars and bridges with dirt or cobblestone from the bag (into empty cells or
replaceable plants nobody placed, never inside a protected zone), and never digs straight down, opens a block next to
water or lava, or takes a drop whose landing went away since the plan. Felling a tree, the miner clears the pillars
Tier 2 built for that job (`AgentNavigator.drainPlacedPillars`; those of earlier walks stay). It plans within 1.5 ms
per tick per agent. Its plans
are logged as `[agent <id>] nav.dig {steps, breaks, places, nodes, ms}`; `mine` and `collect` results carry
`unreachable` (targets given up on). With `MINEVIBE_NAV_DEBUG=1` (or `-Dminevibe.navDebug=true`) every failed walk logs
`[nav]` lines and a terrain map around the agent and its goal.

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
  `pc.unseat`). `PcModInit` installs `dev.minevibe.pc.PcSeatRegistry` with `Seats.installPcRegistry(...)`:
  - chairs come from the desks (`pc.PcRegistry.chairOf`); `/mv pcbind <pcId> <chair pos>` still binds a
    chair by hand (it extends `SimplePcRegistry`), and a desk wins over a hand-bound chair;
  - statuses come from `pc.state` through a `PcStates` listener (`PcBridge` owns the handler), falling back
    to what `PcStates` holds;
  - `kick(server, pcId)` calls `agent.brain().noteStand("kick")` before dismounting, so the seat bookkeeping
    sends `pc.unseat{kick}` and a `kicked` event (urgency 2); it steps the agent aside and blocks a re-sit at
    that PC for 30 s. Node's own `agent.unseat{kick}` (the Kick buttons) steps the agent aside and starts the
    same cooldown. "Kick Bram and sit?" (right-clicking an occupied PC chair) runs `kickAndSit`. A meeting seat
    is never kicked;
  - the player sitting down on a chair kept for an agent ends that reservation. For an agent away asking the
    player (`away`) that is `pc.unseat{player_took}`, sent before the player's `pc.seat` (Node's SeatFSM leaves
    `away_from_seat` on it); an agent walking there (`coming`) gets `OCCUPIED_BY_PLAYER` from its seat job;
  - a desk whose chunk unloads is remembered for the session (`pc.PcRegistry.chairOf`), so `agent.seat` far
    from the office walks there instead of answering `PC_UNKNOWN`; removing the desk forgets it;
  - `pcIds` also lists PCs that only a reservation names, so the once-a-second sweep still sees them.
  An agent seated at a PC and sent to a meeting chair (`agent.seat{meeting}`) leaves the PC with
  `pc.unseat{meeting}`.
  Meeting seats are never PC seats: `pc.PcRegistry.pcSeatedAt`, PcControlScreen and the head icon check the
  seat entity's kind, which is synced to clients and follows the chair.
- **Meeting chairs**: `OrgModInit` installs `org.meeting.MeetingSeatProvider` with
  `Seats.installMeetingSeats(...)` (`MeetingSeats.findFreeChair` with the chairs other walkers claimed left out).
- **Bridge**: `BridgeClient#handleAsync` (reply when a future completes) and `BridgeClient#observe`
  (several listeners for one push) were added for this layer.

## Dev commands (worlds with commands on)

```
/mv skill <agent> <skill> [args json]      /mv obs <agent> <query> [args json]
/mv mode <agent> <mode>                    /mv approach <agent> <role>
/mv pcbind <pcId> <x y z>                  /mv sit <agent> <pcId>     /mv stand <agent>
/mv provenance <x y z>                     /mv zone list
/mv zone add <name> <from> <to>            /mv zone remove <name>
```
