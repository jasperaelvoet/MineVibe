# Spike S2 + S3: Agent SDK routing, auth, HITL and model/effort swap

Run on 2026-10-08 against the live Claude subscription. Raw evidence is in `out/<check>.json` and `out/<check>.events.jsonl` (gitignored, sanitized: no e-mail, organisation or tokens). Run `npm run <a|b|c|d|d:inline|e|f|h|i|j|j:order|summary>` to repeat a check.

| Item | Value |
|---|---|
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.293` (+ `zod@4.6.5`; npm auto-installed the peers `@anthropic-ai/sdk@0.132.1` and `@modelcontextprotocol/sdk@1.32.1`) |
| Binary used | SDK-bundled `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, `claude_code_version: "2.1.293"` (`pathToClaudeCodeExecutable` unset) |
| User's CLI | `~/.local/bin/claude --version` → `2.1.284 (Claude Code)` (recorded, not used) |
| Node | 24.20.0 |
| Auth | `apiKeySource: "none"`, `accountInfo().subscriptionType: "Claude Max"`, `accountInfo().apiProvider: "firstParty"` |
| Keychain | No prompt and no hang. Every session was authenticated and answering within about 1.5 s, with `HOME` passed and `CLAUDE_CONFIG_DIR` unset. No token refresh happened during the run, so the refresh race is still untested. |

## Results

| Check | Result | One-line finding |
|---|---|---|
| a init | **PASS** | All PLAN §6.1 startup assertions hold, but match models on `resolvedModel` and drop `TodoWrite` from the list |
| b routing | **PASS** | Calls land on `mcp__pc__*`. **PreToolUse sees the alias target** (`mcp__pc__bash`), never `Bash` |
| c AskUserQuestion | **PASS** | Gate "no decision" → canUseTool → `allow` + `{questions, answers}`. Single and `", "` multi-select both reach the model |
| d ExitPlanMode | **FAIL on `input.plan`** (round trip PASS) | `ExitPlanMode` input is `{}`. The plan goes to `~/.claude/plans/<slug>.md` through **Write → aliased to `mcp__pc__write`** |
| e messages | **PASS** | `shouldQuery:false` adds context without an API call but **emits a zero-turn `result`**. `next` folds into the running turn; `later` runs as its own turn |
| f S3 swap | **PASS** | `applyFlagSettings` at turn boundaries: model haiku→opus→haiku and effort xhigh→medium→xhigh, swap in 57–94 ms. The T3 fallback was not needed |
| g rate limits | **PASS** | `rate_limit_event` captured. Utilization is in `unifiedWindows.*.utilization` (fraction), not top-level |
| h concurrency | **PASS** | 3 parallel Haiku sessions all finished in about 1.3–1.5 s |
| i pending canUseTool | **PASS** | An AskUserQuestion card held for 180 s, then answered: the session completed and the cache was still warm |
| j bypass mode (2026-10-09) | **PASS** | USER DECISION 2026-10-08: under `bypassPermissions` hooks still run and their denies block; AskUserQuestion and ExitPlanMode still reach canUseTool; an undecided call is auto-allowed (see "Bypass mode" below) |

---

## a) init: `src/a-init.mjs`
- `system/init` (2.1.293): `apiKeySource: "none"`, `model: "claude-haiku-5-5"`, `permissionMode: "default"`, `mcp_servers: [{name:"mc",status:"connected",source:"sdk"},{name:"pc",…}]`.
- **Init tool list (exact):** `AskUserQuestion, EnterPlanMode, ExitPlanMode, mcp__mc__status, mcp__pc__bash, mcp__pc__edit, mcp__pc__glob, mcp__pc__grep, mcp__pc__read, mcp__pc__write`. It has no Bash, Read, Agent, Task or Skill.
  - **`TodoWrite` was passed in `options.tools` but is missing from init.**
  - AskUserQuestion **is** present even though the env drops `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`, so the full-design's "re-add that one var" fallback isn't needed.
- `accountInfo()`: only `subscriptionType` (`"Claude Max"`) and `apiProvider` (`"firstParty"`) were read. `apiProvider` is an `AccountInfo` field; `system/init` doesn't have it.
- `supportedModels()`: the rows are aliases, so a check has to match on `resolvedModel`:
  - `{value:"haiku", resolvedModel:"claude-haiku-5-5", displayName:"Haiku 5.5", supportsEffort:true, supportedEffortLevels:["low","medium","high","xhigh","max"], supportsAdaptiveThinking:true}`
  - `{value:"opus", resolvedModel:"claude-opus-5-5", supportedEffortLevels:[…same…]}`
  - `{value:"default", resolvedModel:"claude-opus-5-5"}`
  - A check for `value === 'claude-haiku-5-5'` fails.
- `init.effort` is **absent** on this transport (the d.ts says it's only published on Remote Control frames), so effort can't be asserted from init.
- With `settingSources: []`, init still reports:
  - 3 built-in plugins: `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-plugin-authoring`, all with `path: "builtin"`.
  - 19 built-in skills.
  - Agents `claude, Explore, general-purpose, Plan, statusline-setup`.
  - `skills: []` did **not** shrink the skills list (seen in h). None of these can be invoked, because there's no `Skill` or `Agent` tool.
- The allowlist env carried 11 keys: `PATH HOME USER LOGNAME SHELL LANG TMPDIR TERM DISABLE_AUTOUPDATER CLAUDE_CODE_DISABLE_AUTO_MEMORY CLAUDE_AGENT_SDK_CLIENT_APP`. `PATH` was `<node bin>:/usr/bin:/bin:/usr/sbin:/sbin`.
- 32 inherited `ANTHROPIC_*`/`CLAUDE*`/`MCP_*` names were dropped (list in `out/a-init.json`). They include `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_AGENT_SDK_VERSION`.
- The SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: with `allowedTools: ['mcp__mc__*','mcp__pc__*']`, canUseTool is never invoked for mc/pc tools.

## b) tool routing: `src/b-routing.mjs`
- **B1, production shape** (Bash/Read disallowed and aliased). Told to "use the Bash tool", Haiku emitted **`mcp__pc__bash`** directly, with input `{command:"echo hi", description:"Print hi"}`. "Use the Read tool" gave `mcp__pc__read` `{file_path:"/tmp/x.txt", limit:1}`. Both returned the fake output, and nothing ran on the host.
- **B2, alias forced** (Bash/Read visible to the model and aliased). The model emitted `tool_use.name: "Bash"` and `"Read"`; both executed in `mcp__pc__bash` / `mcp__pc__read` (tool_result `FAKE-PC-BASH-OUTPUT\nhi`).
- **PreToolUse received `tool_name: "mcp__pc__bash"`, the alias target, not `Bash`.** It also received `mcp_server: {name:"pc", source:"sdk"}` and the unchanged built-in input (keys `command, description`). canUseTool was never called.
- PreToolUse input keys: `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id, mcp_server`. `permission_mode` was present on **every** call in every check (`"default"`/`"plan"`), and so was `effort.level`.
- `num_turns` resets per user turn (2, 2, 3), so `maxTurns` caps each turn, not the session.

## c) AskUserQuestion: `src/c-ask.mjs`
- The PreToolUse hook saw `AskUserQuestion` (`permission_mode:"default"`) and returned `{}`. canUseTool then got `toolName:"AskUserQuestion"` with input keys `["questions"]`, where each question is `{question, header, options:[{label, description}], multiSelect}`.
- The answer `allow` + `updatedInput:{questions, answers:{"Which option?":"Option A"}}` comes back to the model as this tool_result:
  `Your questions have been answered: "Which option?"="Option A". You can now continue with these answers in mind.` The final reply was `Option A`.
- Multi-select (`multiSelect:true`): `answers:{"Which fruits?":"Apple, Cherry"}` gave the reply `Apple, Cherry`.

## d) ExitPlanMode: `src/d-plan.mjs` (+ `d:inline` variant)
- Started with `permissionMode:'plan'`; init showed `permissionMode:"plan"`. The model stayed on **`claude-haiku-5-5`** during plan mode (no Sonnet upgrade).
- **Flow observed (2.1.293):**
  1. The model calls `Write` for `/Users/<user>/.claude/plans/<slug>.md`. Because of `toolAliases`, that call **lands in `mcp__pc__write`**; the hook sees `mcp__pc__write` with `permission_mode:"plan"`.
  2. The model calls `ExitPlanMode` with **input `{}`**. canUseTool gets `input_keys: []`, so **`input.plan` doesn't exist**.
  3. After `allow` + `updatedInput`, the tool_use_result is `{"plan":null,"isAgent":false,"filePath":"/Users/<user>/.claude/plans/<slug>.md"}`. The tool_result text is "User has approved exiting plan mode. You can now proceed."
- The `d:inline` variant asked for the plan text inside the ExitPlanMode call (`planModeInstructions: "Do not write any plan file … put the complete plan text in its \"plan\" field"`). It changed nothing: the plan file was still written and the input was still `{}`.
- **The round trip itself works:**
  - `setPermissionMode('default')` resolved in 4–7 ms.
  - The next PreToolUse (`mcp__mc__status`) saw `permission_mode:"default"`.
  - The session carried out the plan in the same turn and replied `DONE`.
- The host plan file was never created, because the alias kept the write off the host. That's good for isolation, but it means the CLI can't recover the plan either.

## e) messages: `src/e-messages.mjs`
- `{shouldQuery:false}` with `[context] The crate code is PINEAPPLE-42.` made **no API call**. It did emit a `result` frame `{subtype:"success", num_turns:0, result:""}`.
  - The first run of this script mistook that frame for turn 1's result. It was fixed and re-run.
- The question "call mcp__mc__status once, then tell me the crate code" got the reply `Crate code: PINEAPPLE-42`, so the context message reached the model.
- While that turn's tool call was in flight, two messages were pushed:
  - `priority:'next'` ("include MANGO") was **folded into the running turn**: the first result was `Crate code: PINEAPPLE-42 (MANGO)`, `num_turns:2`.
  - `priority:'later'` ("include KIWI") **ran afterwards as its own turn**: `Crate code: PINEAPPLE-42 (MANGO, KIWI)`, `num_turns:1`. Its assistant frames carried that message's uuid in `user_message_uuids`.
- The CLI doesn't echo user messages back on the stream, so there are no `user` replay frames for plain sends.

## f) S3 swap: `src/f-swap.mjs`
One streaming session. Each turn was "call mcp__mc__status once, then reply done N".

| Turn | `message.model` | PreToolUse `effort.level` | init re-emitted | thinkingTokens | result |
|---|---|---|---|---|---|
| 1 | `claude-haiku-5-5` | `xhigh` | `model: claude-haiku-5-5` | 0 | `done 1` |
| swap | `applyFlagSettings({model:'claude-opus-5-5', effortLevel:'medium'})` → 93.6 ms | | | | |
| 2 | `claude-opus-5-5` | `medium` | `model: claude-opus-5-5` | 0 | `done 2` |
| swap | `applyFlagSettings({model:'claude-haiku-5-5', effortLevel:'xhigh'})` → 57.4 ms | | | | |
| 3 | `claude-haiku-5-5` | `xhigh` | `model: claude-haiku-5-5` | 0 | `done 3` |

- `PreModelSwitch` and `PostModelSwitch` hooks fire **during the `applyFlagSettings` call**, not at the next turn. Their fields are `from_model, to_model, requested_model, source:"sdk", context_tokens, prompt_cache_warm:true, cache_ttl:"1h", estimated_cache_write_usd, pricing:"catalog"`.
- **Swap cost:** the haiku→opus turn rewrote the Opus cache (`cacheCreationInputTokens` 9,335, about $0.077 at list price; the hook estimated $0.0714). The opus→haiku turn read from Haiku's still-warm cache (18.5k read, 853 written).
- **Prompt-cache TTL on the subscription is 1 h.** Every `cache_creation` in every check was `{ephemeral_5m_input_tokens:0, ephemeral_1h_input_tokens:>0}`, and the switch hooks report `cache_ttl:"1h"`.
- **Effort evidence:**
  - The only per-turn signal is PreToolUse `input.effort.level`, which is the CLI's applied effort after downgrades.
  - Thinking blocks arrive signed with **empty text**; `system/thinking_tokens` carries `estimated_tokens`. Neither says anything about effort on trivial prompts.
  - `init.effort` is absent on this transport.
- `usage_EXPERIMENTAL…({skipBehaviors:true})` returned `subscription_type:"max"`, `rate_limits_available:true`, and `rate_limits.five_hour.utilization: 28`, which is a **percent**, plus `seven_day`, `limits[]` and other fields.
- `persistSession:true` was used here only, for the fallback. It left one transcript under `~/.claude/projects/-Users-…-spikes-s2-s3-sdk-out-cwd-f-swap-*`.

## g) rate_limit_event (all checks)
- Fields seen:
  `{status:"allowed", resetsAt, rateLimitType:"five_hour", overageStatus:"rejected", overageDisabledReason:"org_level_disabled", isUsingOverage:false, unifiedWindows:{five_hour:{utilization:0.26–0.28, resetsAt}, seven_day:{utilization:0.10–0.11, resetsAt}}}`
- **The top-level `utilization` field is absent while `allowed`.** `unifiedWindows` is missing from the d.ts but present on the wire.
- No `allowed_warning` or `rejected` was observed.
- Details are in `out/summary.json` → `g`.

## h) concurrency: `src/h-concurrent.mjs`
- Three sessions in parallel replied `ok-1`, `ok-2` and `ok-3`, finishing at 1.4 s, 1.5 s and 1.3 s, each with a distinct `session_id`.

## i) canUseTool pending: `src/i-pending.mjs`
- canUseTool for `AskUserQuestion` was parked at t=2.6 s and answered at t=182.6 s with `allow` and `answers:{"Pick one?":"Blue"}`.
- The `signal` never aborted. The only frame on the stream while it was parked was one `rate_limit_event`; there were no keepalives or timeouts.
- The result was `success`, the reply was `Blue`, and `duration_ms` was 182,681.
- The continuation call read 8,800 cache tokens and wrote 225 (1 h TTL), so the cache was still warm after 3 minutes.
- Only 3 minutes were tested. PLAN §12.1's "pending for over 1 h" is still open.

## Usage
- The final runs (`out/summary.json`) used 17 model turns and 33 API calls: a 1, b 3, c 2, d 1, d:inline 1, e 2 (plus one zero-turn context append), f 3, h 3, i 1.
- The two superseded runs (first `a` and first `e`) add 3 model turns and 4 API calls.
- **Total: 20 model turns and 37 API calls.** That's about $0.09 at list price, most of it the single Opus turn.
- The 5-hour subscription window went from 0.26 to 0.28 utilization. Nothing looped, and every session had a `maxTurns` and `maxBudgetUsd` cap.

---

## Recommended changes to PLAN §6 (PLAN.md not edited)

1. **§6.1 `tools`:** remove `TodoWrite`, because 2.1.293 silently drops it. Add `init.tools` contains no `Skill`/`Agent`/`Task` to the startup assertions.
2. **§6.1 `allowedTools`:** drop `mcp__mc__*` and `mcp__pc__*`. They make the SDK skip canUseTool (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), so a ToolGate bug that returns no decision would **auto-allow**. Without them, a missing decision falls through to the broker, which denies, so the gate fails closed as §6.2 intends. Keep only `WebSearch`/`WebFetch` there, if any.
3. **§6.1 startup assertions:**
   - Match models on `resolvedModel` (`haiku` → `claude-haiku-5-5`, `opus`/`default` → `claude-opus-5-5`).
   - Read `apiProvider` from `accountInfo()` and assert `'firstParty'`.
   - Don't expect `init.effort`.
   - Keep `apiKeySource === 'none'`.
4. **§6.1 effort:** `settings.effortLevel` and `applyFlagSettings` work as planned. Note that the SDK now also has a top-level `effort` option (`--effort`); use it in the T3 fallback. To check the applied effort, read PreToolUse `input.effort.level`; neither thinking blocks nor init carry it.
5. **§6.1 env:** the allowlist is confirmed. Build the `agentEnv` unit-test fixture from the 32 real names in `out/a-init.json`. Several don't match `CLAUDE_CODE_*`: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PREVIEW_CLASSIFIER_FLOOR`. Drop the full-design's "re-add `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`" fallback.
6. **§6.2 ToolGate naming:** the hook receives the **alias target** (`mcp__pc__*`) plus `mcp_server.source === 'sdk'`. Key the gate on the `mcp__pc__*` names and `mcp_server.source`. Built-in names only matter as a fail-closed deny if one ever reaches the gate. The `pc__*` schemas must stay supersets of the built-in inputs, since aliased calls arrive with the built-in input (e.g. Bash `description`).
7. **§6.2 / §6.4 plan mode (the biggest change).** 2.1.293 doesn't pass `input.plan`. The model writes the plan file with `Write`, which the alias routes to `mcp__pc__write`. Two changes follow:
   - **PlanCapture in the pc tool layer:** while the mode is `plan`, any `pc__write`/`pc__edit`/`pc__read` whose `file_path` is under `$HOME/.claude/plans/` is handled in Node memory. It is never sent to spacesd and never written on the host. The latest content becomes the plan card's text when `ExitPlanMode` reaches the broker. (`ExitPlanMode`'s tool_use_result `filePath` names the same path and can be used to cross-check.)
   - **ToolGate exemption:** the §6.2 "Plan mode: denied `pc__write`, `pc__edit`" rule must exempt that plans path; otherwise an agent can never produce a plan.
   - Keep `mc__propose_plan` as the fallback. `planModeInstructions` can't be used to get the plan inline.
   - Plan mode on Haiku 5.5 stays on Haiku.
8. **§6.1 stream handling / §6.5:** a `shouldQuery:false` send produces a `result` with `num_turns: 0` and no API call. It must **not** free a brain slot, record a turn, count against the per-turn caps or apply a pending seat transition. Ignore results with `num_turns === 0`, or track which sends were context-only.
9. **§6.5 priorities:** behaviour is confirmed as documented. `next` folds into the running turn at the next tool boundary, which fits P0 player messages. `later` runs as a separate turn after the current one, which fits P1/P3 queued wakes. `now` wasn't tested.
10. **§6.5 UsageGovernor:** read `rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization`, a 0–1 fraction. Top-level `utilization` is absent while `allowed`. The `usage_EXPERIMENTAL` poll reports **percent** (28, not 0.28), so normalize the two.
11. **§6.3 swap:**
    - `applyFlagSettings` works at turn boundaries, so the primary path is confirmed and close+resume isn't needed.
    - Wire a `PostModelSwitch` hook as the swap acknowledgement; it drives the `[O]` badge and logs `estimated_cache_write_usd`.
    - Budget about 9k Opus cache-write tokens per sit (about $0.07–0.08 list).
    - The 60 s re-sit debounce is worth keeping because Haiku's cache survives the round trip.
12. **§6.4 card waits:** the subscription prompt cache TTL is **1 h**, not 5 min, so long card waits barely affect cost (see i for the 3-minute case).

## Deviations from the brief / PLAN
- `apiProvider` was read from `accountInfo()`, because `system/init` doesn't have that field. Only `subscriptionType` was printed.
- Spike options kept the PLAN §6.1 shape with these exceptions:
  - `includePartialMessages:false`, to keep logs small.
  - `persistSession:false` everywhere except f.
  - `maxBudgetUsd` and `maxTurns` safety caps.
  - WebSearch/WebFetch omitted, as the brief asked.
- Extra live runs beyond the brief:
  - `a` ran twice (the first run's log sanitizer redacted `apiKeySource`).
  - `e` ran twice (harness bug with the zero-turn result).
  - The `d:inline` variant was added to test `planModeInstructions`.
- `h` also passed `skills: []` on session 1, as a side observation.

## Open issues (not covered by this spike)
- **Token refresh:** a refresh under 4 concurrent sessions plus the user's CLI (PLAN §12.1 S2) never happened during the run. That needs a longer soak or an expired token.
- **Long card waits:** canUseTool was held for 3 minutes; PLAN asks for over 1 h. The 1 h cache TTL suggests waits past 60 minutes will pay a cache rewrite.
- **Not exercised:**
  - `priority:'now'` (interrupt)
  - `EnterPlanMode` brokering
  - WebSearch/WebFetch gating
  - Compaction before an Opus→Haiku downswap
  - A PostToolUse `continue:false` turn end
- **User's binary:** the spike ran the SDK-bundled 2.1.293. Production per PLAN uses the user's `claude` at ≥ 2.1.293; the installed copy is 2.1.284 and needs `claude update`. The bundled binary authenticated against the same keychain login without a prompt. Whether dev builds should default to it is a packaging and licensing decision for PLAN §2/§9 (release artifacts must not ship it).
- **Leftovers outside the repo:**
  - Check f wrote one session transcript under `~/.claude/projects/-Users-jasperaelvoet-Documents-MineVibe-spikes-s2-s3-sdk-out-cwd-f-swap-*`.
  - The plan-mode runs created no file under `~/.claude/plans/`; the writes were aliased into the fake pc tool.

---

## Bypass mode (USER DECISION 2026-10-08): `src/j-bypass.mjs`

**PASS. In-game agents run in `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true`; ToolGate (PreToolUse) stays the authoritative, fail-closed sandbox guard, and the card flow keeps using canUseTool. No PreToolUse-hook fallback for cards was needed.**

Run on 2026-10-09 (local), SDK `0.3.293`, SDK-bundled `claude` `2.1.293`, Haiku 5.5 at `low` effort, production option shape (no `allowedTools`; `tools: ['AskUserQuestion', 'ExitPlanMode']`, i.e. no EnterPlanMode). Three user turns in total (two sessions for `npm run j`, one for `npm run j:order`), 12 API calls, about $0.005 list. Nothing secret was printed or persisted (the Recorder sanitizer as before).

| Check | Result | Evidence |
|---|---|---|
| init under bypass | PASS | `system/init.permissionMode: "bypassPermissions"`; tools as configured plus the mc/pc servers, no host built-ins |
| (a) PreToolUse still runs | PASS | The hook fired for `mcp__mc__status`, `mcp__pc__bash`, `mcp__pc__read` and `AskUserQuestion`, each with `permission_mode: "bypassPermissions"` |
| (a) a hook deny still blocks | PASS | `mcp__pc__bash` denied by the hook: the handler never ran, the model got `is_error` with "PreToolUse:mcp__pc__bash hook error: SPIKE-GATE-DENY: …", and the result listed it in `permission_denials` |
| (b) AskUserQuestion reaches canUseTool | PASS | canUseTool got `AskUserQuestion`; `allow` + `updatedInput {questions, answers: {"Which colour?": "Blue"}}`; the model replied "Blue" |
| (c) ExitPlanMode in a plan-first session | PASS | Session started in bypass, then `setPermissionMode('plan')` (the sit boundary): the plan Write arrived as `mcp__pc__write` with `permission_mode: "plan"`, `ExitPlanMode` (input `{}`) reached canUseTool, tool result "User has approved exiting plan mode. You can now proceed." |
| back to bypass after approval | PASS | `setPermissionMode('bypassPermissions')` took 1-4 ms; the next call (`mcp__mc__status`) reported `permission_mode: "bypassPermissions"` and the model finished ("DONE"). Works in both orders: after the allow is handed back (S2 order, `npm run j`) and awaited before the allow is returned (the production InteractionBroker order, `npm run j:order`) |

**Finding that shapes ToolGate.** Under bypass a call the hook leaves **undecided** is auto-allowed without canUseTool: the hook returned no decision for `mcp__pc__read` and its handler ran (canUseTool never saw it). Only the interaction tools (AskUserQuestion, ExitPlanMode) still go to canUseTool. So ToolGate must return an explicit allow or deny for every mc/pc/web call and "no decision" only for those two (it does; `apps/server/test/unit/agents/ToolGate.test.ts` pins it). The old fallback "anything undecided reaches the broker, which denies" no longer exists.

**Startup warning.** With bypass plus a canUseTool callback the SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` ("canUseTool will not be invoked … use a PreToolUse hook instead") once per session. It is true for ordinary tools (see above) and not for the two interaction tools, as (b) and (c) show.

Product changes that came with the decision (apps/server): `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions` in `sessionOptions.ts` (`AGENT_PERMISSION_MODE`), Node's tracked mode starts at and returns to `bypassPermissions` (`AgentBrain`), the approved plan switches to `bypassPermissions` (`InteractionBroker`), and the fake SDK used by the unit tests mirrors the auto-allow rule above.

