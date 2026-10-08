/**
 * What the `mc` tools (v1 and v2) need from the agent runtime, and helpers both versions share.
 */

import type { AgentBody, AgentRole, Place, SkillConsent, SkillName } from '@minevibe/protocol';
import type { Actor } from '../../contracts/common.js';
import { ApiError, isApiError } from '../../contracts/common.js';
import type { OrgApi } from '../../contracts/OrgApi.js';
import type { SkillApi } from '../../contracts/SkillApi.js';
import type { Refusal } from '../world/guard.js';
import type { PerceptionContext } from '../world/perception.js';
import type { TreeSighting } from '../world/scene.js';
import type { CrewNames } from './format.js';
import type { JobRegistry } from './jobs.js';
import type { CrewRef } from './targets.js';

/** What the `mc` tools need from the agent runtime, per agent. */
export interface McHost {
  readonly agentId: string;
  readonly skills: SkillApi;
  readonly org: OrgApi;
  actor(): Actor;
  playerName(): string;
  /** The ~25-token status footer, or null when no body snapshot is known yet. */
  footer(): string | null;
  /** The agent's current position (for `here` and `when:"now"`). */
  here(): Place | null;
  /** The overworld clock in ticks, or null when unknown. */
  clockTime(): number | null;
  /** A job returned `running`: wake the agent with [JOB DONE] when it ends. */
  trackJob(jobId: string, label: string): void;
  say(text: string): void;
  tell(to: string, text: string): Promise<string>;
  remember(note: string): Promise<string>;
  requestHire(request: {
    role: AgentRole;
    name?: string | undefined;
    reason: string;
    firstTask: string;
  }): Promise<string>;
  sitAtPc(request: { pcId: string; purpose: string; waitMs: number }): Promise<string>;
  standUp(): Promise<string>;
  /** Waits up to `ms`; resolves early when job `jobId` ends. */
  wait(ms: number, jobId?: string): Promise<string>;
  /** A task report was filed (wakes the CEO for failed/blocked). */
  taskReported(report: {
    eventId: string;
    status: 'done' | 'failed' | 'blocked';
    note?: string | undefined;
  }): void;
  /**
   * What the perception texts need: the agent's position, the Base and its zone (protocol §7.4.3). Absent: the raw
   * look_around / find results are formatted without them.
   */
  world?(): PerceptionContext;
  /** look_around / find showed natural trees (for the scene line). */
  noteTrees?(sighting: TreeSighting): void;
  /**
   * The player's consent to change protected blocks for this agent, if one is valid (protocol §7.4.3). Only Node mints
   * it; it is attached to world jobs and never read from tool arguments.
   */
  consent?(): SkillConsent | null;
  /** Node refused a job itself (`PROTECTED`, the Base): the refusal the player may still allow. */
  noteRefusal?(refusal: Refusal): void;

  // --- v2 (docs/design/tools-v2-mc.md) ---------------------------------------------------------------------------

  /** The agent's job registry (§7): the running job, the last ones, their metadata for results and wakes. */
  readonly jobs?: JobRegistry | undefined;
  /** A crew member by `@handle`, name or agent id (targets, §4.2). */
  crewMember?(ref: string): CrewRef | null;
  /** Handle, name and role of a crew member by agent id (the crew section). */
  crewNames?(agentId: string): CrewNames | null;
  /** The agent's latest `agent.state` body. */
  body?(): AgentBody | null;
}

/** Skills whose jobs may break or replace blocks: they carry the agent's consent, when there is one. */
export const BLOCK_CHANGING_SKILLS: ReadonlySet<SkillName> = new Set([
  'mine',
  'collect',
  'dig',
  'place',
  'build',
  'farm',
  'use_item',
]);

/**
 * v2 also sends consent with `craft` (its recipe tree may place a station and gather) and `sequence` (whose steps
 * change blocks): the consent stays scoped to the refused positions or zone, so it never widens.
 */
export const CONSENT_SKILLS_V2: ReadonlySet<SkillName> = new Set([...BLOCK_CHANGING_SKILLS, 'craft', 'sequence']);

/**
 * Splits the mod's status `footer` off a skill or observation result (protocol §7.3): the rest is the result the
 * agent reads, the footer becomes the tool result's last line.
 */
export function splitFooter(result: Record<string, unknown> | undefined): {
  result: Record<string, unknown> | undefined;
  footer: string | null;
} {
  if (!result || typeof result.footer !== 'string') return { result, footer: null };
  const { footer, ...rest } = result;
  return { result: rest, footer: footer.trim().length > 0 ? footer.trim() : null };
}

const COORD_RE = /(-?\d{1,8})\s*[, ]\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,8})/;

/** A Codex `places` page (id or title) → its coordinates (the first `x, y, z` triple in the body). */
export async function resolveCodexPlace(
  host: Pick<McHost, 'actor' | 'org'>,
  place: string,
): Promise<{ x: number; y: number; z: number }> {
  const actor = host.actor();
  let page: Awaited<ReturnType<OrgApi['codex']['read']>> | null = null;
  try {
    page = await host.org.codex.read(actor, place);
  } catch (err) {
    if (!isApiError(err, 'CODEX_NOT_FOUND')) throw err;
  }
  if (!page) {
    const hits = await host.org.codex.search(actor, { query: place, category: 'places', limit: 1 });
    const hit = hits[0];
    if (!hit) throw new ApiError('UNKNOWN_PLACE', `no Codex place called "${place}"`);
    page = await host.org.codex.read(actor, hit.id);
  }
  const m = COORD_RE.exec(page.body);
  if (!m) throw new ApiError('UNKNOWN_PLACE', `the page "${page.title}" has no coordinates`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}
