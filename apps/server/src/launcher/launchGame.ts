import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateArguments, getPlatform, MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { SERVER_VERSION } from '../version.js';

/** Minecraft's offline UUID: `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)` (MD5, version 3). Dashed. */
export function offlineUuid(name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = ((b[6] as number) & 0x0f) | 0x30;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Game arguments MineVibe always adds (PLAN §2, §7.9). The backend flag name is verified in 26.3's `Main`. */
export const MINEVIBE_GAME_ARGS: readonly string[] = Object.freeze([
  '--disableMultiplayer',
  '--graphicsBackend',
  'opengl',
]);

type LaunchArgument = string | { rules?: unknown[]; value: string | string[] };

/**
 * The vanilla launcher's `arguments.default-user-jvm` block (new in 26.x version JSONs: ZGC, compact object
 * headers, …), evaluated for this platform, without its `-Xms`/`-Xmx` (MineVibe sets the heap itself).
 */
export async function defaultUserJvmArgs(gameDir: string, minecraftVersion: string): Promise<string[]> {
  let raw: { arguments?: { 'default-user-jvm'?: LaunchArgument[] } };
  try {
    raw = JSON.parse(await readFile(MinecraftFolder.from(gameDir).getVersionJson(minecraftVersion), 'utf8'));
  } catch {
    return [];
  }
  const out: string[] = [];
  const platform = getPlatform();
  for (const arg of raw.arguments?.['default-user-jvm'] ?? []) {
    if (typeof arg === 'string') {
      out.push(arg);
      continue;
    }
    // biome-ignore lint/suspicious/noExplicitAny: xmcl's rule type is not exported in a usable form
    if (arg.rules && !Version.checkAllowed(arg.rules as any, platform)) continue;
    out.push(...(Array.isArray(arg.value) ? arg.value : [arg.value]));
  }
  return out.filter((a) => !/^-Xm[sx]/.test(a));
}

/**
 * Drops game arguments whose value is a placeholder xmcl could not fill (`--clientId ${clientid}`,
 * `--xuid ${auth_xuid}`): an offline profile has neither.
 */
export function dropUnresolvedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const next = args[i + 1];
    if (a.startsWith('--') && next !== undefined && /^\$\{[^}]+\}$/.test(next)) {
      i++;
      continue;
    }
    if (/^\$\{[^}]+\}$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

export interface LaunchCommandOptions {
  readonly javaPath: string;
  readonly gameDir: string;
  /** The Fabric version id to launch. */
  readonly versionId: string;
  readonly resolved?: ResolvedVersion;
  readonly playerName: string;
  readonly bridgeFile: string;
  /** PID the mod watches (the Node orchestrator). */
  readonly parentPid: number;
  readonly maxMemoryMb: number;
  readonly width?: number;
  readonly height?: number;
  readonly extraJvmArgs?: readonly string[];
  readonly extraGameArgs?: readonly string[];
}

/**
 * Builds the full `java …` command line from the version JSONs with `@xmcl/core` `generateArguments`:
 * classpath, natives paths, `-XstartOnFirstThread` (an `os: osx` rule in 26.3's JSON), Fabric's
 * `-DFabricMcEmu`, the offline profile, plus MineVibe's heap, bridge-file and parent-PID properties and
 * `--disableMultiplayer --graphicsBackend opengl`.
 */
export async function buildLaunchCommand(options: LaunchCommandOptions): Promise<string[]> {
  const resolved = options.resolved ?? (await Version.parse(options.gameDir, options.versionId));
  // `-Djava.library.path=${natives_directory}/java` and friends point here; LWJGL extracts into it.
  await mkdir(MinecraftFolder.from(options.gameDir).getNativesRoot(resolved.id), { recursive: true });
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const extraJVMArgs = [
    ...(await defaultUserJvmArgs(options.gameDir, resolved.minecraftVersion)),
    `-Xmx${options.maxMemoryMb}M`,
    `-Dminevibe.bridgeFile=${options.bridgeFile}`,
    `-Dminevibe.parentPid=${options.parentPid}`,
    ...(options.extraJvmArgs ?? []),
  ];
  const args = await generateArguments({
    gamePath: options.gameDir,
    javaPath: options.javaPath,
    version: resolved,
    gameProfile: { name: options.playerName, id: offlineUuid(options.playerName).replaceAll('-', '') },
    accessToken: '0',
    launcherName: 'MineVibe',
    launcherBrand: SERVER_VERSION,
    gameName: 'MineVibe',
    extraJVMArgs,
    extraMCArgs: [...MINEVIBE_GAME_ARGS, ...(options.extraGameArgs ?? [])],
    resolution: { width, height },
    features: {
      has_custom_resolution: { resolution_width: String(width), resolution_height: String(height) },
    },
  });
  return dropUnresolvedArgs(args);
}

export interface SpawnGameOptions {
  readonly command: readonly string[];
  readonly gameDir: string;
  /** stdout + stderr of the JVM, rewritten per launch (Minecraft also writes `<gameDir>/logs/latest.log`). */
  readonly consoleLog: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Environment for the JVM: the user's, minus credentials that have no business in the game process. */
export function gameEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE|AWS_|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Spawns the JVM with cwd = the game directory (Entity Culling resolves `config/` against cwd). stdin stays an
 * open pipe: it is the lifeline, closing when Node dies.
 */
export async function spawnGame(options: SpawnGameOptions): Promise<ChildProcess> {
  const [command, ...args] = options.command;
  if (!command) throw new Error('empty launch command');
  await mkdir(dirname(options.consoleLog), { recursive: true });
  await mkdir(join(options.gameDir, 'mods'), { recursive: true });
  const out = createWriteStream(options.consoleLog, { flags: 'w', mode: 0o644 });
  const child = spawn(command, args, {
    cwd: options.gameDir,
    env: options.env ?? gameEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  child.on('close', () => out.end());
  // Never write to the lifeline; just keep it open. Ignore EPIPE once the JVM is gone.
  child.stdin?.on('error', () => {});
  return child;
}
