import { release } from 'node:os';
import { BRIDGE_PATH, PROTOCOL_VERSION, SUBPROTOCOL } from '@minevibe/protocol';
import { agentEnv } from './agents/agentEnv.js';
import {
  compareVersions,
  findClaudeBinary,
  MIN_CLAUDE_VERSION,
  readClaudeVersion,
} from './agents/claudeBinary.js';
import { readBridgeFile } from './bridge/bridgeFile.js';
import { devHome, findRepoRoot, HOME_ENV, playHome, resolvePaths } from './config/paths.js';
import { SERVER_VERSION } from './version.js';

export interface DoctorOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Skip running `claude --version` (tests). */
  readonly skipClaude?: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `minevibe-server doctor`: versions and paths, read-only. Never prints tokens. */
export async function doctorReport(options: DoctorOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(14)} ${value}`);

  lines.push(`MineVibe server ${SERVER_VERSION}`);
  row('protocol', `v${PROTOCOL_VERSION} (subprotocol ${SUBPROTOCOL}, path ${BRIDGE_PATH})`);
  row('node', `${process.version} (${process.platform} ${process.arch})`);
  row('os release', release());

  if (options.skipClaude) {
    row('claude', '(skipped)');
  } else {
    const bin = findClaudeBinary({ path: env.PATH });
    if (!bin) {
      row('claude', `not found (install Claude Code >= ${MIN_CLAUDE_VERSION})`);
    } else {
      const version = await readClaudeVersion(bin, agentEnv({ version: SERVER_VERSION, source: env }));
      const verdict =
        version === null
          ? 'version unknown'
          : compareVersions(version, MIN_CLAUDE_VERSION) >= 0
            ? 'ok'
            : `too old; run \`claude update\`, needs >= ${MIN_CLAUDE_VERSION}`;
      row('claude', `${bin} ${version ?? '?'} (${verdict})`);
    }
  }

  const paths = resolvePaths({ env, cwd });
  lines.push('');
  lines.push(paths.overridden ? `paths (${HOME_ENV}=${env[HOME_ENV]})` : 'paths (platform defaults)');
  row('  app support', paths.appSupport);
  row('  caches', paths.caches);
  row('  logs', paths.logs);
  row('  state', paths.state);
  row('  bridge file', paths.bridgeFile);
  const repo = findRepoRoot(cwd);
  if (repo) {
    row('  dev home', `${devHome(repo)} (npm run dev)`);
    row('  play home', `${playHome(repo)} (npm run play)`);
  }

  try {
    const bridge = await readBridgeFile(paths.bridgeFile);
    const alive = processAlive(bridge.pid);
    row('bridge', `port ${bridge.port}, pid ${bridge.pid} (${alive ? 'running' : 'stale'})`);
  } catch {
    row('bridge', 'no bridge file (server not running)');
  }
  return lines;
}
