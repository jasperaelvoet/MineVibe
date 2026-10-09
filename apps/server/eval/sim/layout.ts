/**
 * The eval world's map (all positions fixed; north is -z):
 *
 * - Spawn (0, 64, 0). The agent Ada stands at (0, 64, -3) (her home), the player Jasper at (2, 64, -2).
 * - Jasper's house (player-built, structure `house`): stripped spruce log walls x 3..9, z 3..9, y 64..66, a spruce
 *   plank floor and roof, an oak door at (6, 64..65, 3) facing north, glass panes. Inside: a chest at (4, 64, 8) with
 *   Jasper's things, a crafting table at (5, 64, 8), a furnace at (8, 64, 8) and a bed at (8, 64, 5).
 * - Natural trees: oak A at (-10, 64, 6) (5 logs), oak B at (-14, 64, -8) (5), oak C at (6, 64, -14) (5), birch D at
 *   (-6, 64, 16) (5), and oak E on top of a stone pillar at (-20, 70, -2) (5 logs, unreachable). A single
 *   `collect oak_log ×10` from Ada's home reaches 10 (C, then B; the miner searches 24 blocks around where it stands).
 * - A stone outcrop at x 16..18, z -3..3, y 64..67 with iron ore (4) and coal ore (3) on its exposed west face.
 * - The Base (W1, read by the v2 mod only): the house's box plus the mod's 2-block margin, x 1..11, y 61..69, z 1..11,
 *   Jasper's. The house stands where the starter office would: the shelter Jasper already has. Its blocks stay
 *   player-built, so the scene names both ("Base 3m SE", "Jasper's build (… blocks) 4m SE").
 *
 * The house logs are the nearest logs to spawn: `mine #minecraft:logs` (or `collect` of the logs tag) takes them first.
 */

import type { IdleMode } from '@minevibe/protocol';
import { NS } from './items.js';
import { type Box, type Pos, SimWorld, type Zone } from './world.js';

export const HOUSE = 'house';
export const SPAWN: Pos = { x: 0, y: 64, z: 0 };
export const AGENT_HOME: Pos = { x: 0, y: 64, z: -3 };
export const PLAYER_POS: Pos = { x: 2, y: 64, z: -2 };
export const HOUSE_CHEST: Pos = { x: 4, y: 64, z: 8 };
export const HOUSE_TABLE: Pos = { x: 5, y: 64, z: 8 };
export const HOUSE_FURNACE: Pos = { x: 8, y: 64, z: 8 };
export const HOUSE_BED: Pos = { x: 8, y: 64, z: 5 };
export const HOUSE_INTERIOR: Box = { min: { x: 4, y: 64, z: 4 }, max: { x: 8, y: 66, z: 8 } };
/** The Base zone: the house (x 3..9, y 63..67, z 3..9) plus the mod's 2-block margin (`Zones.BASE_MARGIN`). */
export const BASE_ZONE: Zone = {
  name: 'Base',
  box: { min: { x: 1, y: 61, z: 1 }, max: { x: 11, y: 69, z: 11 } },
  owner: null,
};
/** What Jasper keeps in his chest. */
export const CHEST_ITEMS: readonly (readonly [string, number])[] = [
  [`${NS}bread`, 6],
  [`${NS}cobblestone`, 16],
  [`${NS}torch`, 8],
];

export interface TreeSpec {
  readonly name: string;
  readonly wood: 'oak' | 'birch';
  readonly base: Pos;
  readonly height: number;
}

export const TREES: readonly TreeSpec[] = [
  { name: 'oak_a', wood: 'oak', base: { x: -10, y: 64, z: 6 }, height: 5 },
  { name: 'oak_b', wood: 'oak', base: { x: -14, y: 64, z: -8 }, height: 5 },
  { name: 'oak_c', wood: 'oak', base: { x: 6, y: 64, z: -14 }, height: 5 },
  { name: 'birch_d', wood: 'birch', base: { x: -6, y: 64, z: 16 }, height: 5 },
  { name: 'oak_e', wood: 'oak', base: { x: -20, y: 70, z: -2 }, height: 5 },
];
/** The pillar tree is never reachable. */
export const PILLAR_TREE = 'oak_e';

function buildHouse(w: SimWorld): void {
  const put = (x: number, y: number, z: number, id: string) => w.set({ x, y, z }, id, 'player', HOUSE);
  for (let x = 3; x <= 9; x++) {
    for (let z = 3; z <= 9; z++) {
      const wall = x === 3 || x === 9 || z === 3 || z === 9;
      put(x, 63, z, `${NS}spruce_planks`);
      put(x, 67, z, `${NS}spruce_planks`);
      if (!wall) continue;
      for (let y = 64; y <= 66; y++) put(x, y, z, `${NS}stripped_spruce_log`);
    }
  }
  put(6, 64, 3, `${NS}oak_door`);
  put(6, 65, 3, `${NS}oak_door`);
  put(3, 65, 6, `${NS}glass_pane`);
  put(9, 65, 6, `${NS}glass_pane`);
  put(6, 65, 9, `${NS}glass_pane`);
  // Interior air is explicit so scans and exposure see the rooms.
  for (let x = 4; x <= 8; x++)
    for (let z = 4; z <= 8; z++) for (let y = 64; y <= 66; y++) w.set({ x, y, z }, 'minecraft:air');
  put(HOUSE_CHEST.x, HOUSE_CHEST.y, HOUSE_CHEST.z, `${NS}chest`);
  put(HOUSE_TABLE.x, HOUSE_TABLE.y, HOUSE_TABLE.z, `${NS}crafting_table`);
  put(HOUSE_FURNACE.x, HOUSE_FURNACE.y, HOUSE_FURNACE.z, `${NS}furnace`);
  put(HOUSE_BED.x, HOUSE_BED.y, HOUSE_BED.z, `${NS}red_bed`);
  w.containers.set(
    `${HOUSE_CHEST.x},${HOUSE_CHEST.y},${HOUSE_CHEST.z}`,
    new Map(CHEST_ITEMS.map(([i, c]) => [i, c])),
  );
  w.shelters.push(HOUSE_INTERIOR);
  w.zones.push(BASE_ZONE);
}

function buildTree(w: SimWorld, t: TreeSpec): void {
  const structure = `tree:${t.name}`;
  const top = t.base.y + t.height - 1;
  for (let dy = t.height - 2; dy <= t.height; dy++) {
    const y = t.base.y + dy;
    const r = dy === t.height ? 1 : 2;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dz === 0 && y <= top) continue;
        if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        w.set({ x: t.base.x + dx, y, z: t.base.z + dz }, `${NS}${t.wood}_leaves`, 'natural', structure);
      }
    }
  }
  for (let y = t.base.y; y <= top; y++)
    w.set({ x: t.base.x, y, z: t.base.z }, `${NS}${t.wood}_log`, 'natural', structure);
}

/** The box around a tree (trunk and canopy) that a walk can never reach. */
export function treeBox(t: TreeSpec): Box {
  return {
    min: { x: t.base.x - 2, y: t.base.y, z: t.base.z - 2 },
    max: { x: t.base.x + 2, y: t.base.y + t.height + 1, z: t.base.z + 2 },
  };
}

function buildOutcrop(w: SimWorld): void {
  for (let x = 16; x <= 18; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 64; y <= 67; y++) w.set({ x, y, z }, `${NS}stone`, 'natural', 'outcrop');
  const ores: [number, number, number, string][] = [
    [16, 64, -1, 'iron_ore'],
    [16, 65, 1, 'iron_ore'],
    [16, 66, 0, 'iron_ore'],
    [16, 64, 2, 'iron_ore'],
    [16, 65, -2, 'coal_ore'],
    [16, 64, 0, 'coal_ore'],
    [16, 67, 1, 'coal_ore'],
  ];
  for (const [x, y, z, id] of ores) w.set({ x, y, z }, `${NS}${id}`, 'natural', 'outcrop');
}

export interface WorldOptions {
  /** Game clock at the start (ticks; 0 = day 1 06:00). Default 2000 (08:00). */
  readonly clock?: number;
  readonly inventory?: readonly (readonly [string, number])[];
  readonly held?: string | null;
  readonly mode?: IdleMode;
  /** Every tree is out of reach (a water moat around each one). */
  readonly allTreesUnreachable?: boolean;
  /** A zombie spawns at this tick at (-10, 64, -14) and walks to the player. */
  readonly zombieAt?: number | null;
}

export const ZOMBIE_SPAWN: Pos = { x: -10, y: 64, z: -14 };

/** The standard eval world. */
export function buildWorld(options: WorldOptions = {}): SimWorld {
  const w = new SimWorld({
    agentPos: AGENT_HOME,
    playerPos: PLAYER_POS,
    clock: options.clock ?? 2_000,
    inventory: options.inventory ?? [],
    held: options.held ?? null,
    mode: options.mode ?? 'follow',
  });
  buildHouse(w);
  for (const t of TREES) buildTree(w, t);
  // The pillar under oak E.
  const e = TREES.find((t) => t.name === PILLAR_TREE) as TreeSpec;
  for (let y = 64; y < e.base.y; y++)
    w.set({ x: e.base.x, y, z: e.base.z }, `${NS}stone`, 'natural', 'pillar');
  w.unreachable.push(treeBox(e));
  buildOutcrop(w);
  if (options.allTreesUnreachable) {
    for (const t of TREES) {
      if (t.name === PILLAR_TREE) continue;
      w.unreachable.push(treeBox(t));
      // A water moat two blocks out (cosmetic: look_around reports water).
      for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++)
          if (Math.max(Math.abs(dx), Math.abs(dz)) === 3)
            w.set({ x: t.base.x + dx, y: 63, z: t.base.z + dz }, `${NS}water`, 'natural', 'moat');
    }
  }
  if (options.zombieAt !== undefined && options.zombieAt !== null) {
    w.schedule(options.zombieAt, 'zombie', (world) => world.spawnMob('minecraft:zombie', ZOMBIE_SPAWN));
  }
  return w;
}
