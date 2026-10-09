import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProbeCtx } from './client.js';

const clip = (v: unknown, n = 2500) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
};

type Win = { ref: { id: string; epoch: string }; title: string; focused?: boolean; app?: { pid?: number; name?: string } };
type Node = { elementId: string; role: string; nativeRole?: string; name?: string; value?: string; bounds?: unknown };

export default async function (p: ProbeCtx) {
  const out = process.argv[2] as string;
  const tryCall = async (label: string, m: string, req: unknown, n = 1500) => {
    try {
      const t0 = performance.now();
      const r = await p.call(m, req);
      p.log(label, `OK ${Math.round(performance.now() - t0)}ms`, clip(r, n));
      return r as Record<string, unknown>;
    } catch (e) {
      p.log(label, 'ERR', String(e).slice(0, 500));
      return null;
    }
  };
  const shot = async (name: string) => {
    const s = await p.c.screenshot({ format: p.png, quality: 90, maxDimension: 1280, includeCursor: true });
    writeFileSync(join(out, `${name}.png`), Buffer.from(s.image));
  };
  const wins = async () => ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  await shot('a-before');
  const all = await wins();
  p.log('windows', all.map((w) => `${w.title}${w.focused ? ' (focused)' : ''} pid=${w.app?.pid}`));
  const thunar = all.find((w) => w.title.includes('Thunar'));
  // Find without window while the terminal is focused
  await tryCall('find Home (no window)', 'AccessibilityService/Find', { query: { nameContains: 'Home' }, maxResults: 10 });
  await tryCall('find role text_field (no window)', 'AccessibilityService/Find', { query: { role: 'text_field' } });
  if (thunar) {
    const f = await tryCall('find text_field thunar', 'AccessibilityService/Find', { window: thunar.ref, query: { role: 'text_field' } });
    const e = ((f?.nodes ?? []) as Node[])[0];
    if (f && e) {
      await tryCall('SET_VALUE /tmp', 'AccessibilityService/Act', {
        element: { snapshotId: f.snapshotId, elementId: e.elementId },
        action: 'ACCESSIBILITY_ACTION_SET_VALUE',
        value: '/tmp/',
      });
      await p.sleep(500);
      await shot('b-setvalue');
      const again = await tryCall('reuse snapshot after SET_VALUE (FOCUS)', 'AccessibilityService/Act', {
        element: { snapshotId: f.snapshotId, elementId: e.elementId },
        action: 'ACCESSIBILITY_ACTION_FOCUS',
      });
      p.log('reuse ok', again !== null);
    }
    const fh = await tryCall('find Home thunar', 'AccessibilityService/Find', { window: thunar.ref, query: { name: 'Home', role: 'button' } });
    const h = ((fh?.nodes ?? []) as Node[])[0];
    if (fh && h) {
      await tryCall('PRESS Home', 'AccessibilityService/Act', {
        element: { snapshotId: fh.snapshotId, elementId: h.elementId },
        action: 'ACCESSIBILITY_ACTION_PRESS',
      });
      await p.sleep(600);
      const tf = await tryCall('text_field after Home', 'AccessibilityService/Find', { window: thunar.ref, query: { role: 'text_field' } });
      p.log('location now', ((tf?.nodes ?? []) as Node[]).map((n) => n.value));
      await shot('c-home');
    }
    await tryCall('GetWindow thunar', 'WindowsService/GetWindow', { window: thunar.ref });
    await tryCall('GetWindow stale epoch', 'WindowsService/GetWindow', { window: { id: thunar.ref.id, epoch: '999' } });
    await tryCall('GetWindow bad id', 'WindowsService/GetWindow', { window: { id: 'target-nope', epoch: '1' } });
  }
  const before = new Set((await wins()).map((w) => w.ref.id));
  const t0 = performance.now();
  const launched = await tryCall('LaunchApp xfce4-terminal', 'WindowsService/LaunchApp', {
    app: { executable: 'xfce4-terminal' },
    args: ['--title=launched-term'],
    waitForWindow: '8s',
  });
  p.log('launch ms', Math.round(performance.now() - t0), launched);
  await p.sleep(500);
  p.log('new windows', (await wins()).filter((w) => !before.has(w.ref.id)).map((w) => `${w.title} pid=${w.app?.pid}`));
  await tryCall('LaunchApp by name', 'WindowsService/LaunchApp', { app: { name: 'Thunar' }, waitForWindow: '5s' });
  await tryCall('LaunchApp appId', 'WindowsService/LaunchApp', { app: { appId: 'xfce4-terminal' }, waitForWindow: '5s' });
  await tryCall('LaunchApp nope', 'WindowsService/LaunchApp', { app: { executable: 'nope-app' }, waitForWindow: '2s' });
  await tryCall('Open url', 'WindowsService/Open', { url: 'https://example.com' });
  await p.sleep(8000);
  p.log('windows after url', (await wins()).map((w) => `${w.title}${w.focused ? ' (focused)' : ''} pid=${w.app?.pid} app=${w.app?.name}`));
  await shot('d-after-url');
  const ff = (await wins()).find((w) => /chrom|firefox/i.test(`${w.title} ${w.app?.name}`));
  if (ff) {
    const t = await tryCall('browser tree', 'AccessibilityService/GetTree', { window: ff.ref, maxDepth: 40, maxNodes: 300 }, 4000);
    const ns = (t?.nodes ?? []) as Node[];
    p.log('browser roles', [...new Set(ns.map((n) => n.role))], 'count', ns.length);
    p.log('browser named', ns.filter((n) => n.name || n.value).slice(0, 60).map((n) => `${n.role}:${n.name ?? ''}=${n.value ?? ''}`));
  }
}
