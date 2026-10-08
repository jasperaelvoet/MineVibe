/**
 * Stand-in PC and org modules behind the {@link CreatePcModule} / {@link CreateOrgModule} factory types, used until
 * the real ones (pcs/module.ts, org/module.ts) are wired in through factories.ts, and by tests and `MINEVIBE_PCS=off`.
 *
 * - {@link createNullPcModule}: no PCs. Every guest call rejects with `PC_UNKNOWN`, so `mcp__mc__sit_at_pc` tells the
 *   agent there is no such PC; no bridge handler is registered (the mod gets `NOT_HANDLED` for `pc.*` requests).
 * - {@link createMemoryOrgModule}: the in-memory {@link FakeOrgApi} (Codex pages and calendar events live until the
 *   process exits, nothing fires on a clock) with no bridge handlers; it remembers the crew it was bound to.
 */

import type { CrewApi } from '../contracts/CrewApi.js';
import { ApiError } from '../contracts/common.js';
import { FakeOrgApi } from '../contracts/FakeOrgApi.js';
import { PC_ERROR_CODES, type PcApi } from '../contracts/PcApi.js';
import type { CreateOrgModule, CreatePcModule, CrewHooks, OrgModule, PcModule } from './modules.js';

function noPc(pcId: string): Promise<never> {
  return Promise.reject(
    new ApiError(PC_ERROR_CODES.PC_UNKNOWN, `There is no PC called ${pcId} (PCs are switched off).`),
  );
}

/** A {@link PcApi} without any PC. */
export function noPcApi(): PcApi {
  return {
    info: (pcId) => noPc(pcId),
    screenshot: (pcId) => noPc(pcId),
    pointer: (pcId) => noPc(pcId),
    keyboard: (pcId) => noPc(pcId),
    type: (pcId) => noPc(pcId),
    clipboardGet: (pcId) => noPc(pcId),
    clipboardSet: (pcId) => noPc(pcId),
    exec: (pcId) => noPc(pcId),
    jobOutput: (pcId) => noPc(pcId),
    kill: (pcId) => noPc(pcId),
    readFile: (pcId) => noPc(pcId),
    writeFile: (pcId) => noPc(pcId),
    editFile: (pcId) => noPc(pcId),
    glob: (pcId) => noPc(pcId),
    grep: (pcId) => noPc(pcId),
  };
}

/** No PCs at all. */
export const createNullPcModule: CreatePcModule = (ctx) => {
  const pcApi = noPcApi();
  return {
    pcApi,
    async start() {
      ctx.log.info('PCs are switched off (no PC module)');
    },
    async stop() {},
  } satisfies PcModule;
};

/** An org module over the in-memory {@link FakeOrgApi}. */
export interface MemoryOrgModule extends OrgModule {
  readonly orgApi: FakeOrgApi;
  /** What {@link OrgModule.bindCrew} received. */
  readonly bound: { readonly crew: CrewApi; readonly hooks: CrewHooks } | null;
}

export const createMemoryOrgModule: CreateOrgModule = (ctx) => {
  const orgApi = new FakeOrgApi();
  let bound: MemoryOrgModule['bound'] = null;
  const module: MemoryOrgModule = {
    orgApi,
    get bound() {
      return bound;
    },
    bindCrew(crew, hooks) {
      if (bound) throw new Error('bindCrew called twice');
      bound = { crew, hooks };
    },
    async start() {
      ctx.log.info('org services run in memory (no org module)');
    },
    async stop() {},
    onWorldOpen() {},
    onWorldEnded() {},
    onClock() {},
  };
  return module;
};
