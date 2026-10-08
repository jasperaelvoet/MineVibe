/**
 * The PC and org module factories the runtime composes by default (orchestrator/runtime.ts).
 *
 * Integration point: the PC module (I1b, `apps/server/src/pcs/module.ts`) and the org module (I1c,
 * `apps/server/src/org/module.ts`) are written against modules.ts. When they merge, switch the two imports below to
 *
 *   import { createPcModule } from '../pcs/module.js';
 *   import { createOrgModule } from '../org/module.js';
 *
 * and nothing else changes. Until then the stand-ins run: no PCs, and in-memory org services.
 */

import type { CreateOrgModule, CreatePcModule } from './modules.js';
import {
  createMemoryOrgModule as createOrgModule,
  createNullPcModule as createPcModule,
} from './placeholderModules.js';

export const defaultPcModule: CreatePcModule = createPcModule;
export const defaultOrgModule: CreateOrgModule = createOrgModule;
