import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDetail,
  countingFetch,
  downloadLabel,
  LaunchProgress,
  type LaunchProgressMessage,
} from '../../src/app/launchProgress.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('countingFetch', () => {
  it('reports the request and every body byte, keeping status, ok, url and json()', async () => {
    const requests: string[] = [];
    let bytes = 0;
    const base = async () => {
      const res = new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(res, 'url', { value: 'https://example.test/final' });
      return res;
    };
    const fetch = countingFetch(
      base,
      (u) => requests.push(u),
      (n) => {
        bytes += n;
      },
    );
    const res = await fetch('https://example.test/x');
    expect(requests).toEqual(['https://example.test/x']);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://example.test/final');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ hello: 'world' });
    expect(bytes).toBe(JSON.stringify({ hello: 'world' }).length);
  });

  it('passes error statuses and bodiless responses through', async () => {
    const fetch = countingFetch(
      async () => new Response(null, { status: 304 }),
      () => {},
      () => {},
    );
    const res = await fetch('https://example.test/');
    expect(res.status).toBe(304);
    const notFound = await countingFetch(
      async () => new Response('missing', { status: 404 }),
      () => {},
      () => {},
    )('https://example.test/');
    expect(notFound.ok).toBe(false);
    expect(await notFound.text()).toBe('missing');
  });

  it('propagates network errors', async () => {
    const fetch = countingFetch(
      async () => {
        throw new TypeError('fetch failed');
      },
      () => {},
      () => {},
    );
    await expect(fetch('https://example.test/')).rejects.toThrow('fetch failed');
  });
});

describe('downloadLabel', () => {
  it('names what each host serves', () => {
    expect(downloadLabel('https://resources.download.minecraft.net/ab/abcd')).toBe('Minecraft assets');
    expect(downloadLabel('https://piston-data.mojang.com/v1/objects/x/client.jar')).toBe('Minecraft');
    expect(downloadLabel('https://libraries.minecraft.net/org/lwjgl/x.jar')).toBe('Minecraft');
    expect(downloadLabel('https://maven.fabricmc.net/net/fabricmc/x.jar')).toBe('Fabric');
    expect(downloadLabel('https://cdn.modrinth.com/data/x.jar')).toBe('mods');
    expect(downloadLabel('https://elsewhere.test/x')).toBe('game files');
    expect(downloadLabel('not a url')).toBe('game files');
  });
});

describe('LaunchProgress', () => {
  function collect(throttleMs = 250) {
    const sent: LaunchProgressMessage[] = [];
    const progress = new LaunchProgress((m) => sent.push(m), { throttleMs });
    return { sent, progress };
  }

  it('reports no installation work when nothing is downloaded (no first-run window)', () => {
    const { sent, progress } = collect();
    progress.onPlay({ phase: 'install', state: 'start' });
    progress.onPlay({ phase: 'install', state: 'done' });
    progress.onPlay({ phase: 'seed' });
    progress.onPlay({ phase: 'launch' });
    progress.onPlay({ phase: 'launched', pid: 1 });
    progress.onPlay({ phase: 'connected' });
    expect(sent.filter((m) => m.t === 'progress').every((m) => m.t === 'progress' && !m.work)).toBe(true);
    expect(sent.at(-1)).toEqual({ t: 'ready' });
    progress.dispose();
  });

  it('flags work at the first request and keeps it, with throttled byte counts', () => {
    vi.useFakeTimers();
    const { sent, progress } = collect(250);
    progress.onPlay({ phase: 'install', state: 'start' });
    expect(sent.at(-1)).toMatchObject({ t: 'progress', phase: 'install', work: false });
    progress.request('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    expect(sent.at(-1)).toMatchObject({
      t: 'progress',
      work: true,
      title: 'Downloading Minecraft, Fabric and mods',
    });
    const before = sent.length;
    progress.request('https://resources.download.minecraft.net/aa/aa');
    for (let i = 0; i < 100; i++) progress.received(1024 * 1024);
    expect(sent.length).toBe(before); // throttled
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({
      work: true,
      bytes: 100 * 1024 * 1024,
      detail: 'Minecraft assets · 100.0 MiB downloaded',
    });
    progress.onPlay({ phase: 'install', state: 'done' });
    progress.onPlay({ phase: 'launch' });
    expect(sent.at(-1)).toMatchObject({ phase: 'launch', work: true, title: 'Starting Minecraft' });
    progress.dispose();
  });

  it('sends ready once and stops pending updates', () => {
    vi.useFakeTimers();
    const { sent, progress } = collect(250);
    progress.onPlay({ phase: 'install', state: 'start' });
    progress.request('https://cdn.modrinth.com/x.jar');
    progress.received(10);
    progress.onPlay({ phase: 'connected' });
    progress.onPlay({ phase: 'connected' });
    vi.advanceTimersByTime(1000);
    expect(sent.filter((m) => m.t === 'ready')).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ t: 'ready' });
  });

  it('a warm PC engine is no installation work; a first-run engine and an image build are', () => {
    const { sent, progress } = collect(0);
    progress.onPlay({ phase: 'install', state: 'start' });
    progress.onPcs({ step: 'engine', firstRun: false });
    progress.onPcs({ step: 'done' });
    progress.onPlay({ phase: 'install', state: 'done' });
    progress.waitForPcs(); // nothing to wait for: no phase change
    expect(sent.every((m) => m.t !== 'progress' || (!m.work && m.phase !== 'pcs'))).toBe(true);

    const first = collect(0);
    first.progress.onPlay({ phase: 'install', state: 'start' });
    first.progress.onPcs({ step: 'engine', firstRun: true });
    // The game install keeps the window's text; the PC lane only flags the work.
    expect(first.sent.at(-1)).toMatchObject({
      phase: 'install',
      work: true,
      title: 'Checking the game files',
    });
    first.progress.onPlay({ phase: 'install', state: 'done' });
    first.progress.waitForPcs();
    expect(first.sent.at(-1)).toMatchObject({
      phase: 'pcs',
      work: true,
      title: 'Setting up the Linux PC engine',
      detail: 'Downloading the Linux kernel (first run)…',
    });
    first.progress.onPcs({ step: 'image' });
    expect(first.sent.at(-1)).toMatchObject({
      phase: 'pcs',
      title: 'Building the Linux PC image (first run)',
    });
    first.progress.onPlay({ phase: 'launch' });
    expect(first.sent.at(-1)).toMatchObject({ phase: 'launch', work: true, title: 'Starting Minecraft' });
    first.progress.dispose();
  });

  it('shows the latest build line, cleaned and throttled, while the game waits for the image', () => {
    vi.useFakeTimers();
    const { sent, progress } = collect(250);
    progress.onPlay({ phase: 'install', state: 'start' });
    progress.onPcs({ step: 'image' });
    progress.onPlay({ phase: 'install', state: 'done' });
    progress.waitForPcs();
    const before = sent.length;
    progress.onPcs({ step: 'image', line: '#5 [2/5] RUN apt-get update' });
    progress.onPcs({
      step: 'image',
      line: '\u001b[1m#5 12.3 Get:1 http://ports.ubuntu.com noble InRelease\u001b[0m',
    });
    progress.onPcs({ step: 'image', line: '   ' }); // nothing to show
    expect(sent.length).toBe(before);
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({
      phase: 'pcs',
      title: 'Building the Linux PC image (first run)',
      detail: '#5 12.3 Get:1 http://ports.ubuntu.com noble InRelease',
    });
    progress.onPcs({ step: 'unavailable', reason: 'engine down' });
    progress.onPcs({ step: 'image', line: 'late' }); // the lane is gone: the title falls back, nothing breaks
    progress.dispose();
  });

  it('cleans tool output for the window', () => {
    expect(cleanDetail('\u001b[32mok\u001b[0m\tdone\r\n')).toBe('ok done');
    const long = cleanDetail('x'.repeat(500));
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('sends no progress after ready (a late download must not reopen the window)', () => {
    vi.useFakeTimers();
    const { sent, progress } = collect(250);
    progress.onPlay({ phase: 'install', state: 'start' });
    progress.onPlay({ phase: 'connected' });
    const count = sent.length;
    progress.request('https://cdn.modrinth.com/late.jar');
    progress.received(1024);
    progress.onPlay({ phase: 'launched', pid: 1 });
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(count);
    expect(sent.at(-1)).toEqual({ t: 'ready' });
    progress.dispose();
  });
});
