import type { ProbeCtx } from './client.js';

type Win = { ref: { id: string; epoch: string }; title: string; focused?: boolean; app?: { name?: string } };
type Node = { elementId: string; role: string; name?: string; bounds?: { x?: number; y?: number; width: number; height: number } };

export default async function (p: ProbeCtx) {
  const wins = async () => ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  await p.call('WindowsService/Open', { path: '/tmp/long.html' });
  await p.sleep(3000);
  let ch = (await wins()).find((w) => /chromium/i.test(w.title));
  if (ch) {
    for (let i = 0; i < 3; i++) {
      const t = (await p.call('AccessibilityService/GetTree', { window: ch.ref, maxDepth: 40, maxNodes: 300 })) as { nodes?: Node[]; degraded?: unknown };
      p.log(`chromium tree try ${i}`, (t.nodes ?? []).length, JSON.stringify({ ...t, nodes: undefined }).slice(0, 400), (t.nodes ?? []).slice(0, 8).map((n) => `${n.role}:${n.name ?? ''}`));
      await p.sleep(1500);
    }
    await p.call('WindowsService/CloseWindow', { window: ch.ref });
  }
  await p.sh('setsid -f firefox file:///tmp/long.html >/dev/null 2>&1; true');
  await p.sleep(4000);
  const ff = (await wins()).find((w) => /long\.html|line 0/i.test(w.title) || (/firefox/i.test(w.title) && w.focused));
  p.log('ff', ff?.title, (await wins()).map((w) => w.title));
  if (!ff) return;
  await p.call('WindowsService/ActivateWindow', { window: ff.ref });
  const yOf = async (name: string) => {
    const r = (await p.call('AccessibilityService/Find', { window: ff.ref, query: { name }, maxResults: 3 })) as { nodes?: Node[] };
    return r.nodes?.[0]?.bounds?.y ?? null;
  };
  p.log('line 0 y before', await yOf('line 0'));
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: 5, unit: 'SCROLL_UNIT_LINE' } });
  await p.sleep(800);
  p.log('line 0 y after deltaY +5 LINE', await yOf('line 0'));
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: -5, unit: 'SCROLL_UNIT_LINE' } });
  await p.sleep(800);
  p.log('line 0 y after deltaY -5 LINE', await yOf('line 0'));
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: 5 } });
  await p.sleep(800);
  p.log('line 0 y after deltaY +5 (no unit)', await yOf('line 0'));
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: -5 } });
  await p.sleep(800);
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: 200, unit: 'SCROLL_UNIT_PIXEL' } });
  await p.sleep(800);
  p.log('line 0 y after +200 PIXEL', await yOf('line 0'));
  await p.call('ComputerService/Keyboard', { press: { key: { named: 'KEY_HOME' } } });
  await p.sleep(500);
  p.log('after Home', await yOf('line 0'));
  await p.call('ComputerService/Keyboard', { press: { key: { named: 'KEY_PAGE_DOWN' }, repeat: 2 } });
  await p.sleep(800);
  p.log('after PageDown x2', await yOf('line 0'));
  // which paragraphs are visible
  const t = (await p.call('AccessibilityService/GetTree', { window: ff.ref, maxDepth: 40, maxNodes: 600 })) as { nodes?: (Node & { description?: string })[] };
  const vis = (t.nodes ?? []).filter((n) => n.role === 'paragraph');
  p.log('paragraphs', vis.length, vis.slice(0, 3).map((n) => `${n.name} ${JSON.stringify(n.bounds)} ${n.description ?? ''}`), vis.slice(-2).map((n) => `${n.name} ${JSON.stringify(n.bounds)} ${n.description ?? ''}`));
  await p.call('WindowsService/CloseWindow', { window: ff.ref });
}
