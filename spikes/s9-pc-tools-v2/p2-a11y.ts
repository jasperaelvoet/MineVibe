import type { ProbeCtx } from './client.js';

const clip = (v: unknown, n = 6000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
};

/** P0 item 2-3: the accessibility service shapes. */
export default async function (p: ProbeCtx) {
  const gi = await p.sh('python3 -c "import gi; gi.require_version(\'Gtk\',\'3.0\'); from gi.repository import Gtk; print(\'gtk ok\')" 2>&1');
  p.log('python gi', gi.out);
  await p.sh('setsid -f xfce4-terminal --title=probe-term >/dev/null 2>&1; setsid -f thunar /home/cua >/dev/null 2>&1; true');
  await p.sleep(3000);
  p.log('windows', clip(await p.call('WindowsService/ListWindows', {}), 3000));
  const tries: [string, unknown][] = [
    ['GetTree {}', {}],
    ['GetTree depth', { maxDepth: 4, maxNodes: 200 }],
  ];
  for (const [label, req] of tries) {
    try {
      p.log(label, clip(await p.call('AccessibilityService/GetTree', req)));
    } catch (e) {
      p.log(label, 'ERR', String(e));
    }
  }
  for (const req of [
    { query: { nameContains: 'File' }, maxResults: 20 },
    { nameContains: 'File', maxResults: 20 },
    { query: { name_contains: 'File' } },
  ]) {
    try {
      p.log('Find', JSON.stringify(req), clip(await p.call('AccessibilityService/Find', req), 4000));
    } catch (e) {
      p.log('Find', JSON.stringify(req), 'ERR', String(e));
    }
  }
}
