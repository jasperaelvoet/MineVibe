import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against the protocol's TypeScript source; no build step needed.
    alias: {
      '@minevibe/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Hermetic: the tests of the default paths see the default `mc` tool set (v2) even when the shell selects the
    // v1 fallback (`MINEVIBE_MC_TOOLS=v1`); tests of v1 pin it themselves (vi.stubEnv or an explicit version).
    env: { MINEVIBE_MC_TOOLS: '' },
  },
});
