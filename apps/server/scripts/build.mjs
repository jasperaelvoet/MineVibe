// Bundles the server into dist/main.mjs (PLAN §4: TypeScript -> esbuild).
// @minevibe/protocol is bundled from source via the "source" export condition, so no prior build is needed.
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'main.mjs');

await rm(join(root, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  conditions: ['source'],
  sourcemap: true,
  legalComments: 'linked',
  external: [
    // ws probes these optional native add-ons inside try/catch; they are not shipped.
    'bufferutil',
    'utf-8-validate',
    // Resolved from node_modules next to dist/ (PLAN §9.1: Resources/server/node_modules): the Agent SDK finds its
    // platform claude binary relative to its own package, and cua loads its native darwin-arm64 add-on.
    '@anthropic-ai/claude-agent-sdk',
    '@trycua/cua',
    // The SDK takes zod as a peer: one zod instance for our tool schemas and the SDK's MCP server.
    'zod',
  ],
  // Bundled CommonJS dependencies (ws, pino) call require() for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __mvCreateRequire } from 'node:module';\nconst require = __mvCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
