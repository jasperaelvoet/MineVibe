# Spike S3b: switching the visible tool set between Minecraft mode and PC mode

The idea: make the mc tools unavailable while seated at a PC, and the pc tools unavailable while wandering. Do it at the same turn boundary as the model swap (Haiku 5.5 xhigh ⇄ Opus 5.5 medium), since that swap already forfeits the prompt cache. Each mode's prompt would then be smaller and more focused.

The profiles tested (`src/profiles.mjs`, which uses a 13-tool mc / 7-tool pc slice of the real catalog):

| Profile | Model | Should see |
|---|---|---|
| wander | Haiku 5.5, xhigh | all 13 mc tools; no pc tools, no WebSearch/WebFetch |
| seated | Opus 5.5, medium | all 7 pc tools, WebSearch/WebFetch, and mc `status, look_around, stand_up, say, tell, remember, codex_read, calendar_list, report_task`. Not `goto, mine, craft, sit_at_pc` |
| meeting | Haiku 5.5, xhigh | mc `say, tell, remember, codex_read, calendar_list, report_task, stand_up` only |

Run on 2026-10-09 against the live Claude subscription. Raw evidence is in `out/` (gitignored and sanitized: no e-mail, organisation id or tokens).

| Item | Value |
|---|---|
| SDK / CLI | `@anthropic-ai/claude-agent-sdk@0.3.293`, SDK-bundled CLI `2.1.293`, Node 24.20.0, `apiKeySource: "none"` |
| Session shape | Production `buildSessionOptions` shape (allowlisted env, `settingSources: []`, `strictMcpConfig`, built-ins `AskUserQuestion, EnterPlanMode, ExitPlanMode, WebSearch, WebFetch`, Bash…Task disallowed and aliased to `mcp__pc__*`, in-process `mc`/`pc` servers with `alwaysLoad: true`, a ToolGate-like PreToolUse hook) |
| Live usage | **12 of 12 model turns** (3 per mechanism, enforced by `out/budget.json`), 26 API calls, about $0.36 at list price. The 5-hour window went from 0.80 to 0.82 |
| Zero-cost checks | `npm run preflight` and `npm run dry` made 0 API calls. They probe the CLI with a `shouldQuery:false` context message, which re-emits `system/init` without a model turn |

Repeat with `npm install && npm test && npm run preflight && npm run dry`. The live runs are `npm run m1|m2|m3|m4` (each refuses to start if fewer than 3 of the 12 turns are left), then `npm run summary`.

## Recommendation

**Adopt none of M1–M3. Keep one stable tool list and make the mode switch a prompt-level change.**

- **Why not M1 (flag-layer deny rules)?** It hides no MCP tool. Worse, a deny rule set at launch could not be lifted with `applyFlagSettings`, so the seated agent's `mcp__pc__bash` call was denied. Built-in tools denied at launch never came back either.
- **Why not M3 (close + resume)?** It hides no MCP tool either. The CLI pins the tool list the model sees to the conversation's first request, and the pin survives `resume`. Each switch costs 0.86–1.43 s plus a CLI respawn. It can swap the persona, but a context message does that for free.
- **M2 and the extra M4.** These are the only mechanisms that change what the model is offered, and only for tools that were absent at the first request. Added tools arrive as an in-message definition. Removed tools get a notice and a CLI-side block. Neither makes the prompt smaller once the conversation exists.

What to do instead:

1. Keep registering `mc` and `pc` at session start with `alwaysLoad: true`. Keep the ToolGate as the only enforcement; it already denies world tools while seated and pc/web tools while wandering.
2. At every boundary, send a **mode banner**, either inside the sit kickoff message or as a `shouldQuery:false` context message on stand/meeting. It carries the mode, the persona delta, and "available now / blocked until you stand up". It costs about 50–100 appended tokens and doesn't touch the cache.
3. Keep the tool list and the static system prompt identical across agents and modes, with the persona last in `append`. This run read 7–9k-token prefixes cached by *other* sessions within the 1 h TTL.

The premise behind the idea is half right. Changing the tool set at the sit costs nothing extra in cache terms, because the Opus prefix is rewritten anyway. But the hoped-for result, a smaller and more focused per-mode prompt, can't be had once the conversation exists.

## Results

| | **M1** `applyFlagSettings({model, effortLevel, permissions:{deny}})` | **M2** `setMcpServers` (pc removed/added) + flag swap | **M3** `close()` + `resume` with per-mode options | **M4 (extra)** MCP `RegisteredTool.disable()/enable()` (`tools/list_changed`) + flag swap |
|---|---|---|---|---|
| pc hidden while wandering (T1, first request) | **No**: Haiku listed all 7 pc tools, and its call reached the gate | Yes (pc not registered) | **No**: listed, and the call reached the gate | Yes (pc disabled before connect) |
| pc usable when seated (T2) | **No**: still listed, but the launch-time rule stuck: `Permission to use mcp__pc__bash has been denied.` | Yes, callable at once and not deferred (connect 31 ms) | Yes (it was never hidden) | Yes, callable at once (re-list 29 ms) |
| `goto/mine/craft/sit_at_pc` hidden while seated | No: listed, gate denied | Can't be expressed: listed, gate denied | No: listed, gate denied | CLI blocks the call: `No such tool available: mcp__mc__goto. Its MCP server 'mc' is connected but does not offer this tool here.` Not announced; Opus still listed `craft, mine, sit_at_pc` |
| pc hidden again after standing (T3) | (it was never hidden) | Yes: removal notice, and the model skipped the call | No: listed, gate denied | Yes: removal notice, and the model skipped the call |
| WebSearch/WebFetch per mode | Hidden at launch, **never come back** (missing when seated) | Can't be expressed | Yes, through a delta notice on resume | Can't be expressed |
| Switch latency (to seated / to wander) | 104 / 63 ms | 97 / 61 ms (setMcpServers ≤1.5 ms + flags 60–64 ms + connect 31 ms) | **1,429 / 857 ms** (close 814/258 ms + respawn to init 615/599 ms) | 95 / 92 ms (toggle <1 ms + flags 63–66 ms + re-list 29 ms) |
| Send → first assistant message, T2 / T3 | 2.1 / 0.9 s | 1.6 / 1.8 s | 6.3 / 1.9 s | 2.0 / 2.1 s |
| Up-swap: first Opus call, cache read / write | 0 / 11,498 | 0 / 12,680 | 7,056\* / 5,173 | 8,904\* / 3,485 |
| Down-swap: first Haiku call, cache read / write | 10,130 / 2,422 (all of T1) | 8,904 / 5,018 | 10,169 / 3,049 (all of T1) | 8,904 / 4,802 |
| Conversation kept (codeword from T1 in T2) | yes | yes | yes (same session id, 0 duplicate uuids in the transcript) | yes |
| Other effects | none beyond the swap | add/remove notices land in the history | CLI respawn; persona swap works; Pre/PostModelSwitch hooks don't fire | relies on the SDK's private `McpServer._registeredTools`; mc removals are silent |

\* A cross-session hit: an earlier mechanism's run had cached the same tools + static-system prefix within the 1 h TTL. That is evidence for the pinned list (next section), not a property of M3/M4.

The PostModelSwitch hook estimated the cache-write cost at $0.088–0.090 for haiku→opus and $0.0025–0.0027 for opus→haiku, the same in every mechanism.

### Zero-turn preflight (`src/preflight.mjs`, 0 API calls)

`init.tools` after each switch, compared with the profile:

| Probe | Matches profile? | Detail |
|---|---|---|
| P1 M1: deny at launch, then apply seated → meeting → wander | No | MCP tools never disappear. Web built-ins denied at launch never reappear. Each apply took 56–67 ms |
| P1 M1: rule spelled `mcp__pc__*` instead of `mcp__pc` | No | Same result |
| P1 M1: `permissions: null` | No | Web built-ins still missing |
| P1b: `Bash…Grep` in `options.tools`, denied at launch, then allowed | No | They never appear. The "aliased Bash/Read/… only while seated" variant can't be toggled live |
| P2 M2: add / remove / re-add pc (same instance) | Yes | Connect in 103–109 ms across preflight runs, not deferred |
| P2 M2: mc instance with fewer tools under the same name | No | `setMcpServers` returns `{added:[], removed:[]}` and keeps the old tools |
| P3 M3: fresh session per profile with `disallowedTools` | No | MCP tools are always present; built-ins follow the profile. Spawn to init 618–778 ms, close 665–748 ms |
| P4 M4: enable/disable for wander, seated, meeting, wander | **Yes, all three profiles** | 59–85 ms including the flag swap |

## Why: the CLI pins the tool list to the conversation's first request

What the model is offered is fixed by the conversation's first request. That holds for the rest of the conversation and across `resume`. Later changes don't edit that list; they are delivered as `deferred_tools_delta` attachments in the message history:

- **Additions.** `addedNames` plus `surfacedDefinitions`, which are the full JSON schemas inside a message. The attachment also carries `toolSearchAbsent: true`, because ToolSearch isn't in `options.tools`. The tool is callable at once.
- **Removals.** `removedNames` plus `removedByBlock`. The model gets a notice ("the harness reports mcp__pc__* tools as no longer available") and the CLI blocks calls.
- **Tools that were in the first request.** These stay in the list. Disabling one blocks its calls ("connected but does not offer this tool here") with no notice.

The evidence:

1. **Transcripts.** M4 wrote two attachments, one adding the 7 pc tools with their definitions and one removing them. The M3 resume wrote the same pair for WebSearch/WebFetch: it could not add them to the list, even though the resumed session's options allowed them.
2. **Cross-session cache reads that only a pinned list explains.**
   - M4's seated Opus call read 8,904 tokens, exactly the prefix M2's seated Opus call had cached. M2's first request carried 5 built-ins + 13 mc tools. Had M4's request carried its current list (9 mc + 7 pc), no earlier Opus request could have matched it.
   - Likewise, M3's resumed seated call read 7,056 tokens. That is the prefix M1's Opus call cached from a first request of 3 built-ins + 13 mc + 7 pc.
3. **Behaviour.** In M4, seated Opus still listed `craft, mine, sit_at_pc` although `init.tools` lacked them. Its `goto` call was refused by the CLI and never reached the gate.
4. **Deny rules never remove an MCP tool**, not even from the first request (M1 and M3, T1). They only block calls, and only after PreToolUse runs: in M1's T2 the gate allowed `mcp__pc__bash`, then the leftover launch-time rule denied it.
5. **The usual introspection doesn't show the request.** `system/init.tools` is the CLI's current list (it matched the profile in M2/M4), not the list the model sees. `getContextUsage().mcpTools` ignores deny rules altogether.

The wire request itself was never captured. A capturing proxy would need `ANTHROPIC_BASE_URL`, which changes the transport and disables tool search. So point 2 is the strongest evidence, and it is indirect.

### What the tool switch costs in cache

- **Up-swap to Opus: nothing extra.** The model change already starts a new Opus prefix.
- **Down-swap to Haiku:**
  - M1 and M3 read Haiku's whole T1 prefix (10.1–10.2k read, 2.4–3.0k written).
  - M2 and M4 hit only the 8.9k tools + static-system prefix and wrote 4.8–5.0k. The likely cause is the API's 20-block cache lookback being exceeded by the delta attachments; that is unconfirmed.
  - The extra is about 2.4k Haiku write tokens, roughly $0.0005 per stand at the hook's pricing. Negligible.

## Mechanism notes

**M1.** The settings shape (sdk.d.ts) is `applyFlagSettings({permissions:{allow?, deny?, ask?, defaultMode?, …}})`. A call replaces the whole `permissions` object, and `null` clears it.

- Live changes did nothing visible.
- Rules passed at launch through `options.settings` stayed in force after they were replaced.
- Built-ins denied at launch were dropped for good.
- It "re-enables cleanly" only in the sense that nothing was ever hidden. `goto` worked again in T3, and `mcp__pc__bash` was again stopped by the gate before the stuck rule.

**M2.**

- The result reports `added/removed` correctly. `setMcpServers` resolved in ≤3 ms, and the server connected 31 ms later live (103–109 ms in the preflight).
- Re-adding the same in-process instance works.
- Re-added tools were **not** deferred behind ToolSearch. ToolSearch isn't in `options.tools`, so their definitions are injected in-message and are callable at once (`alwaysLoad: true` set).
- It can't hide part of a server's tools: the same name with a smaller instance is treated as unchanged. It can't hide built-ins either.
- Not measured: a second sit (`readdedNames`).

**M3.**

- The conversation is kept: same session id, codeword recalled, no duplicate transcript entries. The `systemPrompt` append (persona) does change on resume. That is why the seated call shared only the 7,056-token tools + static-system prefix with an earlier session, while the return to the wander persona read Haiku's whole T1 prefix.
- Costs:
  - 0.86–1.43 s per switch, plus a respawn.
  - The first seated call took 6.3 s against about 2 s elsewhere (one sample).
  - Pre/PostModelSwitch hooks don't fire, because the model is set at spawn.
  - The transcript gained an `ai-title` entry after every turn, as M4's did.
- Resuming a session whose last entries are `shouldQuery:false` context messages adds synthetic assistant entries reading "No response requested." (seen in the dry run).

**M4 (added by this spike).**

- `createSdkMcpServer(...).instance._registeredTools[name].disable()/enable()` sends `tools/list_changed`. The CLI re-lists within about 29 ms.
- Tools disabled before the first request stay out of it, so wander T1 matched the profile exactly.
- `init.tools` matched every profile, including meeting.
- What the model sees still follows the pinning rules above. On top of that, M4 depends on a private SDK field.

## Side effects seen in every live mechanism

- **`applyFlagSettings({model})` writes into the conversation.** Each swap adds a `<local-command-caveat>` meta entry, a `/model <id>` command entry and `<local-command-stdout>Set model to …</local-command-stdout>`, so the model sees every swap. That is a few dozen tokens per swap.
- **The CLI injects account context into every agent session**, with the allowlisted env (`settingSources: []`) in place. The attachments are:
  - `session_context`: the account's e-mail address, with usage guidance
  - `credential_org`: the organisation id
  - `total_tokens_reminder`, `budget_usd` (from `maxBudgetUsd`), `date`, `environment` (cwd, platform) and `model`

  This is a **privacy issue**: agents can read the player's e-mail address. The source wasn't investigated; it is presumably the CLI's account profile.
- **Persisted sessions (production uses `persistSession: true`) wrote an `ai-title` entry after each turn.** This is probably a small background model call per turn, which isn't counted in the usage above.

## Recommended changes to PLAN / full-design (neither edited)

1. **full-design §1.4, row "setMcpServers attaches pc tools mid-session".** Keep "register both servers at start, never swap", but fix the reason. In our configuration (no ToolSearch in `options.tools`) later tools are **not** deferred. They arrive as an in-message `deferred_tools_delta` definition and are callable at once. The tool list is pinned to the first request and survives `resume`.
2. **PLAN §6.1 / §6.2.** Never put mode-dependent rules in `options.settings.permissions` or `applyFlagSettings({permissions})`. Launch-time rules can't be lifted live, and built-ins denied at launch never return.
3. **PLAN §6.2.** `disallowedTools` / `permissions.deny` don't remove MCP tools from the model's list in 2.1.293, despite the SDK doc comment; they only block calls, after PreToolUse. The ToolGate stays authoritative. `FORBIDDEN_INIT_TOOLS` is still valid, since it covers built-ins only.
4. **PLAN §6.1 startup assertions.** Don't use `system/init.tools` or `getContextUsage().mcpTools` to claim what the model sees. The first is the CLI's current list; the second ignores deny rules.
5. **PLAN §6.3, T3 fallback (close + resume).**
   - It keeps the conversation and the pinned tool list, and costs 0.86–1.43 s.
   - No PostModelSwitch hook fires, so acknowledge the swap from `init.model`. Production already marks this case `acked: false`.
   - The `systemPrompt` append may change on resume.
6. **PLAN §6.3 / §6.4: add the mode banner** described in the Recommendation, on sit (in the kickoff), on stand and on meeting.
7. **PLAN §6.1 env.** Decide what to do about the `session_context` / `credential_org` attachments, which carry the player's e-mail address and organisation id into agent prompts.

## Deviations from the brief

- **Added M4 and the zero-turn preflight / `--dry` modes** (0 API calls), so that 12 live turns could cover four mechanisms.
- **The meeting profile was checked only in the zero-turn preflight** (P1, P3, P4); the live turn cap was used up by the three-turn runs.
- **Tool lists the model gave after T1 are partly contaminated** by T1's own reply in the history. The conclusions rest on the T1 lists, call outcomes, transcript deltas and cache reads.
- **The spike gate allows or denies by the current profile**, standing in for the ToolGate. That is why hidden calls "reached the gate" in M1–M3.
- **Not tried:**
  - `toggleMcpServer`, because it may persist disabled state into `~/.claude.json`.
  - A wire capture, because it would need `ANTHROPIC_BASE_URL`.
  - A fresh session per mode, which would give a truly smaller prompt but needs a handoff summary and loses the transcript.

## Open issues

- **M2/M4 re-sit (`readdedNames`).** Does a second sit inject the definitions again? Not measured.
- **The partial Haiku cache hit after M2/M4.** It is probably the 20-block lookback; that is unconfirmed.
- **Privacy:** the `session_context` (e-mail address) and `credential_org` attachments in agent prompts.
- **The cost and latency of per-turn `ai-title` generation** in persisted sessions.
- **Leftovers outside the repo:** six spike transcript folders under `~/.claude/projects/-Users-<user>-Documents-MineVibe--claude-worktrees-wf-c-1-spikes-s3b-mode-switch-out-cwd-*`. They are `m3-*` and `m4-*` (live) plus `m3-dry-*` ×2 and `m4-dry-*` ×2.
