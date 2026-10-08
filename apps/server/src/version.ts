import pkg from '../package.json' with { type: 'json' };

/** The MineVibe server version (from apps/server/package.json, inlined by the bundler). */
export const SERVER_VERSION: string = pkg.version;
