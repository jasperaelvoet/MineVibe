import type { ProbeCtx } from './client.js';

type Win = { ref: { id: string; epoch: string }; title: string; focused?: boolean };

/** Does a window handle without its epoch work? And what does Find with role + nameContains do? */
export default async function (p: ProbeCtx) {
  const wins = ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  const w = wins.find((x) => x.title.includes('Thunar')) ?? wins[0];
  if (!w) return 'no windows';
  const out: Record<string, unknown> = {};
  for (const [label, m, req] of [
    ['GetWindow no epoch', 'WindowsService/GetWindow', { window: { id: w.ref.id } }],
    ['GetTree no epoch', 'AccessibilityService/GetTree', { window: { id: w.ref.id }, maxNodes: 5 }],
    ['Find no epoch', 'AccessibilityService/Find', { window: { id: w.ref.id }, query: { nameContains: 'home' } }],
    ['Find role button', 'AccessibilityService/Find', { window: { id: w.ref.id }, query: { role: 'button' }, maxResults: 3 }],
    ['Find role push button', 'AccessibilityService/Find', { window: { id: w.ref.id }, query: { role: 'push button' }, maxResults: 3 }],
    ['Find valueContains', 'AccessibilityService/Find', { window: { id: w.ref.id }, query: { valueContains: 'cua' }, maxResults: 3 }],
    ['ListWindows onScreenOnly', 'WindowsService/ListWindows', { filter: { onScreenOnly: true } }],
  ] as const) {
    try {
      const r = await p.call(m, req);
      out[label] = JSON.stringify(r).slice(0, 700);
    } catch (e) {
      out[label] = `ERR ${String(e).slice(0, 300)}`;
    }
  }
  return out;
}
