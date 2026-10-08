// apps/server/src/orchestrator/modules.ts — shared composition contract (identical in I1a/I1b/I1c; adapt import paths/type names to the codebase but keep these exported shapes)
import type { Logger } from 'pino';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { MineVibePaths } from '../config/paths.js';
import type { CrewApi } from '../contracts/CrewApi.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';
export interface RuntimeContext {
  bridge: BridgeServer;
  paths: MineVibePaths;
  log: Logger;
  world(): { worldId: string; gen: number } | null;
  mode: 'dev' | 'play' | 'app';
}
export interface WorldEvents {
  onWorldOpen(worldId: string, fresh: boolean): void | Promise<void>;
  onWorldEnded(worldId: string): void | Promise<void>;
  onClock(clockTime: number): void;
}
export interface CrewHooks {
  goAway(agentId: string, pendingId: string): Promise<void>;
  comeBack(agentId: string): Promise<void>;
  pullIntoMeeting(agentId: string, meetingId: string): Promise<void>;
  releaseFromMeeting(agentId: string): Promise<void>;
  deliver(agentId: string, text: string, kind: 'scheduled' | 'meeting' | 'context'): Promise<void>;
  meetingTurn(agentId: string, prompt: string, opts: { maxSentences: number }): Promise<string>;
}
export interface PcModule extends Partial<WorldEvents> {
  readonly pcApi: PcApi;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface OrgModule extends WorldEvents {
  readonly orgApi: OrgApi;
  bindCrew(crew: CrewApi, hooks: CrewHooks): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type CreatePcModule = (
  ctx: RuntimeContext,
  opts: { runtime: 'container' | 'docker'; bundleInstallRoot?: string },
) => PcModule;
export type CreateOrgModule = (ctx: RuntimeContext) => OrgModule;
