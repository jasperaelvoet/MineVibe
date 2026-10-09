# MC tools v2: fewer, composite, token-efficient `mcp__mc__*` tools

Status: design spec (task A1), implemented (track B1) and the default since phase C (track P1, 2026-10-09);
`MINEVIBE_MC_TOOLS=v1` keeps v1 as a fallback. Date: 2026-10-09.
Where the implementation differs from or goes beyond this spec: section 16 (16.10: the after-v2 eval fixes).
Scope: the `mc` in-process MCP server used by every agent session (wandering on Haiku 5.5 at xhigh, seated on Opus 5.5 at medium).
Code: apps/server/src/agents/tools/{mcServer,catalog,results}.ts, apps/server/src/contracts/SkillApi.ts, packages/protocol/src/messages/skills.ts, apps/mod `dev.minevibe.agent.{skill,job}`.
Related: PLAN §6.2 (ToolGate), §6.5 (footer, wakes, long jobs), §7.4 (skill API); protocol.md §7.4, §7.4.1, §7.4.2; apps/mod/docs/SKILLS.md.
Depends on the world-awareness workflow (wf_d), in progress when this spec was written and merged before the implementation (§16):
- **W1 (mod):** block provenance and protected Base, natural-resource targeting, rich `look_around`/`find`, PROTECTED and NO_NATURAL_SOURCE.
- **W2 (Node):** world primer, location digest, consent tokens, `npm run eval:world`.

v2 builds on those contracts as they were briefed. Names to reconcile after they merge are in §15. v2 does not duplicate them.

---

## 0. Summary

| | v1 (today) | v2 |
|---|---|---|
| mc tools | 54 | 20 (16 always loaded and 4 deferrable, once deferral is verified) |
| Tool-list size (name+description+input_schema JSON) | 28,204 chars ≈ 7.05k tok | ≈16.0k chars ≈ 4.0k tok (−43%); core 11.7k ≈ 2.9k tok |
| Share of the list that is description (teaching) | 14% (3.8k chars) | 37% (6.0k chars) |
| Incident "collect 10 oak logs and make a crafting table" | 8 calls over 2 turns, 2.5k chars of results, house damaged, no table | 1–2 calls in 1 turn plus a [JOB DONE] wake, about 1.3k chars, natural trees only |
| Result format | raw JSON (≤8k), 200-char JSON job summaries | text lines, rounded numbers, capped lists, `next:` hints |
| Job model | `wait_s` on 27 tools, plus `job_status`, `wait` and `stop` | fixed 20 s answer; `job{status\|wait\|stop}`; one formatter for results and wakes |
| Protocol | — | additive: `sequence` skill, extended `collect`/`craft`/`container`/`give`/`obs recipe` args, `hello.caps` |

---

## 1. Audit of v1

### 1.1 Where things live

| What | Where |
|---|---|
| mc server (54 tools, `alwaysLoad: true`, 600 s timeout) | apps/server/src/agents/tools/mcServer.ts |
| Tool catalog plus gate categories | apps/server/src/agents/tools/catalog.ts (`MC_TOOLS`) |
| Result helpers (`textResult`, `compactJson` ≤8k, `withFooter`, `waitMs`) | apps/server/src/agents/tools/results.ts |
| pc server (20 tools, also `alwaysLoad`) | apps/server/src/agents/tools/pcServer.ts |
| Gate (PreToolUse) | apps/server/src/agents/ToolGate.ts (`decideMc`, one category per tool) |
| SkillApi (`skill.run`, `obs.query`, `awaitJob`) | apps/server/src/contracts/SkillApi.ts; fake: FakeSkillApi.ts |
| Wire schemas (`SKILL_NAMES`, `SkillArgs`, `OBS_QUERIES`) | packages/protocol/src/messages/skills.ts; protocol.md §7.4 |
| Job summaries and [JOB DONE] | apps/server/src/agents/EventRouter.ts (`summarizeResult`, `jobEnded`) |
| `wait`, `trackJob`, Node footer | apps/server/src/agents/AgentBrain.ts (McHost ~1735–1800, `statusFooter`) |
| Mod skill entry, arg checks, radius caps | apps/mod/.../agent/skill/SkillFactory.java |
| Observations | apps/mod/.../agent/skill/Observations.java |
| Jobs | apps/mod/.../agent/job/{GatherJobs,Miner,MineJob,CraftJobs,Recipes,WorldJobs,MenuJobs,BuildJob,FarmJob}.java |
| Footer | apps/mod/.../agent/skill/StatusFooter.java |
| Named places for `goto{entity}` | apps/mod/.../agent/skill/Places.java |

### 1.2 The 54 tools

Legend: Gate = `MC_TOOLS` category (always / world / sit / stand / hire / codex_read / codex_write / calendar). RO = `readOnlyHint` annotation. Claude Code runs RO MCP tools concurrently: `isConcurrencySafe(){return mayOverlap||(annotations?.readOnlyHint??!1)}`, verified in the bundled CLI binary. `pos` = `{x,y,z}` int32 object (282 chars of schema each time). Every world tool except `set_mode` and `stop` also takes `wait_s?: number 0-120`; it is listed once here.

| Tool | Gate | Args | Description (verbatim) |
|---|---|---|---|
| `status` | always RO | — | Your body: health, food, position, held item, current job, mode. |
| `look_around` | always RO | radius?: int 1-64 | What is around you: blocks of note, mobs, players, items, light. |
| `inventory` | always RO | — | Your inventory and equipment. |
| `find` | always RO | what: string, radius?: int 1-128 | Find the nearest blocks, entities or items of a kind, e.g. {what:"iron_ore"}. |
| `recipe` | always RO | item: string | How to craft or smelt an item. |
| `recent_events` | always RO | limit?: int 1-50 | What happened to you recently (reflexes, pickups, damage). |
| `crew` | always RO | — | Where the crew and the player are and what they do. |
| `list_pcs` | always RO | — | The office PCs: id, type, status, who sits there. |
| `job_status` | always RO | job_id?: string | Status of a job (your current one when job_id is absent). |
| `menu_state` | always RO | — | The open menu: slots and their items. |
| `set_mode` | always | mode: follow\|stay\|guard\|wander, anchor?: pos | Set your idle behaviour between jobs: follow (the player), stay, guard (an area) or wander. |
| `stop` | always | — | Stop your current job. |
| `goto` | world | pos?, entity?: string, place?: string, range?: 0-64 | Walk to a block position {pos}, an entity {entity: "player" \| agent id \| mob type}, or a named Codex place {place}. A job. |
| `mine` | world | block: id/#tag, count: 1-2304, near?: pos, radius?: 1-64 | Mine blocks of a kind (block id or #tag) nearby, e.g. {block:"oak_log", count:10}. A job. |
| `collect` | world | item, count: 1-2304, radius?: 1-64 | Collect items of a kind from the world (mine, pick up) until you hold count. A job. |
| `hunt` | world | entity, count: 1-64, radius?: 1-64 | Hunt mobs of a kind (e.g. "minecraft:cow"), count of them. A job. |
| `dig` | world | from: pos, to: pos | Dig out every block in the box from..to (inclusive). A job. |
| `place` | world | block, pos | Place one block from your inventory at pos. |
| `use_block` | world | pos | Use (right-click) the block at pos: doors, levers, beds, chests. |
| `use_item` | world | item?, pos?, entity? | Use your held item, or the given item, optionally on a block or entity. |
| `attack` | world | entity | Attack an entity until it dies or flees. A job. |
| `equip` | always | item, slot?: mainhand\|offhand\|head\|chest\|legs\|feet | Equip an item into a slot (default main hand). |
| `eat` | always | item? | Eat food now (the given item, or the best food you have). |
| `sleep` | world | pos? | Sleep in a bed (nearest, or at pos) when it is night. |
| `pickup` | world | item?, radius?: 1-32 | Pick up dropped items nearby. |
| `drop` | world | item, count? | Drop items from your inventory. |
| `give` | world | item, count, to | Give items to an entity (the player is "player", agents by id). Walks over first. A job. |
| `craft` | world | item, count, table?: pos | Craft count of an item with a real crafting menu (uses a table nearby or at table when needed). A job. |
| `smelt` | world | item, count, fuel?, furnace?: pos | Smelt count of an item in a furnace (nearest, or at furnace). A job. |
| `container` | world | pos, action: list\|put\|take, item?, count? | List, put into or take from a container block at pos. |
| `open_menu` | world | pos?, entity? | Open the menu of a block or entity (villager trading, enchanting, anvil, …). Then use menu_state and menu_click. |
| `menu_click` | world | slot: -999-255, button: 0-40, type: pickup\|quick_move\|swap\|clone\|throw\|quick_craft\|pickup_all | Click a slot of the open menu: {slot, button, type}. |
| `menu_close` | world | — | Close the open menu. |
| `build` | world | blueprint, origin: pos, rotation?: 0\|90\|180\|270 | Build a blueprint (built-in id or a Codex page id) at origin. A job. |
| `farm` | world | from, to, crop? | Till, plant and harvest the farmland in the box from..to. A job. |
| `ride` | world | entity | Ride an entity (boat, minecart, horse). Not office chairs: use sit_at_pc. |
| `dismount` | world | — | Get off what you ride. |
| `emote` | always | kind: wave\|nod\|shake_head\|point\|cheer\|facepalm | Play an emote: wave, nod, shake_head, point, cheer, facepalm. |
| `sit_at_pc` | sit | pc, purpose | Walk to a PC and sit down to work on it (shell, files, screen). Say what for in purpose. When it says "Seated", end your turn: your PC session starts next turn. |
| `stand_up` | stand | — | Stand up from your PC (or leave the chair you walk to). |
| `say` | always | text | Say something out loud now (a bubble above your head), without ending your turn. |
| `tell` | always | to, text | Send a short message to one crew member (by @handle, name or "ceo"). It reaches only them. |
| `remember` | always | note | Write a note to your private long-term memory (memory.md). Keep it short; it is re-read after restarts. |
| `wait` | always | seconds: 1-120, job_id? | Wait a while (at most 120 s), or until a job ends. Prefer ending your turn for long waits. |
| `request_hire` | hire | role, name?, reason, first_task | CEO only: ask the player to hire a new crew member. Returns at once; you get [HIRE DECISION] later. |
| `codex_search` | codex_read RO | query, tags?, category? | Search the shared Codex (notes written by the crew and the player). Returns the top 8 snippets. |
| `codex_read` | codex_read RO | id | Read one Codex page with its revision (pass it as base_rev to update). |
| `codex_write` | codex_write | mode, title, body, tags?, category, scope, id?, base_rev?, here? | Write to the shared Codex: mode create (new page), update (replace body; needs id and base_rev) or append (add to the end; needs id). Set here:true on a places page to stamp your position. |
| `codex_list` | codex_read RO | category?, tag? | List Codex pages, optionally by category or tag. |
| `calendar_list` | calendar RO | from?, to?, agent? | List calendar events (tasks, reminders, meetings), optionally for one agent. |
| `calendar_add` | calendar | title, kind, assignees, clock, when, recurrence?, duration_min?, location?, task?, catch_up?, run_while_away? | Schedule a task, reminder or meeting. when: "now", "Day 3 06:00" (game clock) or an ISO date (real clock). assignees: agent ids or "all" (only the CEO schedules for others). |
| `calendar_update` | calendar | id, title?, assignees?, when?, clock?, recurrence?, duration_min?, location?, task? | Change an event you may edit (not events the player created). |
| `calendar_cancel` | calendar | id, scope?: next\|all | Cancel an event (scope "all") or only its next occurrence ("next"). |
| `report_task` | calendar | event_id, status, note? | Close a scheduled task occurrence: done, failed or blocked (failed and blocked wake the CEO). |

### 1.3 v1 result format and footer

- **Observation:** `compactJson(result)` (raw mod JSON, capped at 8,000 chars), then `\n` and the footer. Example (`find`, 569 chars): `{"what":"oak_log","kind":"block","matches":[{"pos":{"x":9,"y":67,"z":-12},"block":"minecraft:oak_log","distance":10.7,"exposed":true},…]}`.
- **Job done in time:** `Done: <label>. <summarizeResult>`. `summarizeResult` is the first 200 chars of `JSON.stringify(result)` (EventRouter.ts:325–332).
- **Job still going:** `Job <id> (<label>) is running. You'll get [JOB DONE] when it ends: end your turn now.`
- **Job failed:** `Failed: <label>. <CODE>: <msg>` with `isError`. The job's `result` (partial counts, `ingredients`) is dropped (mcServer.ts:224–228).
- **ApiError:** `Error <CODE>: <msg>`. Org tools return OrgApi text as is.
- **Footer**, on every result (~100 chars, ~30 tokens): `HP 20/20 food 20 | day 1 06:15 | 5 66 -5 overworld | idle (follow) | wheat_seeds`. It comes from the mod's `footer` key, otherwise Node's `statusFooter(agent.state)`.
- **Wake:** `[MV:<nonce> JOB DONE] <jobId> <label>: <same 200-char JSON>` (≤400 chars, no footer).

### 1.4 Token size of the v1 tool list

The tool list was measured by instantiating `createMcServer` with fakes and listing tools over an in-memory MCP client (scratch script `dump.mts`), then serializing `{name:"mcp__mc__…", description, input_schema}`.

| | Tools | Chars | ≈Tokens (chars/4) |
|---|---|---|---|
| World and behaviour (goto…emote, set_mode, stop) | 28 | 18,820 | 4,705 |
| Observe | 10 | 2,480 | 620 |
| Org (codex_*, calendar_*, report_task) | 9 | 6,044 | 1,511 |
| Social and PC (say, tell, remember, wait, request_hire, sit_at_pc, stand_up) | 7 | 2,998 | 750 |
| **mc total** | **54** | **28,204** | **7,051** |
| pc server, also alwaysLoad and in every wandering turn (gate-denied there) | 20 | 8,751 | 2,188 |

Where the bytes go:
- BlockPos with int32 min/max: 16 occurrences × 282 chars ≈ 4.5k.
- `wait_s` with its description: 27 × ~138 ≈ 3.7k.
- SDK-added `$schema` URL: 54 × ~50 ≈ 2.7k.
- ItemId regex: 14 × ~55.
- All descriptions together: 3,819 chars.

`alwaysLoad: true` (server-wide, mcServer.ts:562) keeps every tool out of tool-search deferral.

chars/4 underestimates JSON-schema text: real tokenization is closer to 3–3.5 chars per token, so both v1 and v2 are 15–30% higher in absolute terms. The ratio holds. Exact counts can be confirmed with one `messages.count_tokens` call over the dumped JSON; that call was not run here.

### 1.5 Observed call patterns (transcripts and acceptance run)

Sources:
- ~/.claude/projects/*MineVibe*agents* session transcripts (3 agent sessions: live smoke, play world-2, e2e acceptance).
- scripts/e2e/out/e2e-2026-10-08T22-03-05-746Z/{events.jsonl,summary.md}.
- No ~/Library/Logs/MineVibe* exists, and docs/design/ACCEPTANCE.md does not exist yet (the harness references it).

mc calls across all transcripts: sit_at_pc 6, stand_up 3, mine 3, status 2, find 1, look_around 1, inventory 1, stop 1, remember 1, list_pcs 1. No `wait_s` argument was ever passed.

Incident (acceptance step 3, Haiku 5.5 at xhigh, seed minevibe-e2e, agent at 5 66 -5 inside the starter office):

| t | Call | Result (chars) | Notes |
|---|---|---|---|
| 27.5 s | `mine{block:"oak_log",count:10}` | failed NOT_FOUND "found only 0 of 10 oak_log in range" (153) | **Wrong code.** An exposed oak trunk stood 10.7 m away. Miner skips unreachable targets and, with ≤8 skips, the next scan is empty, which becomes NONE_LEFT and then NOT_FOUND (Miner.java:102–123, GatherJobs.Mine.finish:83–91). |
| 31.3 s | `find{what:"oak_log",radius:64}` | 5 matches, 1 exposed (569) | No reachability, no natural/built flag. |
| 32.6 s | `mine{…near:9 68 -12, radius:32}` | failed UNREACHABLE no_path (161) | |
| 40.0 s | `look_around{radius:16}` | `"logs":{"count":31,"nearest":6 66 -6}` (977) | The "nearest logs" were the player's stripped-spruce cabin. |
| 42.3 s | `mine{block:"#minecraft:logs",count:10,radius:16}` | running after 20 s; done at 94 s: `{"mined":10,"items":{"stripped_spruce_log":5}}` | **Tag substitution destroyed the house.** 10 blocks were broken but only 5 items kept (drop pickup is 40 ticks within 3.5 blocks). |
| JOB DONE turn | `inventory`, `stop` (nothing running), `remember` | 313 / 99 / 91 | No crafting table was made. The step "passed" only because the office already had one. |

Totals: 8 calls over 2 turns (turn 1: 5 calls, 38.5 s; turn 2: 3 calls, 7.9 s), about 2,548 chars of tool results, and 2 wrong-code failures.

### 1.6 Defects and friction

- **D1 Overlapping intents.** `mine`, `collect`, `hunt` and `pickup` all mean "get X". The player said "collect" and Haiku chose `mine`. `pickup` duplicates the Pickup reflex (25), which already collects loose items within 6 blocks. `smelt` and `recipe` are separate from `craft`.
- **D2 NOT_FOUND hides UNREACHABLE** (see above). The model reads "none in range" and widens the search, or switches to a tag.
- **D3 Tags invite substitution.** The `mine` description says "block id or #tag", and `#minecraft:logs` includes stripped logs and wood. W1 fixes the mod semantics; the v1 description still invites it.
- **D4 Drops lost and inconsistent counts.** `mined` counts blocks broken, not items gained ("mined":10 vs 5 items); Miner COLLECT_TICKS is 40 and the radius 3.5.
- **D5 Failure results drop the job `result`** (mcServer.ts:224–228). The model never sees partial counts or the `ingredients` of MISSING_INGREDIENTS.
- **D6 Done summaries and [JOB DONE] are 200 chars of raw JSON** (`minecraft:` prefixes, nested objects, cut mid-JSON).
- **D7 `wait{job_id}` returns only "Job X done."** (AgentBrain.ts:1779–1790), so a `job_status` call has to follow.
- **D8 Tool schemas disagree with mod caps.**
  - `look_around` radius: tool ≤64, mod 1–32 (Observations.java:63), so 33–64 gets BAD_ARGS.
  - `find` radius: tool ≤128, mod ≤64 (Observations.java:65).
  - `find.limit` is supported by the mod but not exposed.
  - The zod `.refine` rules ("exactly one of pos/entity" for goto/open_menu, "put/take need item" for container) are lost in JSON Schema, so they surface only as BAD_ARGS.
- **D9 `goto` has two place mechanisms.** `place` is a Codex page resolved by Node. `entity` accepts the mod's named places (office, home, spawn, bed, chest, crafting_table, furnace, codex, pc:<id>; Places.java), but the description doesn't mention them (mcServer.ts:281).
- **D10 Silent job replacement.** Every world call is sent with `replace:true` (mcServer.ts:208), and the result never says that a running job was cancelled.
- **D11 Verbose raw-JSON observations.** `status` has about 30 fields. `inventory` lists slots and also totals. Positions are nested objects, distances are floats. The only cap is 8,000 chars (results.ts:37).
- **D12 Perception is raw.** It gives category counts plus one nearest block; there is no natural/built flag, reachability or direction. W1 fixes this in the mod.
- **D13 The job model is spread out.** `wait_s` sits on 27 tools (never used), next to `job_status`, `wait` and `stop`.
- **D14 No composite intents.** `craft` fails MISSING_INGREDIENTS or NEEDS_TABLE instead of resolving logs → planks → table, and smelting needs a separate tool.
- **D15 Schema bloat** (§1.4).
- **D16 pc tools are always loaded** (2.2k tokens) for wandering agents that may not call them. This is outside this spec; flagged for the pc spec.
- **D17 The footer is on every result**, including say/tell/remember/codex/calendar, at about 30 tokens per call.

### 1.7 Kept from v1

- The in-process server.
- ToolGate categories.
- running → [JOB DONE] wakes.
- The footer concept.
- RO annotations on reads.
- OrgApi texts for Codex and Calendar.
- Real crafting and menus in the mod.
- Reflexes.
- `replace` semantics (now announced).
- Tool names that were already right: goto, find, craft, build, set_mode, say, tell, remember, sit_at_pc, stand_up, request_hire.

---

## 2. Design principles (applied to Haiku 5.5)

1. **One tool per intent.** "Get N of X" is `gather`, "make X" is `craft`, a known multi-step request is `do`, and "what's around me" is `observe`. Low-level operations on the same object and gate fold into one tool with an `action` enum (`use`, `items`, `build`, `menu`, `job`, `codex`, `calendar`). Folding stops where an enum would mix very different semantics or gate categories without a clear rule.
2. **Descriptions say when to use the tool** ("Use for any 'get / collect / mine / chop N of X' request") and give one example each. Schemas carry only what the model must fill in. Cross-field rules live in the handler, and their errors include a corrected example.
3. **High-signal results.** Results are text lines with `minecraft:` stripped, positions as `x y z`, integer distances with a compass direction, and capped lists ending in `+N more`. There is a `next:` line only on running, failed, empty or truncated results.
4. **Errors teach.** Every failure code maps to a one-line next step (§8). PROTECTED is a hard stop, and so is NO_NATURAL_SOURCE for what the player named: the model asks the player and never substitutes. An ingredient the player did not name can be any kind of its family (any log for planks): the craft tree takes the nearest, and gather's hint names the family tag.
5. **Meaningful defaults.** observe = status+scene, find source = natural, gather radius = 48, craft count = 1, goto range = 1.5, a fixed 20 s answer time.
6. **Safety lives in the mod (W1)**, not in prompt text. Composites inherit protection. The consent token is never a model argument; Node attaches it.
7. **Parallel-safe reads.** `observe` and `find` are `readOnlyHint`, and Node fans observe sections out in parallel.
8. **Cache-friendly.** The tool list is byte-stable for the whole session and the same for every agent (CEO-only tools are listed for everyone and gated), so caches survive promotions.
9. **Stable names.** v2 names are final. v1 names that were already right are kept.

---

## 3. v2 tool list

| # | Tool | Kind | Gate category | RO | Replaces (v1) |
|---|---|---|---|---|---|
| 1 | `observe` | read | always | yes | status, look_around, inventory, crew, list_pcs, job_status (read), recent_events, menu_state |
| 2 | `find` | read | always | yes | find |
| 3 | `goto` | job | world | | goto (pos/entity/place → `to`) |
| 4 | `gather` | job, composite | world | | mine, collect, hunt (for drops), pickup |
| 5 | `craft` | job, composite | world (plan: always) | | craft, smelt, recipe |
| 6 | `build` | job | world | | build, dig, farm |
| 7 | `use` | job | world | | place, use_block, use_item, attack, hunt (kill N), sleep, ride, dismount, single-block mine |
| 8 | `items` | job | equip/eat: always; others: world | | equip, eat, drop, give, container |
| 9 | `menu` | job/read | state: always; others: world | | open_menu, menu_click, menu_close, menu_state |
| 10 | `do` | macro job | world | | — (new) |
| 11 | `job` | control | always | | job_status, wait, stop |
| 12 | `set_mode` | behaviour | always | | set_mode |
| 13 | `say` | social | always | | say, emote |
| 14 | `tell` | social | always | | tell |
| 15 | `remember` | memory | always | | remember |
| 16 | `sit_at_pc` | seat | sit | | sit_at_pc |
| 17 | `stand_up` | seat | stand | | stand_up |
| 18 | `request_hire` | org | hire | | request_hire |
| 19 | `codex` | org | read actions: codex_read; write actions: codex_write | | codex_search, codex_read, codex_write, codex_list |
| 20 | `calendar` | org | calendar | | calendar_list/add/update/cancel, report_task |

Deferral candidates (§13), once tool search is verified for Haiku 5.5: `menu`, `codex`, `calendar`, `request_hire`.

---

## 4. Shared conventions

### 4.1 Positions
All positions are strings `"x y z"`: integers, separated by spaces or commas (`"12 64 -30"`, `"12,64,-30"`). Results print positions the same way, so the model copies them verbatim.

Node parses them with `^\s*(-?\d{1,8})[\s,]+(-?\d{1,4})[\s,]+(-?\d{1,8})\s*$`. On failure it returns `BAD_ARGS: at must be "x y z", e.g. "12 64 -30"`. The regex is deliberately not in the JSON schema, to save tokens. The wire keeps `BlockPos {x,y,z}`.

### 4.2 Targets (`to`, `target`)
Node resolves them in this order:
1. A position (§4.1).
2. `player`, or the player's name.
3. A crew `@handle`, display name or agent id, which becomes the agent id.
4. A mod named place: `office`, `home`, `spawn`, `bed`, `chest`, `crafting_table`, `furnace`, `codex`, `pc:<id>` (Places.java).
5. An entity type (`cow`, `minecraft:zombie`) or a UUID.
6. `goto` only: the title or id of a Codex `places` page, resolved by Node with v1's `resolvePlace`.

If nothing matches, the result is `UNKNOWN_PLACE`.

### 4.3 Items
Items are `oak_log`, `minecraft:oak_log` or a tag `#logs` (`#minecraft:logs` also works). Results strip `minecraft:` and keep other namespaces. With W1 merged, tags mean natural sources only for gather/find, and building variants (stripped logs, wood, planks) are excluded unless named explicitly.

### 4.4 Counts and limits

| What | Limit |
|---|---|
| gather and craft count | 1–640 (10 stacks; the wire still allows 2304) |
| `use{attack}` count | 1–64 |
| find limit | 1–10 |
| do steps | 2–8 |
| dig box | ≤1024 blocks |
| farm box | ≤ FarmJob.MAX_SIDE × MAX_SIDE, 4 high |

### 4.5 Defaults

| Parameter | Default |
|---|---|
| observe.sections | `["status","scene"]` |
| observe.detail | brief |
| observe.radius | 24 |
| find.source | natural |
| find.radius | 48 |
| find.limit | 5 |
| goto.range | 1.5 |
| gather.radius | 48 |
| craft.count | 1 |
| craft.gather_missing | false |
| items.count | all you have (drop, give, store), one stack (take) |
| items.container | nearest chest or barrel within 24 |
| menu.click | pickup |
| menu.button | 0 |
| do.stop_on_fail | true |
| calendar.assignees | [self] |
| calendar.clock | inferred from `when` ("Day N hh:mm" or "now" → game; ISO → real) |

The answer wait is fixed at 20 s for every world tool (`ACTION_WAIT_S`) and 60 s for sit_at_pc.

### 4.6 Annotations
- `readOnlyHint: true`: observe, find. Claude Code runs these concurrently.
- `destructiveHint: true`: build, use, do. Informational only.
- All tools are `alwaysLoad` in phase A/B; per-tool `alwaysLoad: false` plus `searchHint` for deferrable tools in phase C (§13).

---

## 5. Tool specs

Each tool lists its description (verbatim), its input schema (JSON as listed by MCP; the SDK also adds `"$schema"`, omitted here), its semantics and wire mapping, and example results. Example data comes from the incident world.

### 5.1 `observe`
Description:
> See yourself and the world in one call: use it before multi-step work and whenever you are unsure where you are or what is around. Read-only, safe in parallel. sections (default status+scene): status = body, place, zone, job, held item; scene = zone (Base, player builds), natural resources with direction, distance and reachability, stations, hazards, mobs, players; inventory; crew = crew and player, where and doing what; jobs = current and recent jobs; events = what happened to you lately; pcs = office PCs and who sits there; menu = the open menu's slots and buttons.
> Example: {"sections":["scene","inventory"]}

Schema:
```json
{"type":"object","properties":{"sections":{"minItems":1,"maxItems":8,"type":"array","items":{"type":"string","enum":["status","scene","inventory","crew","jobs","events","pcs","menu"]}},"detail":{"description":"full lists more per section (default brief)","type":"string","enum":["brief","full"]},"radius":{"description":"Scene radius (default 24)","type":"integer","minimum":8,"maximum":48}}}
```

Semantics. Node fans the sections out in parallel (`Promise.all`) to existing `obs.query` calls:

| Section | Source |
|---|---|
| status | `status` |
| scene | `look_around{radius, detail}`, W1 scene |
| inventory | `inventory` |
| crew | `crew` |
| jobs | Node job registry (§7) plus `job_status` |
| events | `recent_events{limit 8 \| 20}` |
| pcs | `list_pcs` |
| menu | `menu_state` |

Further rules:
- Sections render in that fixed order.
- A failed section renders `scene: unavailable (TIMEOUT)` and does not fail the call.
- Per-section caps (brief/full, chars): status 200/400, scene 900/2500 (W1 targets), inventory 300/1200, crew 400/1000, jobs 200/600, events 400/1500, pcs 300/600, menu 600/2000. Total ≤2500 brief, ≤6000 full.
- No footer when `status` is included.
- Phase B optional (M10): one `obs.query observe{sections,detail,radius}` for a same-tick snapshot.

Example (`{"sections":["status","scene","inventory"]}`):
```
status: HP 20/20 food 20 | day 1 06:15 clear | 5 66 -5 plains | in Base (Player's office) | idle (follow, Player 2m S) | held wheat_seeds
scene (24m): inside Base: protected, don't break or take
 trees: oak at 6 66 24, 28m S, trunk 5, reachable; oak at 9 67 -12, 11m NE, trunk 4, unreachable (wall); spruce at -26 70 -3, 31m W, trunk 7, reachable
 built: office (Base) at 0 66 3; cabin (stripped_spruce_log, player-built) at 6 66 -6, 2m NE
 stations: crafting_table at 5 66 0 (Base), furnace at 7 66 0 (Base), chest at 3 66 1 (Base)
 ores seen: coal 9m (-5 59 -4), iron 5m (4 62 0), copper 12m (2 62 -11)
 mobs: none | hazards: none | players: Player 2m S
inventory: 34 slots free | wheat_seeds 3
```

Other section formats:
```
crew: Player 2m S HP 18 food 12 | @bram Bram (miner) 42m NE gather 3/20 iron_ore HP 20 | @cleo Cleo (engineer) seated at linux-1
jobs: now j2-7 gather oak_log 4/10 (35s) | last j2-6 craft crafting_table done 2m ago
events: 1m ago picked up oak_sapling 2; 4m ago hurt by zombie (HP 14); 6m ago reflex flee
pcs: linux-1 running, free, chair 108 68 780 (4m) | mac-1 stopped
menu: merchant (villager, 2 trades) | buttons: -2 = 1 emerald → 6 bread; -3 = 20 wheat → 1 emerald | slots: 0 in1, 1 in2, 2 out (empty) | yours: 3-38
```

### 5.2 `find`
Description:
> Find the nearest blocks, mobs or dropped items of one kind, with distance, direction, reachability and natural vs player-built. Read-only. Use it to pick a spot or to check that something exists; gather and craft find their own sources.
> Example: {"target":"iron_ore"}

Schema:
```json
{"type":"object","properties":{"target":{"type":"string","minLength":1,"maxLength":80,"description":"Block/item id, #tag, or mob type (\"cow\")"},"source":{"description":"For blocks (default natural)","type":"string","enum":["natural","built","any"]},"radius":{"description":"Default 48","type":"integer","minimum":4,"maximum":64},"limit":{"description":"Default 5","type":"integer","minimum":1,"maximum":10}},"required":["target"]}
```

Semantics: `obs.query find{what: target, radius, limit, <W1 provenance filter>: source}`. Results are ranked nearest first. Items show "you have N".

Examples:
```
find oak_log (natural, ≤48m): 2 found
1. trunk ×5 at 6 66 24, 28m S, reachable
2. trunk ×4 at 9 67 -12, 11m NE, unreachable (no path: wall)
```
```
find cow (≤48m): 1. cow at 12 64 -3, 9m E, HP 10
```
```
find diamond_ore (natural, ≤48m): none (loaded chunks only)
next: find{"target":"diamond_ore","radius":64}, or ask Player where to look
```

### 5.3 `goto`
Description:
> Walk somewhere. to: "x y z", "player", a crew @handle, a mob type, or a place: office, home, spawn, bed, chest, crafting_table, furnace, codex, pc:<id>, or a Codex places page title. A job.
> Example: {"to":"crafting_table"}

Schema:
```json
{"type":"object","properties":{"to":{"type":"string","minLength":1,"maxLength":80},"range":{"description":"Stop this close (default 1.5)","type":"number","minimum":0,"maximum":16}},"required":["to"]}
```

Mapping (§4.2):
- position, or a resolved Codex place → `goto{pos}`
- player, agent, mod named place, mob → `goto{entity}`

Results:
```
done: goto crafting_table → 5 66 0 (12m in 9s)
```
```
failed: goto "mine" | UNKNOWN_PLACE: no place, crew member or mob called "mine"
next: codex{"action":"search","query":"mine"} or give "x y z"
```

### 5.4 `gather` (composite)
Description:
> Use for any "get / collect / mine / chop N of X" request. Gets count of an item into your inventory end to end: picks up loose drops, harvests NATURAL sources (whole tree trunks, natural stone and ores, animals for meat, leather, wool), takes or makes the right tool, and collects the drops. Never breaks player-built blocks or the Base; #logs means natural logs only. When nothing natural is reachable it fails with NO_NATURAL_SOURCE: for a kind the player named, ask them, never substitute; an ingredient can be any kind ("#logs"). A job.
> Example: {"item":"oak_log","count":10}

Schema:
```json
{"type":"object","properties":{"item":{"type":"string","minLength":1,"maxLength":64,"description":"id or #tag"},"count":{"type":"integer","minimum":1,"maximum":640},"near":{"type":"string","minLength":5,"maxLength":40,"description":"Search around this \"x y z\" instead of you"},"radius":{"description":"Default 48","type":"integer","minimum":8,"maximum":64}},"required":["item","count"]}
```

Mapping: `skill.run collect{item, count, radius, near, make_tools:true}`, plus the W2 consent field if one is pending for this agent and area (Node-only). Mod behaviour is in M2/M3.

Source order:
1. Loose items.
2. W1 natural blocks (whole reachable trunks, bottom-up; natural stone and ores; tags exclude building variants).
3. Animals, for drops only: outside protected zones, never name-tagged, leashed, tamed or baby animals.

`count` means items gained. The tool is equipped automatically; a missing tool is crafted from the inventory when possible.

Results:
```
done: gather oak_log 10/10 in 74s | from 2 oak trees near 6 66 24 | also oak_sapling 2, stick 1 | replanted 1 | have oak_log 10
```
```
running: gather oak_log 4/10 (job j2-7, 20s so far)
next: end your turn; [JOB DONE] wakes you. Or job{"action":"wait","seconds":60}, job{"action":"stop"}.
· HP 20/20 food 20 | day 1 06:52 | 6 66 20 | 9m from Base | gather 4/10 oak_log | iron_axe
```
```
failed: gather oak_log 0/10 | NO_NATURAL_SOURCE: no reachable natural oak_log within 48m
 seen: oak trunk at 9 67 -12, 11m NE, unreachable (no path: wall)
 seen: oak trunk at 6 66 60, 63m S, beyond radius
next: ask Player (AskUserQuestion: go further / another wood / skip). Never take logs from buildings.
```

### 5.5 `craft` (composite)
Description:
> Use for any "make / craft / smelt X" request. Makes count of an item and resolves the whole recipe tree: crafts intermediates (logs to planks to sticks), smelts in a furnace when needed, and uses a nearby crafting table or furnace, or places one (crafting it first if needed). gather_missing:true also gathers missing raw materials from nature, any kind the recipe takes (birch logs for planks). plan:true only shows the tree and what is missing. A job.
> Example: {"item":"crafting_table"}

Schema:
```json
{"type":"object","properties":{"item":{"type":"string","minLength":1,"maxLength":64,"description":"One item id, not a tag"},"count":{"description":"Default 1","type":"integer","minimum":1,"maximum":640},"gather_missing":{"description":"Default false","type":"boolean"},"plan":{"type":"boolean"},"station":{"type":"string","minLength":5,"maxLength":40,"description":"Use the crafting table or furnace at \"x y z\""}},"required":["item"]}
```

Mapping:
- `plan:true` → `obs.query recipe{item, count, tree:true}`. This is read-only, gate `always`, and not a job.
- Otherwise → `skill.run craft{item, count, table:station, tree:true, gather_missing}`.

`count` is the number of items wanted. Crafts = ceil(count / makes), and any extra output is kept. Mod behaviour is in M4.

Results:
```
done: craft crafting_table ×1 in 4s | made oak_planks 4 from oak_log 1 | 2x2 grid | have crafting_table 1, oak_log 9
```
```
plan: iron_pickaxe ×1 | table: crafting_table at 5 66 0 (6m)
 iron_ingot ×3 ← smelt raw_iron ×3 (have 0) | furnace at 7 66 0 | fuel: oak_planks ok
 stick ×2 ← oak_planks ×1 (have 6) ok
 missing raw: raw_iron 3
next: craft{"item":"iron_pickaxe","gather_missing":true} (gathers raw_iron; you have a stone_pickaxe)
```
```
failed: craft iron_pickaxe 0/1 | MISSING_INGREDIENTS: raw materials missing
 need: raw_iron 3 (have 0), for iron_ingot 3 (smelt)
 ok: stick 2 from oak_planks; crafting_table at 5 66 0; furnace at 7 66 0; fuel oak_planks
next: craft{"item":"iron_pickaxe","gather_missing":true}, or gather{"item":"raw_iron","count":3}
```

### 5.6 `build`
Description:
> Build, clear or farm an area. blueprint builds a built-in plan at "x y z": shelter, wall_ring, torch_ring, bridge, stairs_down, farm_plot. dig clears every block in the box from..to (at most 1024). farm tills, plants and harvests the box. Never changes player-built blocks or the Base. A job.
> Example: {"action":"blueprint","blueprint":"shelter","at":"10 64 -3"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["blueprint","dig","farm"]},"blueprint":{"type":"string","minLength":1,"maxLength":80},"at":{"type":"string","minLength":5,"maxLength":40,"description":"\"x y z\""},"rotation":{"anyOf":[{"type":"number","const":0},{"type":"number","const":90},{"type":"number","const":180},{"type":"number","const":270}]},"from":{"type":"string","minLength":5,"maxLength":40,"description":"\"x y z\""},"to":{"type":"string","minLength":5,"maxLength":40,"description":"\"x y z\""},"crop":{"description":"farm: a seed item","type":"string","minLength":1,"maxLength":64}},"required":["action"]}
```

Mapping:
- blueprint → `build{blueprint, origin:at, rotation}`
- dig → `dig{from,to}`
- farm → `farm{from,to,crop}`

Node validates per action: blueprint needs blueprint and at; dig and farm need from and to. On a missing field it returns an example.

Results:
```
done: build shelter at 10 64 -3 in 2m 10s | used cobblestone 52, oak_planks 4
```
```
done: dig 3x2x3 box 10 64 -3..12 65 -1 | dug 16, skipped 2 | got dirt 14, cobblestone 2
```
```
failed: dig … | PROTECTED: 4 blocks in the box are Player's (player-built) | dug 0
next: ask Player before changing them (AskUserQuestion); if they agree, repeat this exact call.
```

### 5.7 `use`
Description:
> One hands-on action. place item at target "x y z"; break the one block at target; interact (right-click) a block or entity: door, lever, bed, chest, villager; use_item (item, or the held one), optionally on target: bucket, bone_meal, flint_and_steel; attack target until it dies; ride / dismount; sleep in the nearest bed (or target) at night. Player-built blocks and the Base are refused unless the player agreed. A job.
> Example: {"action":"place","item":"crafting_table","target":"6 66 1"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["place","break","interact","use_item","attack","ride","dismount","sleep"]},"target":{"description":"\"x y z\" or an entity: \"player\", @handle, mob type","type":"string","minLength":1,"maxLength":80},"item":{"type":"string","minLength":1,"maxLength":64,"description":"id or #tag"},"count":{"description":"attack: how many of that mob type (default 1)","type":"integer","minimum":1,"maximum":64}},"required":["action"]}
```

Mapping:

| Action | Wire call |
|---|---|
| place | `place{block:item, pos:target}` |
| break | `dig{from:target,to:target}` (W1 protection applies) |
| interact on a block | `use_block{pos}` |
| interact on an entity | `use_item{entity}` (held item) |
| use_item | `use_item{item?, pos?\|entity?}` |
| attack, count 1 | `attack{entity}` |
| attack, count >1 | `hunt{entity, count}` |
| ride | `ride{entity}` |
| dismount | `dismount{}` |
| sleep | `sleep{pos?}` |

Results:
```
done: placed crafting_table at 6 66 1
```
```
failed: break 6 66 -6 | PROTECTED: stripped_spruce_log is part of Player's cabin (player-built)
next: ask Player before changing it (AskUserQuestion). If they agree, repeat this exact call.
```
```
done: attack zombie ×2 in 14s | got rotten_flesh 3
```

### 5.8 `items`
Description:
> What you carry: equip (hand or armor slot), eat (best food, or item), drop, give (walks to to: "player" or @handle), store / take with a container (nearest chest, or container "x y z"), list a container.
> Example: {"action":"give","item":"oak_log","count":5,"to":"player"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["equip","eat","drop","give","store","take","list"]},"item":{"type":"string","minLength":1,"maxLength":64,"description":"id or #tag"},"count":{"description":"Default: all you have (drop, give, store), one stack (take)","type":"integer","minimum":1,"maximum":640},"to":{"type":"string","minLength":1,"maxLength":80},"slot":{"type":"string","enum":["mainhand","offhand","head","chest","legs","feet"]},"container":{"type":"string","minLength":5,"maxLength":40,"description":"\"x y z\""}},"required":["action"]}
```

Mapping:

| Action | Wire call |
|---|---|
| equip | `equip{item,slot}` |
| eat | `eat{item?}` |
| drop | `drop{item,count?}` |
| give | `give{item,count?,to}` (M6: `count` optional means all) |
| store | `container{pos?,action:"put",item,count?}` |
| take | `container{pos?,action:"take",…}` (W1: taking from a player chest is PROTECTED unless the player agreed) |
| list | `container{pos?,action:"list"}` |

`pos` is optional with M6 (nearest container within 24).

Results:
```
ok: equipped iron_pickaxe (mainhand)
```
```
ok: ate bread (food 14→19)
```
```
done: gave oak_log 5 to Player (walked 4m)
```
```
ok: chest at 3 66 1: cobblestone 64, coal 12, bread 5 (24 slots free)
```

### 5.9 `menu`
Description:
> Block and entity menus: villager trades, enchanting, anvil, brewing, stonecutter. open target, state lists slots and buttons, click a slot (or button), close. For crafting and chests use craft and items.
> Example: {"action":"open","target":"minecraft:villager"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["open","state","click","close"]},"target":{"type":"string","minLength":1,"maxLength":80},"slot":{"description":"From state; -2 or less presses button -slot-2","type":"integer","minimum":-999,"maximum":255},"button":{"type":"integer","minimum":0,"maximum":40},"click":{"type":"string","enum":["pickup","quick_move","swap","throw","pickup_all"]}},"required":["action"]}
```

Mapping:
- open → `open_menu{pos|entity}`
- state → `obs.query menu_state` (gate `always`)
- click → `menu_click{slot, button:0, type:click|pickup}`
- close → `menu_close`

`clone` and `quick_craft` are dropped from the enum (creative-only or drag; unused).

### 5.10 `do` (step macro, one mod job)
Description:
> Run 2-8 world steps as ONE job, in order, without waking you between them. Use it when a request has several known steps ("get logs, then make a table"). Each step is {tool, args} with the args of goto, gather, craft, build, use or items. Stops at the first failed step unless stop_on_fail is false.
> Example: {"steps":[{"tool":"gather","args":{"item":"oak_log","count":10}},{"tool":"craft","args":{"item":"crafting_table"}}]}

Schema:
```json
{"type":"object","properties":{"steps":{"minItems":2,"maxItems":8,"type":"array","items":{"type":"object","properties":{"tool":{"type":"string","enum":["goto","gather","craft","build","use","items"]},"args":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["tool","args"]}},"stop_on_fail":{"type":"boolean"}},"required":["steps"]}
```

Semantics (as built, §16.10: one step is accepted, `minItems` 1, and runs as that tool; the description says so):
1. Node validates each step with that tool's schema and the same handler rules. Errors name the step: `BAD_ARGS: step 2 craft: item is required. Example: …`.
2. `craft{plan}` and `items{list}` are not allowed in steps (a lone step of either answers as its tool).
3. Node translates each step through the same v2→wire table (§10) and resolves Codex places and positions.
4. Node attaches consent per step (W2) and sends one `skill.run{skill:"sequence", args:{steps:[{skill,args}…], stop_on_fail}}` (M1).
5. Progress text: `step 1/2 collect 4/10 oak_log`.
6. If the mod lacks `skill.sequence` (no cap, §11), Node runs the steps sequentially as separate jobs under one Node macro id, with the same result format. This fallback does not survive a Node restart.

Results:
```
done: do 2/2 steps in 81s
 1 gather oak_log 10/10 | from 2 oak trees near 6 66 24 | have oak_log 10
 2 craft crafting_table ×1 | made oak_planks 4 | have crafting_table 1, oak_log 9
```
```
failed: do step 1/2 gather | NO_NATURAL_SOURCE: no reachable natural oak_log within 48m
 1 gather oak_log 0/10 failed; 2 craft crafting_table skipped
 seen: oak trunk at 9 67 -12, 11m NE, unreachable (wall)
next: ask Player (AskUserQuestion: go further / another wood / skip). Never take logs from buildings.
```

### 5.11 `job`
Description:
> Your world jobs: status (current, or job_id), wait up to seconds for it to end and get its result, stop cancels it. A world tool that answers "running" keeps working after your turn: prefer ending your turn, [JOB DONE] wakes you.
> Example: {"action":"stop"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["status","wait","stop"]},"job_id":{"type":"string","minLength":1,"maxLength":64},"seconds":{"type":"integer","minimum":1,"maximum":120}},"required":["action"]}
```

Semantics:
- **status:** Node registry plus `obs.query job_status`.
- **wait:** `awaitJob(id|current, seconds)`. It returns the full formatted final result, which fixes D7. Without a job it sleeps for `seconds` (v1 `wait`). The default is 30 s.
- **stop:** `skill.cancel`.

Results:
```
running: j2-7 gather oak_log 4/10 (35s; paused 3s for reflex eat)
```
```
idle: no job | last: j2-6 craft crafting_table done 2m ago
```
```
cancelled: j2-7 gather oak_log 4/10 (kept oak_log 4)
```
```
ok: no job was running
```

### 5.12 `set_mode`
Description:
> What your body does between jobs: follow the player, stay, guard an area (around anchor), or wander.
> Example: {"mode":"guard","anchor":"0 66 3"}

Schema:
```json
{"type":"object","properties":{"mode":{"type":"string","enum":["follow","stay","guard","wander"]},"anchor":{"type":"string","minLength":5,"maxLength":40,"description":"\"x y z\""}},"required":["mode"]}
```

Mapping: `agent.mode{mode, anchor}`. Result: `ok: idle mode guard around 0 66 3`.

### 5.13 `say`
Description:
> Say something out loud now (a bubble above your head) without ending your turn, and/or play an emote.
> Example: {"text":"On my way!","emote":"wave"}

Schema:
```json
{"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":500},"emote":{"type":"string","enum":["wave","nod","shake_head","point","cheer","facepalm"]}}}
```

Mapping: `host.say(text)`; `emote` → `skill.run emote{kind}` with `replace:false`. At least one of the two is required. Result: `ok: said` / `ok: said, waved`.

### 5.14 `tell` (unchanged)
Description:
> Send a private message to one crew member (@handle, name or "ceo"). Only they get it.
> Example: {"to":"@bram","text":"Need 10 cobblestone at the office."}

Schema:
```json
{"type":"object","properties":{"to":{"type":"string","minLength":1,"maxLength":64},"text":{"type":"string","minLength":1,"maxLength":2000}},"required":["to","text"]}
```

### 5.15 `remember` (unchanged)
Description:
> Add a short note to your private long-term memory (re-read after restarts).
> Example: {"note":"Player's cabin at 6 66 -6 is player-built: never mine it."}

Schema:
```json
{"type":"object","properties":{"note":{"type":"string","minLength":1,"maxLength":600}},"required":["note"]}
```

### 5.16 `sit_at_pc` (unchanged semantics; `wait_s` removed, fixed 60 s)
Description:
> Walk to an office PC and sit down to work on it (shell, files, screen). PC ids: observe sections ["pcs"]. When it says "Seated", end your turn: your PC session starts next turn.
> Example: {"pc":"linux-1","purpose":"fix the failing test"}

Schema:
```json
{"type":"object","properties":{"pc":{"type":"string","minLength":1,"maxLength":64},"purpose":{"type":"string","minLength":1,"maxLength":200,"description":"Shown on the monitor"}},"required":["pc","purpose"]}
```

### 5.17 `stand_up` (unchanged)
Description:
> Stand up from your PC (or stop walking to one).

Schema: `{"type":"object","properties":{}}`

### 5.18 `request_hire` (unchanged)
Description:
> CEO only: ask the player to hire a crew member. Returns at once; [HIRE DECISION] arrives later.
> Example: {"role":"miner","reason":"We need iron","first_task":"Mine 20 iron ore"}

Schema:
```json
{"type":"object","properties":{"role":{"type":"string","enum":["engineer","miner","farmer","guard","builder"]},"name":{"type":"string","minLength":1,"maxLength":24},"reason":{"type":"string","minLength":1,"maxLength":500},"first_task":{"type":"string","minLength":1,"maxLength":2000}},"required":["role","reason","first_task"]}
```

### 5.19 `codex`
Description:
> The shared Codex (notes by the crew and the player). search (top 8 snippets), list (by category or tag), read (one page and its rev), create a page (title, body, category, scope), update (replace the body; needs id and base_rev) or append (needs id). here:true stamps your position on a places page.
> Example: {"action":"search","query":"iron mine"}

Schema (with `rules` added to the category enum for search and list; writing `rules` gives BAD_ARGS):
```json
{"type":"object","properties":{"action":{"type":"string","enum":["search","list","read","create","update","append"]},"query":{"type":"string","minLength":1,"maxLength":200},"id":{"type":"string","minLength":1,"maxLength":80},"title":{"type":"string","minLength":1,"maxLength":80},"body":{"type":"string","minLength":1,"maxLength":8192},"category":{"type":"string","enum":["places","howto","projects","decisions","people","log","minutes","rules"]},"tags":{"maxItems":16,"type":"array","items":{"type":"string","maxLength":32}},"scope":{"type":"string","enum":["world","lasting"]},"base_rev":{"type":"string","minLength":7,"maxLength":64},"here":{"type":"boolean"}},"required":["action"]}
```

Mapping:

| Action | OrgApi call |
|---|---|
| search | `codexSearch{query, tags, category}` |
| list | `codexList{category, tag: tags[0]}` |
| read | `codexRead{id}` |
| create, update, append | `codexWrite{mode: action, …}` |

For update and append, Node fills a missing title, category or scope from the page. Tags are validated against `CodexTag`. Results are OrgApi text, unchanged.

### 5.20 `calendar`
Description:
> Tasks, reminders and meetings. list (optionally for one agent); add (when: "now", "Day 3 06:00" game clock, or an ISO date on the real clock; only the CEO schedules others); update or cancel an event (scope next or all); report closes a scheduled task occurrence as done, failed or blocked (failed and blocked wake the CEO).
> Example: {"action":"add","kind":"task","title":"Mine iron","assignees":["bram1a2b"],"when":"now","task":"Mine 20 iron ore"}

Schema:
```json
{"type":"object","properties":{"action":{"type":"string","enum":["list","add","update","cancel","report"]},"id":{"description":"Event id (update, cancel, report)","type":"string","minLength":1,"maxLength":64},"title":{"type":"string","minLength":1,"maxLength":80},"kind":{"type":"string","enum":["task","reminder","meeting"]},"assignees":{"anyOf":[{"type":"string","const":"all"},{"maxItems":16,"type":"array","items":{"type":"string","maxLength":64}}]},"when":{"anyOf":[{"type":"string","minLength":1,"maxLength":64},{"type":"number","minimum":0}]},"clock":{"type":"string","enum":["game","real"]},"repeat":{"type":"string","enum":["once","daily","weekdays"]},"every_n_days":{"type":"integer","minimum":2,"maximum":365},"duration_min":{"type":"integer","minimum":1,"maximum":1440},"location":{"type":"string","minLength":1,"maxLength":80},"task":{"type":"string","minLength":1,"maxLength":2000},"scope":{"type":"string","enum":["next","all"]},"status":{"type":"string","enum":["done","failed","blocked"]},"note":{"type":"string","minLength":1,"maxLength":500},"agent":{"type":"string","minLength":1,"maxLength":64}},"required":["action"]}
```

Mapping:
- list → `calendarList{agent}`
- add → `calendarAdd`
- update → `calendarUpdate`
- cancel → `calendarCancel{id, scope}`
- report → `reportTask{event_id:id, status, note}`, and `host.taskReported`

`repeat` or `every_n_days` becomes `recurrence{kind, n}`. Defaults: assignees = [self]; clock inferred from `when`.

v1-only fields `catch_up`, `run_while_away` and `calendar_list.from/to` are dropped (OrgApi defaults apply). They can be added back if the eval shows a need.

---

## 6. Result format

### 6.1 Shape
```
<state>: <what> <outcome> [| fact | fact …]
 <detail line>            (0–6 lines, one record each, 1-space indent)
next: <one imperative line with exact v2 call syntax>   (only on running / failed / empty / truncated)
· <footer>                (policy in 6.4)
```
`<state>` is one of:
- `ok`: an instant tool that is not a job.
- `done`, `running`, `failed`, `cancelled`: jobs.
- `plan`: craft plan.
- `idle`: job status.

Observe uses `<section>:` labels instead. `failed` and `cancelled` set `isError: true`.

### 6.2 Rendering rules (Node `tools/format.ts`; the mod keeps returning JSON)
- **R1** Strip `minecraft:` from ids. Tags print as `#logs`.
- **R2** Positions as `x y z` block integers. The dimension is shown only when it is not the overworld.
- **R3** Distances as integer metres plus an 8-point compass from the agent (N = −Z): `28m S`.
- **R4** Durations as `9s` or `3m 10s`. Game time as `day 3 08:12`.
- **R5** Progress as `got/need`. Item lists are `item n, item n`, sorted by count descending, at most 6 entries brief and 20 full, then `+N more`.
- **R6** Booleans as words: `reachable`, `unreachable (<why>)`, `natural`, `player-built`, `Base`.
- **R7** One record per line for ranked lists (find, scene trees, do steps).
- **R8** Never JSON-dump a mod result. Unknown fields are dropped and logged at debug. Unknown skills fall back to `k v` pairs, capped at 300 chars.
- **R9** `next:` is at most 160 chars and uses literal `tool{json}` syntax that the model can copy.
- **R10** Truncated output ends with `(+N more: <call that shows them>)`.
- **R11** Text written by others (custom entity names, sign text, Codex titles in scene output) goes through the existing `escapeShared` envelope.

### 6.3 Size caps
- Job results: ≤600 chars.
- `do`: ≤900.
- observe: §5.1.
- find: ≤700 brief / ≤1500 full.
- Org tools: unchanged.

### 6.4 Footer
- Format (W1 adds the zone; overworld omitted): `· HP 18/20 food 15 | day 3 08:12 | 120 64 -80 | 12m from Base | gather 4/10 oak_log | iron_axe`.
- **On:** world tools, `do`, `job`, `find`, `menu`, `observe` without `status`.
- **Off:** `observe` with `status`; `say`, `tell`, `remember`, `set_mode`, `codex`, `calendar`, `request_hire`. The per-turn Digest already carries body state.
- This amends PLAN §6.5 ("every mc tool result ends with a 25-token footer") and the protocol.md §7.4 footer paragraph.
- Node always strips the mod's `footer` key (closes the DEBT.md "footer sent twice" item for summaries).

### 6.5 Wake texts
`EventRouter.jobEnded` renders through the same formatter: line 1 of the done or failed result, plus `next:` for failures. No footer, ≤400 chars.
```
[MV:ab12cd JOB DONE] j2-7 gather oak_log 10/10 in 74s | from 2 oak trees near 6 66 24 | also oak_sapling 2, stick 1 | have oak_log 10
[MV:ab12cd JOB FAILED] j2-8 do step 1/2 gather | NO_NATURAL_SOURCE: no reachable natural oak_log within 48m | next: ask Player (go further / another wood / skip)
```

---

## 7. Job model

- **One way to wait.** Every world tool answers within `ACTION_WAIT_S = 20` (sit_at_pc: 60). A job that is still going answers `running` with its id and progress. The model then ends its turn and [JOB DONE] or [JOB FAILED] wakes it (P3, coalesced, unchanged), or it calls `job{wait}` (≤120 s, counts against the turn cap). `wait_s` is removed from every schema, and PLAN §6.5 "Long jobs" is amended accordingly.
- **Node job registry** (AgentBrain, per agent):
  - current: `{jobId, label, startedAt, progressText, pausedBy?}`, fed by `skill.progress`, `agent.state.job` and reflex state.
  - last 5 ended: `{jobId, label, status, rendered, endedAt}`.
  - It feeds `job`, `observe{jobs}`, wakes and the replace notice.
- **Replace is announced.** A world tool started while a job runs still replaces it (v1 behaviour), and the new result appends `(stopped your previous job j2-6 gather oak_log 4/10)`. Node gets this from the registry; M9 optionally lets the mod confirm it in the reply.
- **Job ids** stay `j<base36>-<seq>`; macro jobs from the Node fallback use `m…`. The model rarely needs them.
- **Partial results are kept.** Failed, cancelled and timed-out jobs render their `result` (got/need, kept items, ingredients), which fixes D5.
- **Preemption.** Reflexes pause jobs as before. Status shows `paused Ns for reflex <name>`.
- **Player "new task"** (`chatMode==='task'` cancels the job, AgentBrain ~731) cancels `do` sequences as one job. The Node fallback macro observes the cancel and stops.

---

## 8. Error taxonomy (codes and next-step hints)

Failures render as `failed: <what> <progress> | <CODE>: <msg>`, then detail lines, then `next:`. Codes are the wire codes (protocol.md §5, §7.4.1) plus W1's, so nothing new is needed on the wire for errors.

| Code | Source | Meaning | `next:` (template) | Hard stop? |
|---|---|---|---|---|
| BAD_ARGS | Node (schema/handler) or mod | Wrong or missing field, or bad position | Corrected example for that tool/action, e.g. `use{"action":"place","item":"torch","target":"12 64 -3"}` | no |
| UNKNOWN_PLACE | Node (goto) | `to` matches nothing | `codex{"action":"search","query":"<to>"}` or give "x y z" | no |
| NOT_FOUND | mod | Nothing of that kind seen within radius (loaded chunks) | `find{"target":…,"radius":64}`, or goto elsewhere, or ask Player | no |
| UNREACHABLE | mod | Targets exist, no path; candidates listed (M3) | pick another from `find`, goto nearer, or ask Player | no |
| NO_NATURAL_SOURCE | W1 mod | Only built, protected or unreachable sources; candidates and reasons listed | ask Player (AskUserQuestion: go further / use X instead / skip); never substitute. As built (question quality, 2026-10-09): a `gather` of one kind of a material family says `if Player named oak_log: ask; else gather{"item":"#logs","count":10} (an ingredient: any kind, no question)` | **yes**, for what the player named |
| PROTECTED | W1 mod | Target is player-built or Base (`what`, `owner`, pos) | ask Player first; if they agree, repeat the same call (Node attaches consent) | **yes** |
| OTHER_DIMENSION | mod | Target in another dimension | goto a portal, or ask | no |
| NEEDS_TOOL | mod | Block drops nothing without the tool and gather could not make one | as built (§16.10): the tier the block needs, `craft{"item":"wooden_pickaxe","gather_missing":true}` with the craft tree; on an older mod, what to get first by the inventory | no |
| MISSING_INGREDIENTS | mod (craft) | Raw materials missing (tree, `result.missing`) | `craft{…,"gather_missing":true}` or `gather{…}` | no |
| NO_RECIPE | mod | Not craftable or smeltable | `gather{"item":…}` (it is gathered, not crafted) | no |
| NEEDS_TABLE / NO_TABLE / NEEDS_FURNACE / NO_FURNACE / FURNACE_BUSY | mod (craft) | Station problem the tree could not solve | `craft{…,"gather_missing":true}` or `station:"x y z"` | no |
| NO_FUEL | mod | Ran out of fuel | `craft{…,"gather_missing":true}` (gathers coal or uses logs) | no |
| NO_ITEM | mod | You don't have the item | `observe{"sections":["inventory"]}`, then gather or craft | no |
| INVENTORY_FULL | mod | No room | `items{"action":"store","item":"dirt"}` (store needs an item) at a chest, or drop junk | no |
| OCCUPIED / NO_SUPPORT / BLOCKED / CANNOT_PLACE / NO_ROOM | mod | Placement failed | choose another spot (observe scene) | no |
| NO_FOOD / NOT_HUNGRY / CANNOT_EAT | mod | Eating | gather food / nothing to do | no |
| NO_BED / NOT_NIGHT / NOT_SAFE / OBSTRUCTED / CANNOT_SLEEP_HERE | mod | Sleeping | per msg (wait for night, clear mobs, find a bed) | no |
| BAD_TARGET | mod | Players and agents are never attacked | — | **yes** |
| ESCAPED | mod | Mob got away | retry once or move on | no |
| NOT_A_CONTAINER / NO_MENU / BAD_CLICK / BAD_SLOT | mod | Menus | `menu{"action":"state"}` | no |
| SEATED / SEAT_EXCLUDED / NOT_RIDEABLE | mod | Body sits; chairs are for sit_at_pc | `stand_up` / `use{"action":"dismount"}` | no |
| RESERVED / OCCUPIED_BY_PLAYER / PC_DOWN / NO_SEAT / SEAT_CAP / UNREACHABLE (seat) | mod/Node | sit_at_pc | another PC (`observe pcs`) or ask Player | no |
| UNKNOWN_BLUEPRINT | mod | — | lists built-ins: shelter, wall_ring, torch_ring, bridge, stairs_down, farm_plot | no |
| TIMEOUT (job) | mod | Ran past its limit; partial kept | `job{"action":"status"}` or retry with a smaller count | no |
| INTERRUPTED (cancelled) | mod | stop / new task from Player / replaced / died; `msg` says which | none if Player gave a new task | yes when by Player |
| step failure in `do` | Node render | Wraps the failing step's code: `failed: do step i/n <tool> \| <CODE>: …`; later steps listed as skipped | the step code's hint | per code |
| UNKNOWN_JOB | mod | job_id unknown | `job{"action":"status"}` | no |
| TIMEOUT / DISCONNECTED / NO_SERVER / UNKNOWN_AGENT (bridge) | Node | The game did not answer | "try once more; if it fails again, tell Player the game isn't responding" | no |
| INTERNAL / FAILED | mod | Crash or unspecified | tell Player briefly; don't loop | yes after 1 retry |

ToolGate denials (seated, walking, turn cap, CEO-only, self-only) keep their current texts (ToolGate.ts).

---

## 9. ToolGate mapping

`MC_TOOLS` becomes `Record<McToolName, McCategory | ((input) => McCategory)>`, and `decideMc` calls `categoryOf(tool, input)`. The catalog-agreement test stays.

| Tool | Category |
|---|---|
| observe, find, job, set_mode, say, tell, remember | always |
| goto, gather, build, use, do | world |
| craft | `plan:true` → always, else world |
| items | equip / eat → always; others → world |
| menu | state → always; others → world |
| sit_at_pc / stand_up / request_hire | sit / stand / hire |
| codex | search / list / read → codex_read; create / update / append → codex_write |
| calendar | calendar; the self-only rule applies to `add` and `update` when `assignees` is present (as v1 `calendar_add` / `calendar_update`) |

---

## 10. v1 → v2 mapping (model-facing) and v2 → wire (Node translator)

| v1 tool | v2 call | Wire sent by Node |
|---|---|---|
| status / look_around / inventory / crew / list_pcs / recent_events / menu_state | `observe{sections:[…]}` | obs.query status / look_around / inventory / crew / list_pcs / recent_events / menu_state |
| job_status | `job{action:"status"}` or `observe jobs` | obs.query job_status |
| find | `find{target,…}` | obs.query find{what,…} |
| recipe | `craft{item,plan:true}` | obs.query recipe{item,count,tree} |
| goto{pos\|entity\|place} | `goto{to}` | goto{pos\|entity} |
| mine{block,count} | `gather{item,count}`; single block: `use{break}` | collect{…} / dig{p,p} |
| collect | `gather` | collect{…,make_tools} |
| hunt{entity,count} | `gather{item:<drop>}` for drops; `use{attack,target,count}` to kill N | collect / hunt |
| pickup | (Pickup reflex) or `gather{item}` | collect |
| dig / farm / build | `build{action:"dig"\|"farm"\|"blueprint"}` | dig / farm / build |
| place / use_block / use_item / attack / sleep / ride / dismount | `use{action:…}` | same skills |
| equip / eat / drop / give / container | `items{action:…}` | same skills (container: put → store, take, list) |
| craft / smelt | `craft{item}` (smelting is part of the tree) | craft{tree:true} (mod uses its smelt job internally) |
| open_menu / menu_click / menu_close | `menu{action:…}` | same skills |
| stop / wait | `job{action:"stop"\|"wait"}` | skill.cancel / awaitJob |
| set_mode, tell, remember, sit_at_pc, stand_up, request_hire | same | same |
| say / emote | `say{text?, emote?}` | agent.say / skill.run emote |
| codex_search / codex_read / codex_list / codex_write | `codex{action}` | OrgApi |
| calendar_list / add / update / cancel, report_task | `calendar{action}` | OrgApi |

---

## 11. Mod-side changes (protocol-additive) and compatibility

All changes are additive. v1 skill names and args keep working for older Node versions, `/mv skill`, `/mv obs` and GameTests. Node v2 stops sending `mine`, `pickup` and `smelt` (except in fallbacks). Gson ignores unknown fields, so an old mod would silently ignore new args. Node therefore must check `hello.caps` (M8) before relying on them.

**M1 `sequence` skill.**
- New `SequenceJob extends SkillJob`.
- Each child is built up front with `SkillFactory.create`. A BAD_ARGS error is rejected with `step i: …`.
- Children run in order inside one job id. `start`, `step`, `onResume`, `onPreempt`, `cancel` and `onFinish` are delegated to the child.
- Progress: `step i/n <child progress>`. Timeout = sum of child timeouts, capped at 40 min.
- With `stop_on_fail`, a failed child fails the sequence with the child's code and `msg="step i/n <skill>: …"`.
- Result:
  ```
  {completed, steps:[{skill,status,code?,msg?,result}]}
  ```
- Excluded children: `sequence`, `emote`, seat jobs.
- Protocol (skills.ts):
  ```ts
  SKILL_NAMES += 'sequence';
  SkillArgs.sequence = z.object({
    steps: z.array(z.object({ skill: SkillName.exclude(['sequence', 'emote']), args: JsonObject })).min(2).max(8),
    stop_on_fail: z.boolean().optional(),
  });
  ```
  Node validates each step's args with `SkillArgs[skill]`.

**M2 `collect` becomes gather (on top of W1).**
- Additive args: `near?: BlockPos`, `make_tools?: boolean` (plus W2's consent field).
- Source order: loose items → W1 natural blocks → animals (drop table: beef/leather → cow, porkchop → pig, mutton/wool → sheep (shear if shears), chicken/feather → chicken, rabbit/rabbit_hide → rabbit).
- Animals are skipped inside protected zones and when name-tagged, leashed, tamed or baby. If the only candidates are skipped animals, the job fails with NO_NATURAL_SOURCE and the reason "animals are in the Base". Entity provenance is a W1 follow-up (§15).
- Tool handling: `make_tools` crafts the needed tool tier from the inventory (planks/sticks/cobblestone) via the M4 resolver, without gathering. Otherwise the job fails NEEDS_TOOL.
- Drops: pick up within 5 blocks for up to 100 ticks after each break, which fixes D4. `count` is inventory delta of `item`.
- Result:
  ```
  {item, got, have, sources:[{kind:"tree"|"ore"|"stone"|"animal"|"ground", what, pos, n}], tools_made:[], replanted, items:{…}}
  ```
- Radius cap stays 64.

**M3 Miner reports unreachable correctly (D2).** When the scan is empty only because targets were skipped as unreachable, Miner returns FAILED UNREACHABLE (or NO_NATURAL_SOURCE under W1 rules) with `result.candidates:[{pos, why}]`, not NONE_LEFT. `mine`, `collect` and `dig` all benefit.

**M4 Craft tree.**
- Additive args: `tree?: boolean`, `gather_missing?: boolean`.
- A new `RecipeTree` (in Recipes.java or a new RecipeTree.java) does the resolution:
  - Pick recipes by inventory fit, preferring 2×2.
  - Expand craftable or smeltable ingredients to depth ≤4, netting out the inventory.
  - Guard against cycles: never expand storage compressions (nugget ↔ ingot ↔ block, log ↔ wood) unless the inventory holds that form, and never expand into a recipe that consumes an ancestor.
  - Raw leaves (logs, cobblestone, raw_iron, string, …) are gathered through child `collect` jobs when `gather_missing`; otherwise MISSING_INGREDIENTS with `result.missing:[{item, need, have, for}]`.
- Stations:
  - Use an existing table or furnace within 24 (Base stations are usable; that is non-destructive).
  - Else use the agent's own from the inventory.
  - Else craft one (adds to the tree).
  - Place it **outside protected zones**: when the agent stands in the Base it walks to the zone edge (≤16 blocks), and fails NO_ROOM otherwise.
- Smelting reuses `CraftJobs.Smelt` as a child. Fuel comes from the inventory (coal, charcoal, planks, logs); with `gather_missing`, coal is gathered or logs are used.
- Result:
  ```
  {item, crafted, have, steps:["oak_log 1 → oak_planks 4", …], station:{kind,pos,placed}, gathered:{…}}
  ```

**M5 `obs.query recipe{item, count?, tree?}`.** With `tree:true`, it returns the M4 plan without acting (`plan:true` path).

**M6 Container and give defaults.**
- `container.pos` is optional: nearest chest or barrel within 24. W1 makes `take` from player chests PROTECTED unless the player consented. The refine changes to "put/take need item".
- `give.count` is optional and means all.

**M7 Radius caps.** Raise the `look_around` radius cap from 32 to 48 (scene; section-palette skipping keeps it cheap) so it matches the v2 schema. `find` stays ≤64 with `limit` ≤10. Tool and mod caps are tested to agree (fixes D8).

**M8 `hello.caps: string[]`** (additive, protocol §6.1): `skill.sequence`, `collect.gather`, `craft.tree`, `obs.recipe.tree`, `container.nearest`, `give.all`, `run.replaced`, `obs.observe`, plus W1's caps (e.g. `perception.scene`, `provenance`). Node picks the native path or its fallback per cap.

**M9 (optional)** `SkillRunResult.replaced?: {jobId, skill, text}` when `replace` cancelled a job.

**M10 (optional, phase B+)** `obs.query observe{sections, detail, radius}`: one same-tick snapshot, so observe needs one bridge round trip.

**M11 Docs and tests.**
- protocol.md §6.1 (caps), §7.4 (sequence, args), §7.4.2 conventions (gather sources and animal rules, craft tree, station placement), fixtures.
- SKILLS.md.
- GameTests:
  - the incident structure: house plus reachable and unreachable oak → `sequence[collect oak_log 6, craft crafting_table]` makes a table and leaves the house intact;
  - Miner unreachable gives UNREACHABLE;
  - craft tree for crafting_table from logs and for iron_pickaxe with smelting;
  - sequence stop_on_fail and preemption;
  - animal rules;
  - drops fully picked up.

---

## 12. Node-side changes

- **N1** `tools/mcServer.ts`: the v2 definitions (§5). v1 moves to `tools/mcServerV1.ts` behind `MINEVIBE_MC_TOOLS=v1|v2` for the A/B (the default flips in phase C).
- **N2** `tools/targets.ts` (new): the position and target parsers (§4.1–4.2). It absorbs `resolvePlace` and is shared by single tools and `do`.
- **N3** `tools/translate.ts` (new): the v2 → wire table (§10), per-action validation with example errors, consent attachment (W2 hook), and cap-based fallbacks (Node-side `do` macro, single-level craft).
- **N4** `tools/format.ts` (new): renderers per obs query and per skill result, the error renderer with the §8 hint table, the footer policy (§6.4), caps and truncation. It replaces `compactJson` and `summarizeResult` for mc. Golden tests use recorded mod JSON (e2e events.jsonl replies: look_around, find, inventory, mine failures).
- **N5** `tools/catalog.ts`: v2 names and `categoryOf` (§9). **ToolGate.ts** `decideMc` becomes input-aware.
- **N6** `AgentBrain.ts`: the job registry (§7). `wait` returns the formatted result. The replace notice. `ACTION_WAIT_S` goes in constants.ts.
- **N7** `EventRouter.jobEnded`: uses format.ts (§6.5) and keeps partial results.
- **N8** `createSdkMcpServer({ instructions })`: the short mc playbook (Appendix A, ~150 tokens, stable and cached). World rules stay in W2's persona primer.
- **N9** Text references to renamed tools:
  - persona.ts: `calendar_add` → `calendar{action:"add"}`, `codex_search` → `codex{action:"search"}`, `report_task` → `calendar{action:"report"}`.
  - contracts/OrgApi.ts, contracts/orgTools.ts, org/calendar/CalendarService.ts, org/toolInputs.ts, AgentManager.ts (`codex_read`), EventRouter.ts (`report_task`).
  - Unchanged: tell, stand_up, sit_at_pc, remember.
- **N10** FakeSkillApi: `sequence` support, scripted obs JSON for formatter tests, caps.
- **N11** Resumed sessions: when a session first runs with v2 (its transcript holds v1 calls), inject a one-time `[MV:<nonce> TOOLS UPDATED]` context note listing the renames (mine/collect → gather, …). Claude Code rejects unknown tool names itself ("No such tool available"), so the gate cannot catch them.
- **N12** W2's `npm run eval:world` gets a `--tools v1|v2` flag and the scenarios in §14.

---

## 13. Token cost before and after

All figures: chars of `{name, description, input_schema}` JSON as listed by the in-process MCP server; ≈tokens = chars/4.

| | v1 | v2 | v2 with deferral (phase C) |
|---|---|---|---|
| Tools in the prompt | 54 | 20 | 16 (+ menu, codex, calendar, request_hire via tool search) |
| Chars | 28,204 | 16,020 (+8 with `rules`) | 11,702 |
| ≈Tokens | 7,051 | 4,005 (−43%) | 2,926 (−59%) |
| Description chars (teaching) | 3,819 (14%) | 5,981 (37%) | — |
| Schema chars | ≈24.4k | ≈10.0k | — |
| Server instructions | 0 | ≈600 chars ≈150 tok | same |
| Footer per call | ~30 tok on every call | ~30 tok on world, job and find calls only | — |

Where the savings come from:
- `"x y z"` strings instead of int32 BlockPos objects: about −4.0k chars.
- `wait_s` removed: about −3.7k.
- 34 fewer tools: about −1.7k of `$schema` and `_meta` overhead, plus the per-tool names.
- Merged org tools: about −2.0k.
- Some of that is spent again on descriptions with when-to-use triggers and examples (+2.2k).

Per task (the incident):

| | Calls | Turns | Result chars | Outcome |
|---|---|---|---|---|
| v1 | 8 | 2 | ≈2,548 + wake | house damaged, no table |
| v2 | 1–2 (`observe` optional, `do`) | 1 + wake | ≈1,300 (scene ≤900, running ≈250, wake ≈200) | natural trees, table made, or a hard stop that asks Player |

Each avoided call on Haiku at xhigh also saves a thinking pass and 1–3 s of latency. The 40-call wandering turn cap stops being a factor.

Caching: the tool list sits at the start of the cached prefix (tools → system → messages). Caches are scoped to the model, and the default TTL is 5 min. The prefix is rewritten at 1.25× on every Haiku↔Opus swap (each sit and stand), on every wake after more than 5 min idle (common for wandering agents), and on every session start or resume. So the roughly 3k tokens saved count mostly at cache-write price, not at the 0.1× cache-read price.

Deferral (phase C) needs a check: does tool search actually run for Haiku 5.5 in CLI 2.1.293? Until then all 20 tools stay `alwaysLoad`. Mechanism: server `alwaysLoad: false`, per-tool `tool(…, {alwaysLoad:true})` on the core 16, `searchHint` on the 4 deferred ones (SDK `tool()` extras).

Out of scope but flagged: the pc server (20 tools, ≈2.2k tok) is always loaded for wandering agents (D16).

---

## 14. Rollout and evaluation

- **Phase A (Node only, after W1 and W2 merge):** N1–N12 behind `MINEVIBE_MC_TOOLS=v2`.
  - `observe` uses existing obs queries plus W1's scene.
  - `gather` uses W1's natural `collect`.
  - `do` uses the Node fallback macro.
  - `craft` uses the v1 single-level craft, with `plan` built from v1 `recipe`.
  - Default stays v1.
- **Phase B (mod):** M1–M9. Node switches to the native paths per `hello.caps`.
- **Phase C:** default v2. v1 definitions are removed one release later. Optional deferral (§13).
  - Done 2026-10-09 (track P1, §16.10) on the after-v2 eval (docs/design/EVALS.md "After v2": mc 9/15 → 14/15,
    house intact 15/15), not on the full N=5 A/B gate below; `MINEVIBE_MC_TOOLS=v1` stays as the fallback.
- **Eval** (extends W2's `eval:world` harness: fake SkillApi plus incident-modelled scene; Haiku 5.5 at xhigh via the bundled binary; v1 vs v2, N=5 runs per scenario):
  - S1: "collect 10 oak logs and make a crafting table" (reachable oak 28 m S, unreachable oak 11 m NE, player cabin 2 m).
  - S2: same, but no reachable natural trees.
  - S3: "make an iron pickaxe" (needs smelting; has raw_iron).
  - S4: "give Player 5 bread".
  - S5: "build a shelter here".
  - S6: "sit at linux-1 and run tests".
- **Metrics:** task success; protected-violation attempts (target 0); substitution without asking (target 0); calls per task; turns; tool-result chars; prompt-prefix tokens (`usage`); BAD_ARGS rate per action enum.
- **Gates to flip the default:**
  - S1 in ≤3 calls in ≥4/5 runs.
  - S2 asks Player in 5/5.
  - No regression on S6.
  - BAD_ARGS ≤5% of calls.
  - Report honestly in docs/design/EVALS.md (W2).

---

## 15. W1/W2 reconciliation and open questions

| v2 relies on | W1/W2 brief says | Confirm once merged |
|---|---|---|
| `observe` scene | `look_around` returns a compact scene, brief ≤900 / full ≤2500 chars (zone, trees by species with trunk pos/direction/reachability, structures, hazards, player and crew) | arg name for detail; JSON shape vs text; who renders (prefer Node via format.ts; pass through mod text if W1 emits it) |
| `find.source` | find supports natural/built filters, reachability, provenance | wire arg name and values; v1 key is `what` |
| PROTECTED | typed failure `{pos, what:'player-built'\|'base', owner}` with a teaching message | where the payload lives (error.msg vs result) |
| NO_NATURAL_SOURCE | nearest candidates and why | candidates shape (reuse for M3 UNREACHABLE) |
| Consent | Node-issued, short-lived, scoped token on an additive protocol field; never minted by the model | field name per skill; v2 attaches it per wire step, including `sequence` steps; retry-the-same-call UX |
| Footer zone | "in Base" / "12m from Base" | — |
| Natural `collect` (whole trunks, replant) | yes | replant flag/default; M2 builds on it |
| W2 tool descriptions (v1 tools) | precise v1 descriptions | superseded by §5 when v2 ships; the world primer is kept and its tool names updated (`look_around` → `observe`) |
| W2 `eval:world` | fake SkillApi incident world | extended per §14 |

Open questions:
1. Does tool search (deferral) work for Haiku 5.5 in CLI 2.1.293, and does Claude Code strip `$schema` from MCP schemas? The second only changes absolute counts.
2. How well does Haiku 5.5 follow action enums? Measure per-action BAD_ARGS in the eval. If one action stands out, split it out as its own tool.
3. Entity provenance (player-bred, fenced or penned animals) is not in W1. M2's animal rules are a stopgap, proposed as a W1 follow-up.
4. Station placement: is "walk out of the Base to place a table" acceptable, or should craft prefer Base stations only and fail otherwise?
5. The footer policy amendment (§6.4) needs a PLAN §6.5 and protocol.md §7.4 edit.
6. `do` steps are untyped (`args: object`) in the schema to save tokens; a `oneOf` per tool would cost about 3k chars. Node validates them instead. Revisit if the step BAD_ARGS rate is high.
7. Should `craft` default to `gather_missing:true`? It is kept false for safety and time; the error hint teaches the flag. Revisit with eval data.

---

## Appendix A: mc server `instructions` (draft, ~150 tokens)

```
How to use the mc tools:
- One request, one composite call: "get N X" → gather; "make X" → craft; several known steps → do. Don't chain low-level use/goto calls for these.
- Unsure where you are or what is around? observe first (read-only; may run in parallel with find).
- World tools may answer "running": end your turn; [JOB DONE] or [JOB FAILED] wakes you with the result.
- Failures end with "next:"; follow it. PROTECTED, and NO_NATURAL_SOURCE for what the player named, are hard stops: ask the player, never substitute. Ingredients they did not name can be any kind.
- Positions are "x y z" strings; copy them from results.
```

## Appendix B: incident replay, v1 vs v2

v1 (observed, 8 calls, 2 turns):
mine NOT_FOUND → find → mine UNREACHABLE → look_around → mine #minecraft:logs (the cabin) → [JOB DONE] → inventory → stop → remember.

v2 (target):
1. Turn 1:
   - `observe{"sections":["scene","inventory"]}` (optional) shows: inside Base (protected); oak 28 m S reachable; oak 11 m NE unreachable; cabin player-built.
   - `do{"steps":[{"tool":"gather","args":{"item":"oak_log","count":10}},{"tool":"craft","args":{"item":"crafting_table"}}]}` → `running: do step 1/2 gather oak_log 3/10 (job j2-9, 20s so far)`.
   - Agent says: "Getting 10 oak logs from the trees south of the base, then I'll make the table."
2. Wake: `[JOB DONE] j2-9 do 2/2 steps in 81s | gather oak_log 10/10 from 2 oak trees near 6 66 24 | craft crafting_table ×1 | have crafting_table 1, oak_log 9`. The agent reports with 0 calls.
3. Variant without a reachable tree: `[JOB FAILED] … NO_NATURAL_SOURCE … next: ask Player`. The agent calls AskUserQuestion (go further / another wood / skip). No blocks are broken.

## Appendix C: measurement method

The tool lists were obtained by running the real `createMcServer` (v1) and a scratch v2 definition through `createSdkMcpServer` plus an in-memory MCP client (`@modelcontextprotocol/sdk` 1.32.1, agent SDK 0.3.293), then serializing `{name:"mcp__mc__…", description, input_schema}` per tool.

The design-time scripts were scratch files (v1 28,204 chars, pc 8,751, v2 draft 16,020). `npm run measure:mc-tools -w apps/server` (`apps/server/scripts/measure-mc-tools.ts`) now measures the real v1 and v2 lists the same way (§16.6).

Transcripts were parsed with a scratch script.

---

## 16. Implementation (track B1, 2026-10-09)

Phases A and B are built on branch `worktree-wf_e-5`, merged with W1 and W2. The default stays **v1**
until the §14 gates are met. No live model run was allowed in this track, so the A/B eval is still to run (§16.8).

### 16.1 Switching

- `MINEVIBE_MC_TOOLS=v1|v2` (`contracts/mcRefs.ts`, default `v2` since phase C; it was `v1` until §16.10), or
  `AgentManager({ mcTools })`.
- `npm run eval:tools -- --suite mc [--tools v1] [--mod v1]` replays the scenarios with the v2 scripts (default) or
  the v1 ones; `--mod v1` simulates a mod without caps. PC scenarios have one script either way.
- `npm run eval:world [-- --tools v1]` runs W2's live scenarios (`MINEVIBE_MC_TOOLS` otherwise, default v2).
- `npm run measure:mc-tools -w apps/server` prints the §13 numbers for both sets. It makes no model calls.
- v1 is frozen in `tools/mcServerV1.ts` as main had it after W1 and W2. `tools/mcServer.ts` picks the set.
- Every text that names a tool goes through `mcRefs(version)`: the persona, the Codex digest and its hints, calendar
  and `report_task` texts, org tool errors, and the EventRouter's report hint.
- A resumed session whose transcript used the other set gets the one-time `TOOLS UPDATED` note (N11).

### 16.2 Node files (N1-N12)

| File | What |
|---|---|
| `tools/mcToolsV2.ts` | The 20 definitions, with the §5 descriptions verbatim and Appendix A as the server `instructions`. `observe` runs its sections in parallel; `job` and the consent retry also live here. |
| `tools/targets.ts` | §4.1 and §4.2: `"x y z"` positions, and targets resolved in the order pos → player → crew → place → `pc:` → uuid → mob. |
| `tools/translate.ts` | v2 → wire (§10): per-action validation with example errors, cap checks and fallbacks, `do` steps. |
| `tools/format.ts` | Renderers for every obs query and skill result, the §8 hint table, the footer policy (§6.4), size caps, and wake texts. |
| `tools/jobs.ts` | The per-agent `JobRegistry` (§7): current job, the last 5 ended, cancellations by the agent, and the last refused call. |
| `contracts/SequenceFallback.ts` | The Node `do` macro (`m…` ids) for mods without `skill.sequence`. |
| `ToolGate.ts`, `catalog.ts` | The §9 categories are input-aware: `items{equip/eat}`, `menu{state}`, `job` and `craft{plan}` are always allowed. |

### 16.3 Mod (M1-M11)

- **Done:** M1 (`SequenceJob` with a `ChildRunner` that gives each child the JobRunner's lifecycle), M2, M4 and M5
  (`RecipeTree`, `CraftTreeJob`), M6, M7, M8 and M9.
- **M3** is W1's: when the only matches were skipped, NONE_LEFT becomes `NO_NATURAL_SOURCE` with
  `candidates[].why = "unreachable"`.
- **M10** (a one-tick `observe`) is not done. `observe` makes one obs query per section, in parallel.
- **Caps sent:** `skill.sequence`, `collect.gather`, `craft.tree`, `obs.recipe.tree`, `container.nearest`,
  `give.all`, `run.replaced`, `obs.look_around.48`. There is no `obs.observe` (M10), and W1 sends no caps of its own.
- **Beyond the spec:**
  - The craft tree runs each smelt as late as it can, right before the first step that uses its output.
  - Each smelt burns only the fuel the plan set aside (`Plan.fuel`, `Smelt.withFuel`). A smelt never burns the logs
    the planks step needs.
  - When two recipes tie on missing materials, the everyday ones win: raw iron over ore blocks, cobblestone over
    blackstone.
  - v1's `craft` failure now sends `ingredients` as `[need, have]` (it sent `"[I@…"`).
  - A sequence's bad step names its skill: `BAD_ARGS: step 2: craft: item is required`.

### 16.4 Consent (the §15 reconciliation with W2)

- v2 schemas have no `allow_protected`, and the model never sees or passes a token.
- After a `PROTECTED` failure, the registry keeps the refused wire call for 10 minutes. The hint tells the model to
  ask with AskUserQuestion. When the player picks an "Allow" option, W2's ConsentLedger has a grant.
- The model then repeats the exact call. Only that call, with a grant present, goes out with `allow_protected: true`
  and the token in `skill.run.consent`. Any other call goes out without them.
- On a mod without `skill.sequence`, the Node macro gives the single-use token to the step the mod refused (it
  remembers which step each offered token came from); only for a token it never saw, to the first block-changing
  step. The mod's own sequence covers every step. (Before §16.10 it was always the first block-changing step.)
- Every skill whose args take `allow_protected` (protocol `CONSENT_SKILLS`) carries the consent, `use_block` and
  `menu_click` included since §16.10.
- Node's own Base guard (W2's `baseConflict`) runs only when the mod reports no zone, as in v1.

### 16.5 Older mods (no caps)

| Feature | Fallback |
|---|---|
| `do` | Node macro |
| `craft` | Single-level craft (or `smelt` when only a furnace makes the item); `plan` comes from the one-level `recipe` |
| `items{store/take}` | The nearest chest found through `find` |
| `items{give}` without a count | The count comes from `inventory` |
| `observe{scene}` radius | Capped at 32 |

On such a mod, `craft crafting_table` from logs alone fails `MISSING_INGREDIENTS`. The hint then says to make the
ingredients first and does not offer `gather_missing`, which an old mod would ignore. That is why the v2 replays of
`mc.logs_table` and `mc.iron` fail on `--mod v1`; the other scenarios pass.

### 16.6 Measured

| | Value |
|---|---|
| v1 tool list (W1 and W2 descriptions grew it from 28,204) | 54 tools, 32,781 chars (about 8.2k tokens) |
| v2 tool list | 20 tools, 16,051 chars (about 4.0k tokens, −51%); 37% of it descriptions |
| v2 core (16 tools) | 11,702 chars |
| v2 `instructions` | 568 chars |

Replays (`eval:tools`, scripted, no model calls): calls per scripted good run, v1 → v2.

| Scenario | v1 | v2 |
|---|---|---|
| `mc.logs_table` | 3 | 1 |
| `mc.iron` | 3 | 1 |
| `mc.store_logs` | 2 | 1 |
| `mc.dark_safe` | 1 | 1 |
| `mc.unreachable_ask` | 2 | 2 |

Every v1 and v2 script behaves: good runs pass and bad runs fail. The incident (S1) is 1 call: `do[gather, craft]`.

### 16.7 Tests

- **Node:**
  - `toolsV2.test.ts`: schemas, descriptions, `do` validation, the gate, the consent retry.
  - `toolsV2Format.test.ts`: renderers, hints, footer, caps.
  - `toolsV2Runtime.test.ts`: the registry, wakes, the replace notice, the macro fallback.
  - `toolsV2Replay.test.ts`: v2 replays, v2 on the v1 mod, the simulated v2 mod.
  - The protocol fixtures and schema tests for every additive field.
- **Mod:**
  - `RecipeTreeTest`, with a hand-written book that has vanilla's alternatives.
  - `SkillFactoryV2Test`, `MsgCatalogTest` (the `replaced` fixture).
  - 12 GameTests in `SkillsV2GameTests`:
    - the incident as one sequence (natural oak only; the house and the pillar tree untouched);
    - the craft tree: gathering what is missing, listing missing raw materials, smelting for an iron pickaxe, planning
      without acting;
    - `stop_on_fail` on and off, and a bad step rejected up front;
    - `make_tools`, animal drops (never a named animal), the nearest chest, and `hello.caps`.

### 16.8 Open

- **Default flip (phase C):** done in §16.10 on the after-v2 eval; the live A/B of §14 (S1-S6, N=5, v1 vs v2) is still
  to run, with `eval:world` and `eval:tools -- --mode live` (both v2 by default now).
- **Deferral:** not done; all 20 tools are `alwaysLoad`. Tool search is still unverified for Haiku 5.5.
- **M10:** one-tick `observe`.
- **Entity provenance** for animals (§15 Q3).
- The simulated mod's craft tree is a simplified `RecipeTree`: it does not reorder smelts and does not set fuel aside,
  and its gathering makes no tools (the mod's does).

### 16.9 Review fixes

- **`do` could never be allowed after `PROTECTED`.** A sequence keeps the refused step's `protected` detail (and its
  consent token) in `steps[i].result`; Node read only the top level, so the player's "Allow" found no token (the Node
  macro even overwrote the step's good refusal with an empty one). `refusalOf` now reads the refused step.
- **`craft` dropped its consent.** The craft tree's gathering can be refused `PROTECTED`, and the retry sent
  `allow_protected`, but the wire schema of `craft` had no such field, so it was stripped and the player's token used up
  for nothing. `craft` takes `allow_protected` now (protocol, additive).
- **`job{wait}` woke the agent twice.** A job that ended while `job{wait}` waited for it also sent `[JOB DONE]` after
  the turn, one more turn for a result the agent already had. The registry marks the awaited job; its end wakes no one.
- **A gather of a block that drops something else broke every one in reach.** `gather{item:"stone"}` (or an ore)
  became `collect` of an item that never lands in the bag, so the job mined until the radius or its timeout ran out
  (v1's `mine` counted blocks). Node now asks for the drop (`stone` → cobblestone, `iron_ore` / `#iron_ores` →
  raw_iron, ...: `DROPPED_AS` in translate.ts), and the mod's `collect` stops after `count` such blocks with a `note`.
- **The Node macro could replace the agent's next job.** A job started between two steps did not end the macro, whose
  next step then cancelled it. A replacing run now ends the macro first.
- **A refused start lost track of the running job.** When the mod refuses a new call before starting it (`BAD_ARGS`),
  the job it would have replaced runs on; the registry now keeps it current, still due its wake.
- **The replace notice** uses the mod's `replaced` (cap `run.replaced`) when there is one: no notice for a job that had
  already ended, and a notice for a job no tool started.
- **Composites:** a cancelled sequence no longer lists a step that never started; `collect` falls back to animals once
  no natural block of the item is left (wool from sheep); the craft tree's gathering makes the tools it needs and
  replants, as `gather` does; a station is put down outside protected zones when there is room (the tree walked out of
  the Base and then put the table back inside, one block over the edge).
- **Hints** that suggested an invalid call now suggest a valid one (`items{"action":"store"}` without an item;
  `codex` search with an empty query), checked by a test that runs every suggested call.

### 16.10 Default switch and the after-v2 eval fixes (track P1, 2026-10-09)

The after-v2 eval (docs/design/EVALS.md "After v2") and DEBT.md ("Found in the after-v2 tool eval") left these; all
are fixed, each with a replay of the real session wiring against the simulated W1 mod
(`apps/server/test/unit/eval/toolsV2Polish.test.ts`).

| What | Fix |
|---|---|
| Default | `MINEVIBE_MC_TOOLS` defaults to `v2`; `v1` is the fallback. `eval:tools` and `eval:world` default to v2 as well (`--tools v1` for the old set). Tests that cover v1 pin it (`vi.stubEnv` or an explicit version); the default paths (AgentManager, the brainless e2e, calendar texts) now test v2. |
| `do` with one step | `steps` takes 1-8 (`minItems` 1). One step runs as that tool: the same wire call, the same result and wake (`done: gather oak_log 10/10`, not `do 1/1`), a failure under the tool's own label (`failed: items give`), and a lone `craft{plan}` or `items{list}` answers as its tool. A mod `sequence` still holds 2-8. |
| NEEDS_TOOL hint | Names the tier the block needs (`pickaxeFor`, vanilla's `needs_*_tool` tags: stone, coal and a redstone block wood; iron/copper/lapis and raw iron/copper blocks stone; gold/diamond/emerald, redstone ore and a raw gold block iron; obsidian diamond). With the craft tree: `craft{"item":"<tier>","gather_missing":true}` (it gathers the wood it lacks). On an older mod, Node reads the inventory for this one failure and says to gather logs first (none or too little carried: 3 planks for the head, 2 more for the sticks unless 2 are carried, 4 planks a log), to craft only the planks or sticks still missing, or to craft the pickaxe; a wake without that look says both ways. |
| Host paths | Claude Code (persistSession) adds `[Image: source: <host path>]` after every MCP image, and its environment names the session's working directory, both on MineVibe's host. The seated primer has one rule (`HOST_PATHS_RULE`), `screenshot` and `zoom` one sentence (`IMAGE_NOTE`). A replay checks that PC results and kickoffs name no host path (home or temp directory); Vault mounts are path-identical by design. The check found one more way in: an unexpected host-side error (a socket, a temp file) or `PC_DOWN` reached the agent verbatim; `PcToolContext.errorOf` now replaces paths under the home, Application Support and temp folders with `<MineVibe host path>` (`redactHostPaths`), keeping the PC's Vault folders and the guest's own errors as they are. |
| Consent for right-clicks | `use_block` and `menu_click` take `allow_protected` (protocol, additive; protocol `CONSENT_SKILLS` lists every skill that does, and Node's consent sets come from it). The mod already redeemed tokens for any skill's args; its records gained the field, and a GameTest allows Steve's pot and chest with a token. The "cannot be allowed" hint remains only for a skill without the field. The `CONSENT` notice of a grant tells a v2 agent to repeat the exact refused call (v1: "retry with allow_protected:true", an argument v2 does not have). |
| Consent on Node's macro | The macro remembers which step each offered token came from and hands it to that step on the retry (before: the first block-changing step, so `do[gather, dig the wall]` spent the token on the gather). |
| The eval's world | The simulated W1 mod now has the Base zone (the house plus 2 blocks, Jasper's), `Protection.check` (player-built, zone, under a player's roof, the running job's grant), `Consents` tokens, and the mod's shapes: `look_around` is a port of `Scene.lookAround` (Here, the zone, hazards, trees with reachability, `Built: Base …; Jasper's build (174 blocks) 7m SE`, people, resources, ground; brief ≤ 900, full ≤ 2500), `find` has provenance with owner and zone, reachability on the nearest three and `protectedNote`, `PROTECTED` is `refuseProtected`'s detail and message (container take, use_block on a pot, dig, place and build too), `NO_NATURAL_SOURCE` is `noNaturalSource`'s (candidates with distance and direction, too-far trees, 3 per kind), and status and the footer name the zone. `scripts/eval/worldEval.ts` (the `eval:world` fake) uses the same shapes for its W1 scenarios. |
| Night safety | The world primer (v1 and v2): a shelter that stands beats building one; ask the player into the Base or their house and walk there together; call them safe only once the scene shows them `under cover`; until then follow them (guard mode holds the spot where it was set), then guard there. The mod's People line says so for players (`Jasper (player) 4m S, in Base, under cover` / `…, in the open`; `Scene.shelterWords`; the roof is the `MOTION_BLOCKING_NO_LEAVES` heightmap, so a tree's leaves are no cover). `observe`, `build` and `set_mode` descriptions follow; a done `build shelter` says to bring the player in and check, and its `NO_MATERIAL` points at the shelter that stands. `mc.dark_safe`'s v2 script asks, checks and guards; a soft `checked_player_inside` check reports whether a live run looked. No gameplay shortcut: the player still walks in on their own. |
