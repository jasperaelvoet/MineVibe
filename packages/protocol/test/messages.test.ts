import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  CalendarEvent,
  ConsentToken,
  createMessage,
  directionOf,
  ERROR_CODES,
  FindArgs,
  groupOf,
  LookAroundArgs,
  LookAroundResult,
  MESSAGE_TYPES,
  messageCatalog,
  NO_NATURAL_SOURCE,
  NoNaturalSourceDetail,
  OBS_QUERIES,
  type PayloadOf,
  PROTECTED,
  ProtectedDetail,
  ProtocolError,
  type ReplyOf,
  type RequestType,
  replySchemaOf,
  SKILL_NAMES,
  SkillArgs,
  type SkillArgsOf,
  SourceCandidate,
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

describe('W1: protection and perception', () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  const fixture = (path: string) =>
    JSON.parse(readFileSync(join(fixturesDir, path), 'utf8')) as Record<string, unknown> & {
      result: Record<string, unknown>;
    };

  it('block-changing skills take allow_protected; collect takes replant', () => {
    for (const skill of [
      'mine',
      'collect',
      'dig',
      'place',
      'use_item',
      'attack',
      'container',
      'build',
      'farm',
    ] as const) {
      const shape = (SkillArgs[skill] as unknown as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.hasOwn(shape, 'allow_protected'), skill).toBe(true);
    }
    expect(
      SkillArgs.collect.safeParse({ item: 'oak_log', count: 6, replant: true, allow_protected: false })
        .success,
    ).toBe(true);
    expect(SkillArgs.mine.safeParse({ block: 'oak_log', count: 1, allow_protected: 'yes' }).success).toBe(
      false,
    );
  });

  it('consent lives outside args, so a tool call cannot carry it', () => {
    const consent = fixture('skills/skill.run--consent.json');
    expect(safeParseMessage(consent).status).toBe('ok');
    // zod strips keys a skill does not know: `consent` inside args never reaches the mod.
    const parsed = SkillArgs.mine.parse({ block: 'oak_log', count: 1, consent: { token: 'a'.repeat(32) } });
    expect(Object.hasOwn(parsed, 'consent')).toBe(false);
    expect(ConsentToken.safeParse('3f9c2a7be41d08c65a9e0b7d21c4f8e1').success).toBe(true);
    expect(ConsentToken.safeParse('3F9C2A7BE41D08C65A9E0B7D21C4F8E1').success).toBe(false);
  });

  it('the failure details of the fixtures match their schemas', () => {
    const prot = fixture('skills/skill.result--protected.json');
    expect(ProtectedDetail.parse(prot.result.protected)).toEqual(prot.result.protected);
    expect((prot.error as { code: string }).code).toBe(PROTECTED);
    const none = fixture('skills/skill.result--no-natural-source.json');
    expect(NoNaturalSourceDetail.parse(none.result.noNaturalSource)).toEqual(none.result.noNaturalSource);
    expect((none.error as { code: string }).code).toBe(NO_NATURAL_SOURCE);
    expect(
      SourceCandidate.safeParse({
        pos: { x: 0, y: 0, z: 0 },
        block: 'x',
        distance: 1,
        dir: 'up',
        why: 'protected',
      }).success,
    ).toBe(false);
  });

  it('agent.state bodies carry the zone as the footer words', () => {
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
    expect(safeParseMessage(state('in Base')).status).toBe('ok');
    expect(safeParseMessage(state('12m from Base')).status).toBe('ok');
    expect(safeParseMessage(state({ kind: 'base' })).status).toBe('invalid');
    expect(safeParseMessage({ t: 'agent.state', v: 1, tick: 1, agents: [body] }).status).toBe('ok');
  });

  it('look_around returns a scene within its budget, with zone and trees as data', () => {
    const ok = fixture('reply/ok--obs-look-around.json');
    const result = LookAroundResult.parse(ok.result);
    expect(result.scene.length).toBeLessThanOrEqual(900);
    expect(result.scene).toContain('Inside Base');
    expect(result.trees?.some((t) => t.reachable === 'reachable')).toBe(true);
    expect(LookAroundArgs.safeParse({ detail: 'full', radius: 24 }).success).toBe(true);
    expect(LookAroundArgs.safeParse({ detail: 'huge' }).success).toBe(false);
    expect(FindArgs.safeParse({ what: '#minecraft:logs', filter: 'natural' }).success).toBe(true);
    expect(FindArgs.safeParse({ what: 'oak_log', filter: 'mine' }).success).toBe(false);
  });

  it('protocol.md documents the new codes and fields', () => {
    for (const word of [
      'PROTECTED',
      'NO_NATURAL_SOURCE',
      'allow_protected',
      'consentId',
      'noNaturalSource',
      'detail',
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
