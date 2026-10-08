// Check (a): init assertions (PLAN §6.1 "Startup assertions"). One tiny Haiku turn.
import { execFileSync } from 'node:child_process';
import { HAIKU, OPUS, Recorder, agentEnv, baseOptions, droppedEnvNames, openSession, versionAtLeast, watchdog } from './lib.mjs';

const rec = new Recorder('a-init');
let session;
const stop = watchdog(rec, 150_000, () => session?.q.close());

const userClaude = `${process.env.HOME}/.local/bin/claude`;
let userClaudeVersion;
try {
  userClaudeVersion = execFileSync(userClaude, ['--version'], { env: agentEnv(), encoding: 'utf8', timeout: 20_000 }).trim();
} catch (e) {
  userClaudeVersion = `error: ${e.message}`;
}

const env = agentEnv();
rec.data.env = { keys: Object.keys(env).sort(), PATH: env.PATH, droppedNames: droppedEnvNames() };
rec.data.userClaudeVersion = userClaudeVersion;

session = openSession(rec, baseOptions(rec, { maxTurns: 1 }));
rec.turn = 1;
session.send('Reply with exactly: OK');

let status = 'FAIL';
const checks = {};
try {
  const result = await session.nextResult(120_000);
  const init = rec.inits[0];

  const account = await session.q.accountInfo();
  // Only these two fields are kept; e-mail / organisation / tokenSource are never read out.
  rec.data.account = { subscriptionType: account.subscriptionType ?? null, apiProvider: account.apiProvider ?? null };
  console.log(`subscriptionType: ${account.subscriptionType}`);

  const models = await session.q.supportedModels();
  rec.data.allModelValues = models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel }));
  const pick = (id) =>
    models
      .filter((m) => m.value === id || m.resolvedModel === id)
      .map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel,
        displayName: m.displayName,
        supportsEffort: m.supportsEffort,
        supportedEffortLevels: m.supportedEffortLevels,
        supportsAdaptiveThinking: m.supportsAdaptiveThinking,
        supportsFastMode: m.supportsFastMode,
        supportsAutoMode: m.supportsAutoMode,
      }));
  rec.data.haiku = pick(HAIKU);
  rec.data.opus = pick(OPUS);
  rec.data.mcpServerStatus = (await session.q.mcpServerStatus()).map((s) => ({ name: s.name, status: s.status, source: s.source, tools: s.tools?.map((t) => t.name ?? t) }));

  const tools = init?.tools ?? [];
  checks.resultSuccess = result.subtype === 'success';
  checks.apiKeySourceNone = init?.apiKeySource === 'none';
  checks.subscriptionTypeSet = Boolean(account.subscriptionType);
  checks.haikuXhigh = rec.data.haiku.some((m) => m.supportedEffortLevels?.includes('xhigh'));
  checks.opusPresent = rec.data.opus.length > 0;
  checks.opusMedium = rec.data.opus.some((m) => m.supportedEffortLevels?.includes('medium'));
  checks.noHostTools = !tools.some((t) => ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Task', 'NotebookEdit'].includes(t));
  checks.brokerToolsPresent = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].every((t) => tools.includes(t));
  // Informational: TodoWrite was requested via options.tools; record whether it survived.
  rec.data.todoWriteInInit = tools.includes('TodoWrite');
  checks.pcToolsPresent = ['bash', 'read', 'edit', 'write', 'glob', 'grep'].every((t) => tools.includes(`mcp__pc__${t}`));
  checks.cliVersionOk = versionAtLeast(init?.claude_code_version ?? '0', '2.1.293');
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

await session.close();
stop();
rec.finish(status, { checks });
