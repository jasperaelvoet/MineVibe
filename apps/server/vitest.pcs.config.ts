import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `npm run test:pcs`: PC driver integration tests against the real Apple `container` runtime
 * (PLAN §13.5). Local only: never part of `npm test` or CI. Needs Apple Silicon, macOS 26+, and the
 * user's go-ahead for starting the container service and pulling/building the image.
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
