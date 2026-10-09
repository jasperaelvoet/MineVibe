import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `npm run test:pcs`: PC driver integration tests against the real Apple `container` runtime
 * (PLAN §13.5). Local only: never part of `npm test` or CI. Needs Apple Silicon, macOS 26+, and the
 * user's go-ahead for starting the container service and pulling/building the image.
 *
 * The macOS PC tests (`macPc.int.ts`, PLAN §8.7) run only with `MINEVIBE_TEST_MACOS=1`: they use MineVibe's dev
 * Lume and need the macOS image in its storage (about 24 GB; `MINEVIBE_TEST_MACOS_PULL=1` pulls it).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@minevibe/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/pcs/integration/**/*.int.ts'],
    testTimeout: 600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
});
