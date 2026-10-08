import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  CalendarEvent,
  createMessage,
  directionOf,
  ERROR_CODES,
  groupOf,
  MESSAGE_TYPES,
  MOD_CAPS,
  messageCatalog,
  ModCap,
  OBS_QUERIES,
  type PayloadOf,
  ProtocolError,
  type ReplyOf,
  type RequestType,
  replySchemaOf,
  SKILL_NAMES,
  SkillArgs,
  type SkillArgsOf,
  safeParseMessage,
} from '../src/index.js';
import { defineMessage } from '../src/messages/define.js';

const protocolMd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol.md'), 'utf8');

describe('catalog', () => {
  it('puts every type in a PLAN §5 group', () => {
    const groups = new Set(MESSAGE_TYPES.map((t) => groupOf(t)));
    expect([...groups].sort()).toEqual([
      'bodies',
      'debug',
      'org',
      'pc',
      'reply',
      'seats',
      'skills',
      'ui',
      'world',
    ]);
  });

  it('uses dotted lowercase names with snake_case words', () => {
    for (const t of MESSAGE_TYPES) expect(t).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/);
  });

  it('lists every type in the protocol.md catalog table', () => {
    const missing = MESSAGE_TYPES.filter((t) => !protocolMd.includes(`| \`${t}\` |`));
    expect(missing).toEqual([]);
  });

  it('gives requests a reply schema that parses an empty-ish result only when it should', () => {
    expect(replySchemaOf('skill.run')).not.toBeNull();
    expect(replySchemaOf('agent.say')).toBeNull();
    expect(replySchemaOf('codex.delete')).toBeNull();
  });

  it('types ReplyOf from the catalog', () => {
    expectTypeOf<ReplyOf<'skill.run'>['status']>().toEqualTypeOf<
      'running' | 'done' | 'failed' | 'cancelled'
    >();
    expectTypeOf<'codex.search'>().toMatchTypeOf<RequestType>();
    expectTypeOf<ReplyOf<'host.pick_folder'>['path']>().toEqualTypeOf<string | null>();
  });

  it('keeps every direction explicit', () => {
    for (const t of MESSAGE_TYPES) expect(['mod_to_node', 'node_to_mod', 'both']).toContain(directionOf(t));
    expect(directionOf('pc.input')).toBe('mod_to_node');
    expect(directionOf('skill.run')).toBe('node_to_mod');
    expect(directionOf('codex.put')).toBe('mod_to_node');
  });

  it('only defines reply schemas that are objects', () => {
    for (const t of MESSAGE_TYPES) {
      const schema = replySchemaOf(t);
      if (schema) expect(schema).toBeInstanceOf(z.ZodObject);
    }
    expect(Object.keys(messageCatalog).length).toBe(MESSAGE_TYPES.length);
  });
});

describe('defineMessage', () => {
  it('refuses payload keys that collide with the envelope', () => {
    for (const key of ['t', 'v', 'id', 're']) {
      expect(() => defineMessage('x.y', { [key]: z.string() } as never)).toThrow(
        /collides with the envelope/,
      );
    }
  });
});

describe('skill args', () => {
  it('cover every skill name', () => {
    expect(Object.keys(SkillArgs).sort()).toEqual([...SKILL_NAMES].sort());
    expect(new Set(SKILL_NAMES).size).toBe(SKILL_NAMES.length);
    expect(new Set(OBS_QUERIES).size).toBe(OBS_QUERIES.length);
  });

  it('goto needs exactly one of pos and entity', () => {
    expect(SkillArgs.goto.safeParse({ pos: { x: 1, y: 2, z: 3 } }).success).toBe(true);
    expect(SkillArgs.goto.safeParse({ entity: 'player', range: 2.5 }).success).toBe(true);
    expect(SkillArgs.goto.safeParse({}).success).toBe(false);
    expect(SkillArgs.goto.safeParse({ pos: { x: 1, y: 2, z: 3 }, entity: 'player' }).success).toBe(false);
  });

  it('container put/take need an item', () => {
    const pos = { x: 0, y: 64, z: 0 };
    expect(SkillArgs.container.safeParse({ pos, action: 'list' }).success).toBe(true);
    expect(SkillArgs.container.safeParse({ pos, action: 'take' }).success).toBe(false);
    expect(SkillArgs.container.safeParse({ pos, action: 'take', item: 'bread', count: 4 }).success).toBe(
      true,
    );
  });

  it('accept tags and bare ids, reject junk', () => {
    expect(SkillArgs.mine.safeParse({ block: '#minecraft:logs', count: 10 }).success).toBe(true);
    expect(SkillArgs.mine.safeParse({ block: 'oak_log', count: 10 }).success).toBe(true);
    expect(SkillArgs.mine.safeParse({ block: 'Oak Log', count: 10 }).success).toBe(false);
    expect(SkillArgs.mine.safeParse({ block: 'oak_log', count: 0 }).success).toBe(false);
  });

  it('the skill.run fixture args satisfy the mine schema', () => {
    const args: SkillArgsOf<'mine'> = { block: '#minecraft:iron_ores', count: 12, radius: 32 };
    expect(SkillArgs.mine.parse(args)).toEqual(args);
  });
});

describe('tools v2 additions (protocol §6.1 caps, §7.4 sequence and arguments)', () => {
  const fixture = (name: string) =>
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name), 'utf8'),
    ) as Record<string, unknown>;

  it('sequence holds 2-8 steps of other skills, each validated against its own schema', () => {
    const step = { skill: 'eat', args: {} };
    expect(SkillArgs.sequence.safeParse({ steps: [step, step] }).success).toBe(true);
    expect(SkillArgs.sequence.safeParse({ steps: [step] }).success).toBe(false);
    expect(SkillArgs.sequence.safeParse({ steps: Array(9).fill(step) }).success).toBe(false);
    expect(SkillArgs.sequence.safeParse({ steps: [step, { skill: 'sequence', args: {} }] }).success).toBe(false);
    expect(SkillArgs.sequence.safeParse({ steps: [step, { skill: 'emote', args: { kind: 'wave' } }] }).success).toBe(
      false,
    );
    const bad = SkillArgs.sequence.safeParse({ steps: [step, { skill: 'collect', args: { item: 'oak_log' } }] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['steps', 1, 'args', 'count']);
    expect(bad.error?.issues[0]?.message).toMatch(/^collect: /);
    expect(SkillArgs.sequence.parse(fixture('skills/skill.run--sequence.json').args)).toBeTruthy();
  });

  it('collect, craft, container and give take their additive arguments; v1 calls still parse', () => {
    expect(SkillArgs.collect.parse(fixture('skills/skill.run--collect-gather.json').args)).toMatchObject({
      near: { x: 6, y: 66, z: 24 },
      make_tools: true,
    });
    expect(SkillArgs.collect.safeParse({ item: 'oak_log', count: 10 }).success).toBe(true);
    expect(SkillArgs.craft.parse(fixture('skills/skill.run--craft-tree.json').args)).toMatchObject({
      tree: true,
      gather_missing: true,
    });
    expect(SkillArgs.craft.safeParse({ item: 'stick', count: 4, table: { x: 1, y: 2, z: 3 } }).success).toBe(true);
    expect(SkillArgs.container.safeParse({ action: 'put', item: 'cobblestone' }).success).toBe(true);
    expect(SkillArgs.container.safeParse({ action: 'take' }).success).toBe(false);
    expect(SkillArgs.give.safeParse({ item: 'bread', to: 'player' }).success).toBe(true);
    expect(SkillArgs.give.safeParse({ item: 'bread', count: 2, to: 'player' }).success).toBe(true);
  });

  it('hello lists mod caps (lowercase dotted words); a skill.run reply may say what it replaced', () => {
    const hello = safeParseMessage(fixture('world/hello--caps.json'));
    expect(hello.status).toBe('ok');
    expect(safeParseMessage(fixture('world/hello.json')).status).toBe('ok');
    expect(safeParseMessage(fixture('world/invalid/hello--bad-cap.json')).status).toBe('invalid');
    for (const cap of Object.values(MOD_CAPS)) expect(ModCap.safeParse(cap).success, cap).toBe(true);
    const { t: _t, v: _v, re: _re, ...reply } = fixture('reply/ok--skill-run-replaced.json');
    expect(replySchemaOf('skill.run')?.parse(reply)).toMatchObject({ replaced: { jobId: 'job-41', skill: 'collect' } });
  });

  it('protocol.md documents the caps, sequence and the new arguments', () => {
    for (const word of ['caps', 'skill.sequence', 'sequence', 'make_tools', 'gather_missing', 'container.nearest', 'replaced']) {
      expect(protocolMd, word).toContain(word);
    }
  });
});

describe('the world guard (§7.4.3)', () => {
  const run = {
    t: 'skill.run',
    v: 1,
    id: 'n-1',
    jobId: 'job-1',
    agentId: 'ada1f3c',
    skill: 'mine',
    args: { block: 'stripped_spruce_log', count: 1 },
    waitMs: 20_000,
    replace: true,
  } as const;

  it('skill.run carries an optional consent scoped to positions or a zone', () => {
    expect(safeParseMessage(run).status).toBe('ok');
    const consent = {
      consentId: 'consent-0123456789abcdef',
      agentId: 'ada1f3c',
      positions: [{ x: 12, y: 65, z: 0 }],
      expiresAt: 1_791_453_900_000,
    };
    const ok = safeParseMessage({ ...run, consent });
    expect(ok.status).toBe('ok');
    expect(ok.status === 'ok' ? (ok.message as { consent?: unknown }).consent : null).toEqual(consent);
    expect(
      safeParseMessage({ ...run, consent: { ...consent, positions: undefined, zone: 'base' } }).status,
    ).toBe('ok');
    // Neither positions nor zone, or a zone that does not exist: invalid.
    expect(safeParseMessage({ ...run, consent: { ...consent, positions: undefined } }).status).toBe(
      'invalid',
    );
    expect(safeParseMessage({ ...run, consent: { ...consent, zone: 'everywhere' } }).status).toBe('invalid');
    // createMessage keeps it on the wire (zod would strip an unknown key).
    expect(createMessage('skill.run', { ...run, consent } as never)).toMatchObject({ consent });
  });

  it('agent.state bodies carry an optional zone', () => {
    const body = {
      agentId: 'ada1f3c',
      pos: { x: 6.5, y: 65, z: 5.5 },
      dim: 'minecraft:overworld',
      hp: 20,
      maxHp: 20,
      food: 18,
      saturation: 4,
      mode: 'follow',
      hasFood: true,
      inCombat: false,
    };
    const state = (zone: unknown) => ({ t: 'agent.state', v: 1, tick: 1, agents: [{ ...body, zone }] });
    const parsed = safeParseMessage(state({ kind: 'base', name: 'Base (office)' }));
    expect(parsed.status).toBe('ok');
    expect(
      parsed.status === 'ok' ? (parsed.message as { agents: { zone?: unknown }[] }).agents[0]?.zone : null,
    ).toEqual({ kind: 'base', name: 'Base (office)' });
    expect(safeParseMessage(state({ kind: 'wild' })).status).toBe('ok');
    expect(safeParseMessage(state({ kind: 'castle' })).status).toBe('invalid');
    expect(safeParseMessage({ t: 'agent.state', v: 1, tick: 1, agents: [body] }).status).toBe('ok');
  });

  it('protocol.md documents the codes, the zone and the consent', () => {
    for (const word of [
      'PROTECTED',
      'NO_NATURAL_SOURCE',
      '#### 7.4.3',
      'consent?',
      'zone?: { kind: base|built|wild',
    ]) {
      expect(protocolMd, word).toContain(word);
    }
  });
});

describe('payload rules', () => {
  it('agent.cmd toggles need on', () => {
    const base = { t: 'agent.cmd', v: 1, id: 'm-1', agentId: 'ada' } as const;
    expect(safeParseMessage({ ...base, cmd: 'ping_instead' }).status).toBe('invalid');
    expect(safeParseMessage({ ...base, cmd: 'ping_instead', on: true }).status).toBe('ok');
    expect(safeParseMessage({ ...base, cmd: 'follow' }).status).toBe('ok');
  });

  it('pc.action create carries a type and no pcId', () => {
    expect(() => createMessage('pc.action', { action: 'create' })).toThrow(ProtocolError);
    expect(createMessage('pc.action', { action: 'create', type: 'macos' }, { id: 'm-1' }).type).toBe('macos');
  });

  it('calendar events refuse weekdays on the game clock', () => {
    const event = {
      id: 'ev-1',
      title: 'Standup',
      kind: 'meeting',
      assignees: 'all',
      clock: 'game',
      at: 0,
      recurrence: { kind: 'weekdays' },
      durationMin: 10,
      catchUp: 'skip',
      runWhileAway: false,
      createdBy: 'player',
      status: 'active',
      nextAt: null,
      occurrences: [],
    };
    expect(CalendarEvent.safeParse(event).success).toBe(false);
    expect(CalendarEvent.safeParse({ ...event, clock: 'real' }).success).toBe(true);
  });

  it('chat.send keeps working without mode (M1 senders)', () => {
    const payload: PayloadOf<'chat.send'> = { to: 'all', text: '@ada hi' };
    expect(createMessage('chat.send', payload, { id: 'm-1' })).toEqual({
      t: 'chat.send',
      v: 1,
      id: 'm-1',
      ...payload,
    });
  });

  it('error codes are unique SCREAMING_SNAKE_CASE', () => {
    for (const [key, code] of Object.entries(ERROR_CODES)) {
      expect(code).toBe(key);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,63}$/);
    }
  });
});
