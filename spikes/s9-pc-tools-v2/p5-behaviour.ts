import { createHash } from 'node:crypto';
import type { ProbeCtx } from './client.js';

const clip = (v: unknown, n = 2500) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
};

type Win = { ref: { id: string; epoch: string }; title: string; focused?: boolean; app?: { pid?: number } };

export default async function (p: ProbeCtx) {
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
  const wins = async () => ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  const term = (await wins()).find((w) => w.title === 'probe-term');
  const thunar = (await wins()).find((w) => w.title.includes('Thunar'));
  p.log('term', term?.ref, 'thunar', thunar?.ref);

  // Activate thunar; tree of thunar (all) to see the shapes, including text values.
  if (thunar) {
    await tryCall('activate thunar', 'WindowsService/ActivateWindow', { window: thunar.ref });
    await p.sleep(500);
    const tree = await tryCall('thunar tree', 'AccessibilityService/GetTree', { window: thunar.ref, maxDepth: 30, maxNodes: 400 }, 9000);
    const nodes = (tree?.nodes ?? []) as { elementId: string; role: string; name?: string; value?: string; states?: string[]; actions?: string[] }[];
    p.log('thunar roles', [...new Set(nodes.map((n) => n.role))]);
    p.log('thunar states', [...new Set(nodes.flatMap((n) => n.states ?? []))]);
    p.log('thunar actions', [...new Set(nodes.flatMap((n) => n.actions ?? []))]);
    // Press a toolbar button "Home"? Find it.
    const f = await tryCall('find thunar location', 'AccessibilityService/Find', { window: thunar.ref, query: { role: 'entry' }, maxResults: 10 });
    const entry = ((f?.nodes ?? []) as { elementId: string }[])[0];
    if (entry && f) {
      await tryCall('set_value entry', 'AccessibilityService/Act', {
        element: { snapshotId: f.snapshotId, elementId: entry.elementId },
        action: 'ACCESSIBILITY_ACTION_SET_VALUE',
        value: '/tmp',
      });
      await tryCall('focus entry', 'AccessibilityService/Act', {
        element: { snapshotId: f.snapshotId, elementId: entry.elementId },
        action: 'ACCESSIBILITY_ACTION_FOCUS',
      });
    }
    // Stale snapshot use
    await tryCall('act stale', 'AccessibilityService/Act', {
      element: { snapshotId: 'ax-000000000000000000000000', elementId: '0' },
      action: 'ACCESSIBILITY_ACTION_PRESS',
    });
  }
  // Terminal: type a command with \n via typeText, then read text from tree
  if (term) {
    await tryCall('activate term', 'WindowsService/ActivateWindow', { window: term.ref });
    await p.sleep(300);
    const t0 = performance.now();
    await p.c.typeText('echo hello-from-type\n');
    p.log('typeText ms', Math.round(performance.now() - t0));
    await p.sleep(500);
    const tt = await tryCall('term tree', 'AccessibilityService/GetTree', { window: term.ref, maxDepth: 30, maxNodes: 400 }, 1200);
    const tnodes = (tt?.nodes ?? []) as { role: string; name?: string; value?: string; description?: string }[];
    p.log('terminal node', tnodes.filter((n) => n.role === 'terminal'));
    // shell check: did Enter run the command?
    const hist = await p.sh('cat ~/.bash_history 2>/dev/null | tail -3; true');
    p.log('history', hist.out);
    // key press with modifiers + repeat
    await tryCall('press shift+a x3', 'ComputerService/Keyboard', {
      press: { key: { character: 'a' }, modifiers: ['KEY_SHIFT'], repeat: 3 },
    });
    await tryCall('press ctrl+u', 'ComputerService/Keyboard', { press: { key: { character: 'u' }, modifiers: ['KEY_CONTROL'] } });
    // Throughput of typeText for 1000 chars (into the terminal line, then ctrl+u to clear)
    const t1 = performance.now();
    await p.c.typeText('x'.repeat(1000));
    p.log('typeText 1000 ms', Math.round(performance.now() - t1));
    await tryCall('press ctrl+u', 'ComputerService/Keyboard', { press: { key: { character: 'u' }, modifiers: ['KEY_CONTROL'] } });
    // INSERT mode
    const t2 = performance.now();
    await tryCall('type insert', 'ComputerService/Keyboard', { type: { text: 'y'.repeat(1000), mode: 'TEXT_ENTRY_MODE_INSERT' } });
    p.log('type INSERT 1000 ms', Math.round(performance.now() - t2));
    await tryCall('press ctrl+u', 'ComputerService/Keyboard', { press: { key: { character: 'u' }, modifiers: ['KEY_CONTROL'] } });
  }
  // Pointer shapes
  await tryCall('move', 'ComputerService/Pointer', { move: { position: { x: 700, y: 500 } } });
  await tryCall('down no pos', 'ComputerService/Pointer', { down: { button: 'MOUSE_BUTTON_LEFT' } });
  await tryCall('up no pos', 'ComputerService/Pointer', { up: { button: 'MOUSE_BUTTON_LEFT' } });
  await tryCall('click count 3', 'ComputerService/Pointer', { click: { position: { x: 700, y: 500 }, button: 'MOUSE_BUTTON_LEFT', count: 3 } });
  await tryCall('click no pos', 'ComputerService/Pointer', { click: { button: 'MOUSE_BUTTON_LEFT' } });
  await tryCall('click mods', 'ComputerService/Pointer', { click: { position: { x: 700, y: 500 }, modifiers: ['KEY_CONTROL'] } });
  await tryCall('scroll line', 'ComputerService/Pointer', { scroll: { position: { x: 700, y: 500 }, deltaY: 3, unit: 'SCROLL_UNIT_LINE' } });
  await tryCall('scroll default', 'ComputerService/Pointer', { scroll: { position: { x: 700, y: 500 }, deltaY: -3 } });
  await tryCall('cursor', 'ComputerService/GetCursorPosition', {});
  // Hash stability at 320 px with the blinking caret (the terminal has focus)
  const hashes: string[] = [];
  for (let i = 0; i < 20; i++) {
    const s = await p.c.screenshot({ format: p.jpeg, quality: 60, maxDimension: 320, includeCursor: false });
    hashes.push(createHash('sha1').update(Buffer.from(s.image)).digest('hex').slice(0, 8));
    await p.sleep(120);
  }
  p.log('hashes (2.4 s, 120 ms)', hashes.join(' '));
  const t3 = performance.now();
  for (let i = 0; i < 5; i++) await p.c.screenshot({ format: p.jpeg, quality: 60, maxDimension: 320, includeCursor: false });
  p.log('320 shot ms avg', Math.round((performance.now() - t3) / 5));
  // Launch and open
  const before = (await wins()).map((w) => w.ref.id);
  const launched = await tryCall('LaunchApp firefox', 'WindowsService/LaunchApp', { app: { executable: 'firefox' }, waitForWindow: true }, 2000);
  p.log('launched', launched);
  await p.sleep(1000);
  const after = await wins();
  p.log('new windows', after.filter((w) => !before.includes(w.ref.id)).map((w) => ({ title: w.title, ref: w.ref, focused: w.focused })));
  await tryCall('Open path', 'WindowsService/Open', { path: `${p.vault}/notes.md` }, 2000);
  await p.sleep(3000);
  p.log('windows now', (await wins()).map((w) => ({ title: w.title, focused: w.focused, pid: w.app?.pid })));
}
