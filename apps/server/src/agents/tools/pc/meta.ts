/** `info` and `handoff_note`: about the PC, and notes for whoever works at it next. */

import { z } from 'zod';
import { ApiError } from '../../../contracts/common.js';
import { textResult } from '../results.js';
import { type Def, defs, tool } from './common.js';
import type { PcToolContext } from './context.js';
import { formatDuration } from './formats.js';
import { imageTokens } from './geometry.js';

export function metaTools(ctx: PcToolContext): Def[] {
  return defs(
    tool(
      'info',
      'About this PC: OS, screen and screenshot size, user, Vault folders (same path as on the host), your working directory and your background commands.',
      {},
      (_args, extra) =>
        ctx.run('info', extra, async (seat) => {
          const i = await ctx.freshInfo(seat.pcId);
          const g = await ctx.geometry(seat.pcId);
          const mounts = i.mounts.map((m) => `${m.hostPath} (${m.mode})`).join(', ') || 'none';
          const screen =
            g.scale === 1
              ? `screen ${g.screenW}x${g.screenH} (screenshots are the same size, ${imageTokens(g.imgW, g.imgH)} image tokens)`
              : `screen ${g.screenW}x${g.screenH}, screenshots ${g.imgW}x${g.imgH} (coordinates are screenshot pixels)`;
          const jobs = ctx.jobs.on(seat.pcId);
          const now = Date.now();
          const jobLines = jobs.map(
            (j) =>
              `- ${j.jobId}: ${j.description} (started ${formatDuration(now - j.startedAt)} ago; output ${j.outputPath ?? 'none'})`,
          );
          const lines = [
            `${i.pcId}: ${i.type} (${i.osVersion ?? i.os}), ${i.status}, ${screen}`,
            `user ${i.user}, home ${i.home}`,
            `Vault: ${mounts}`,
            `Codex: ${i.codexPath ?? 'not mounted'}`,
            `cwd: ${await ctx.cwdOf(seat.pcId)}`,
            jobs.length > 0 ? `Background commands:\n${jobLines.join('\n')}` : 'Background commands: none',
          ];
          return textResult(lines.join('\n'));
        }),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'handoff_note',
      'Leave a note for whoever works at this PC (or on a Vault folder) next: what you did, what is left. It is shown in their kickoff.',
      { text: z.string().min(1).max(1500), mount: z.string().min(1).max(1024).optional() },
      (args, extra) =>
        ctx.run('handoff_note', extra, async (seat) => {
          const target = args.mount ?? seat.pcId;
          if (args.mount) {
            const i = await ctx.info(seat.pcId);
            if (!i.mounts.some((m) => m.hostPath === args.mount)) {
              throw new ApiError('NOT_FOUND', `${args.mount} is not a Vault folder of ${seat.pcId}`);
            }
          }
          await ctx.host.handoffs.add(target, {
            at: Date.now(),
            author: `${ctx.host.authorName()} (agent)`,
            text: args.text,
          });
          return textResult(`Note saved for ${target}.`);
        }),
    ),
  );
}
