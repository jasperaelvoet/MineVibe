import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `npm run test:live`: the live SDK smoke (PLAN §13 item 6). It runs real Claude turns on the user's subscription
 * (a handful of short turns), so it never runs in CI or in `npm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@minevibe/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/live/**/*.live.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
