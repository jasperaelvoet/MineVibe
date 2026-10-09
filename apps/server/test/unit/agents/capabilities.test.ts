/**
 * What a desk agent is told about its PC's capabilities (PLAN §8.7): the KICKOFF's "This PC" line, `pc__info`'s
 * capability section and the persona's rules for blockers. They come from a live run where an agent asked to run an
 * Android game declared it impossible, port-scanned the PC's isolated network and gave up.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { capabilityDetails, capabilityLine } from '../../../src/agents/prompts/capabilities.js';
import { kickoffMessage } from '../../../src/agents/prompts/kickoff.js';
import { deskBlockerRules, personaPrompt } from '../../../src/agents/prompts/persona.js';
import { createPcServer, type PcHost } from '../../../src/agents/tools/pcServer.js';
import { FakePcApi } from '../../../src/contracts/FakePcApi.js';
import type { PcGuestCapabilities, PcGuestInfo } from '../../../src/contracts/PcApi.js';

const NONCE = 'abc123';

function caps(over: Partial<PcGuestCapabilities> = {}): PcGuestCapabilities {
  return {
    arch: 'aarch64',
    kernel: '6.18.35-197-debug',
    kvm: false,
    cpus: 2,
    memoryMiB: 3911,
    diskFreeGiB: 25.4,
    network: { internet: true, hostAndLan: false },
    toolchains: ['node 24.4.1', 'python3 3.12.3', 'gcc 13.3.0'],
    virtualization: { enabled: false, unavailable: null },
    android: { enabled: false, unavailable: null, status: 'off', detail: null, host: null },
    ...over,
  };
}

function pc(c: PcGuestCapabilities | undefined): PcGuestInfo {
  return {
    pcId: 'linux-1',
    type: 'linux',
    status: 'running',
    os: 'linux',
    screen: { w: 1280, h: 800 },
    user: 'cua',
    home: '/home/cua',
    mounts: [],
    codexPath: null,
    ...(c ? { capabilities: c } : {}),
  };
}

describe('the KICKOFF capability line', () => {
  it('says what the PC is, that it is isolated, and what Jordan can turn on', () => {
    const line = capabilityLine(pc(caps()), 'Jordan');
    expect(line).toBe(
      "This PC: arm64 Linux, 2 vCPUs, 3.8 GiB RAM, 25 GiB free; internet yes, the Mac, other PCs and the LAN off-limits; no KVM and no Android phone: Jordan can turn either on in linux-1's settings (APKs then run with `android install <file.apk> && android open`).",
    );
  });

  it('names a running phone and the command, and a Mac that cannot nest virtualization', () => {
    const line = capabilityLine(
      pc(
        caps({
          virtualization: { enabled: false, unavailable: 'needs an M3 or newer Mac (this one has an M1)' },
          android: {
            enabled: true,
            unavailable: null,
            status: 'running',
            detail: null,
            host: 'android-phone',
          },
        }),
      ),
      'Jordan',
    );
    expect(line).toContain(
      'no KVM (nested virtualization: not on this Mac, needs an M3 or newer Mac (this one has an M1))',
    );
    expect(line).toContain(
      'Android phone: running as android-phone (`android install <file.apk> && android open`)',
    );
  });

  it('names the settings once for what Jordan can turn on, and says why a Mac cannot have the rest', () => {
    const line = capabilityLine(
      pc(
        caps({
          virtualization: { enabled: false, unavailable: 'needs an M3 or newer Mac (this one has an M1)' },
        }),
      ),
      'Jordan',
    );
    expect(line).toContain('no KVM (nested virtualization: not on this Mac, needs an M3 or newer Mac');
    expect(line).toContain(
      "no Android phone (Jordan can turn it on in linux-1's settings; APKs then run with `android install <file.apk> && android open`)",
    );
    expect(line?.match(/settings/g)).toHaveLength(1);
  });

  it('is absent for a PC without capabilities (macOS)', () => {
    expect(capabilityLine(pc(undefined), 'Jordan')).toBeNull();
  });

  it('is part of the kickoff', () => {
    const text = kickoffMessage({
      nonce: NONCE,
      playerName: 'Jordan',
      pc: pc(caps({ virtualization: { enabled: true, unavailable: null }, kvm: true })),
      task: 'get the hunting game running',
      planFirst: false,
      claudeMd: null,
      handoffs: [],
    });
    expect(text).toContain('This PC: arm64 Linux, 2 vCPUs');
    expect(text).toContain('KVM yes (nested virtualization on)');
  });
});

describe('pc__info', () => {
  it('lists the capabilities: hardware, network, KVM, the phone and the toolchains', () => {
    const lines = capabilityDetails(
      pc(
        caps({
          android: {
            enabled: true,
            unavailable: null,
            status: 'preparing',
            detail: 'downloading the Android image (40%)',
            host: null,
          },
        }),
      ),
      'Jordan',
    );
    expect(lines[0]).toBe('Capabilities:');
    expect(lines.join('\n')).toContain(
      'CPU aarch64 (Apple silicon: arm64 binaries only), kernel 6.18.35-197-debug',
    );
    expect(lines.join('\n')).toContain(
      "this PC's own network holds only it (and its Android phone), and other PCs cannot be reached. Don't scan for machines",
    );
    expect(lines.join('\n')).toContain('Android phone: preparing (downloading the Android image (40%))');
    expect(lines.join('\n')).toContain('There is no Android SDK emulator for arm64 Linux');
    expect(lines.at(-1)).toBe('- Toolchains: node 24.4.1, python3 3.12.3, gcc 13.3.0');
  });

  it('the info tool prints them', async () => {
    class CapsPcApi extends FakePcApi {
      override async info(pcId: string): Promise<PcGuestInfo> {
        return { ...(await super.info(pcId)), capabilities: caps() };
      }
    }
    const host: PcHost = {
      agentId: 'ada-1',
      pcs: new CapsPcApi([{ pcId: 'linux-1' }]),
      plans: new PlanCapture(['/home/cua']),
      handoffs: new HandoffNotes(join(mkdtempSync(join(tmpdir(), 'mv-caps-')), 'h')),
      access: () => ({ pcId: 'linux-1', epoch: 1 }),
      authorName: () => 'Ada',
      playerName: () => 'Jordan',
    };
    const server = createPcServer(host);
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown, e: unknown) => Promise<{ content: { text?: string }[] }> }
        >;
      }
    )._registeredTools;
    const res = await tools.info?.handler({}, {});
    const text = res?.content.map((c) => c.text ?? '').join('\n') ?? '';
    expect(text).toContain('Capabilities:');
    expect(text).toContain("Jordan can turn it on in linux-1's settings");
    expect(text).toContain('Toolchains: node 24.4.1');
  });
});

describe('the persona', () => {
  const input = {
    name: 'Ada',
    handle: 'ada',
    role: 'engineer' as const,
    ceo: false,
    playerName: 'Jordan',
    nonce: NONCE,
    mcTools: 'v2' as const,
  };

  it('a desk session gets the blocker rules: verify first, never scan, plain options', () => {
    const desk = personaPrompt({ ...input, session: 'desk' });
    for (const rule of deskBlockerRules('Jordan')) expect(desk).toContain(rule);
    expect(desk).toContain('try 2-3 realistic routes');
    expect(desk).toContain('Never scan the network for other machines');
    expect(desk).toContain("Jordan's Mac is off-limits");
    expect(desk).toContain('AskUserQuestion options must stand on their own');
  });

  it('the body session does not carry them (it never sits at a PC shell)', () => {
    const body = personaPrompt({ ...input, session: 'body' });
    expect(body).not.toContain('Never scan the network');
  });
});
