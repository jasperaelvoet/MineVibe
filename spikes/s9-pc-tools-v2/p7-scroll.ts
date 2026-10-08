import type { ProbeCtx } from './client.js';

type Win = { ref: { id: string; epoch: string }; title: string; focused?: boolean };
type Node = { elementId: string; role: string; name?: string; bounds?: { x?: number; y?: number; width: number; height: number } };

export default async function (p: ProbeCtx) {
  const wins = async () => ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  const html = `<html><body>${Array.from({ length: 200 }, (_, i) => `<p>line ${i}</p>`).join('')}</body></html>`;
  await p.sh(`printf '%s' '${html}' > /tmp/long.html`);
  await p.call('WindowsService/Open', { url: 'file:///tmp/long.html' });
  await p.sleep(3000);
  const ff = (await wins()).find((w) => w.title.includes('long.html') || w.title.includes('Mozilla'));
  p.log('ff', ff?.title);
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
  await p.call('ComputerService/Pointer', { scroll: { position: { x: 640, y: 400 }, deltaY: 200, unit: 'SCROLL_UNIT_PIXEL' } });
  await p.sleep(800);
  p.log('line 0 y after +200 PIXEL', await yOf('line 0'));
  // keys: page down via named key
  await p.call('ComputerService/Keyboard', { press: { key: { named: 'KEY_HOME' } } });
  await p.sleep(500);
  p.log('after Home', await yOf('line 0'));
  await p.call('ComputerService/Keyboard', { press: { key: { named: 'KEY_PAGE_DOWN' }, repeat: 2 } });
  await p.sleep(800);
  p.log('after PageDown x2', await yOf('line 0'));
  // Driver fallback
  try {
    const r = await p.call('DriverService/CallTool', { name: 'get_window_state', argumentsJson: JSON.stringify({}) });
    p.log('driver get_window_state', JSON.stringify(r).slice(0, 1500));
  } catch (e) {
    p.log('driver ERR', String(e).slice(0, 400));
  }
  // Close the browser window
  const r = await p.call('WindowsService/CloseWindow', { window: ff.ref });
  p.log('close', r);
}
