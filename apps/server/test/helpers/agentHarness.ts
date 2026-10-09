/**
 * A brain-runtime harness for unit tests: an AgentManager over the contract fakes (FakeSkillApi, FakeOrgApi, a
 * FakePcApi with a Vault mount) and the fake SDK query, in a temp data dir. No processes, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { AgentManager, type AgentManagerOptions } from '../../src/agents/AgentManager.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { FakePcApi } from '../../src/contracts/FakePcApi.js';
import { FakeSkillApi } from '../../src/contracts/FakeSkillApi.js';
import { type FakeQuery, fakeQueryFactory, settle, userText } from './fakeSdk.js';

/** FakePcApi with a Vault folder mounted (the contract fake has none). */
export class MountedPcApi extends FakePcApi {
  override async info(pcId: string) {
    return {
      ...(await super.info(pcId)),
      mounts: [{ hostPath: '/Users/jasper/Code/foo', mode: 'rw' as const }],
    };
  }
}

export const HOME = '/Users/jasper';

export interface Harness {
  readonly dir: string;
  readonly manager: AgentManager;
  readonly skills: FakeSkillApi;
  readonly org: FakeOrgApi;
  readonly pcs: MountedPcApi;
  readonly factory: ReturnType<typeof fakeQueryFactory>;
  readonly events: { type: string; payload: unknown }[];
  /** The query of the n-th started session (0 = first). */
  query(n?: number): FakeQuery;
  /** The query of an agent's current session. */
  queryOf(agentId: string): FakeQuery;
  /** Texts of the user messages a query received. */
  texts(q: FakeQuery): string[];
  /** Waits until `pred` holds (polling the event loop). */
  until(pred: () => boolean, what?: string, timeoutMs?: number): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createHarness(
  options: Partial<AgentManagerOptions> & {
    dir?: string;
    pcs?: MountedPcApi;
    skills?: FakeSkillApi;
    org?: FakeOrgApi;
  } = {},
): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'mv-agents-'));
  const factory = fakeQueryFactory();
  const skills = options.skills ?? new FakeSkillApi();
  const org = options.org ?? new FakeOrgApi();
  const pcs =
    options.pcs ??
    new MountedPcApi([{ pcId: 'linux-1', files: { '/Users/jasper/Code/foo/CLAUDE.md': 'Use pnpm.\n' } }]);
  const manager = new AgentManager({
    skills,
    org,
    pcs,
    claude: { source: 'bundled', path: undefined, version: null },
    agentEnv: () => ({ HOME, PATH: '/usr/bin:/bin' }),
    worldsDir: join(dir, 'worlds'),
    stateDir: join(dir, 'state'),
    playerName: () => 'Jordan',
    log: pino({ level: 'silent' }),
    queryFactory: factory,
    chatDebounceMs: 0,
    autonomyTickMs: 0,
    lastWordsMs: 300,
    ...options,
  });
  const events: { type: string; payload: unknown }[] = [];
  for (const type of [
    'say',
    'brain',
    'pending',
    'chat',
    'crew',
    'brains',
    'toast',
    'card',
    'meetingMessage',
  ] as const) {
    manager.on(type, (payload: unknown) => {
      events.push({ type, payload });
    });
  }
  const queryOf = (agentId: string): FakeQuery => {
    const brain = manager.brain(agentId);
    const opts = brain?.session?.options;
    const q = [...factory.queries].reverse().find((x) => opts && x.options.cwd === opts.cwd);
    if (!q) throw new Error(`no query for ${agentId}`);
    return q;
  };
  return {
    dir,
    manager,
    skills,
    org,
    pcs,
    factory,
    events,
    query: (n = 0) => {
      const q = factory.queries[n];
      if (!q) throw new Error(`no query ${n}`);
      return q;
    },
    queryOf,
    texts: (q) => q.sent.map(userText),
    async until(pred, what = 'condition', timeoutMs = 2000) {
      // performance.now and setImmediate keep working under fake timers (only setTimeout/Date are faked).
      const start = performance.now();
      while (!pred()) {
        if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await settle(2);
      }
    },
    async cleanup() {
      await manager.shutdown().catch(() => {});
      manager.dispose();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
