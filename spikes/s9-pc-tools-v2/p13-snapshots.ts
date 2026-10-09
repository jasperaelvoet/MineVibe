import type { ProbeCtx } from './client.js';

type Win = { ref: { id: string }; title: string };
type Node = { elementId: string; role: string; name?: string };

/** How long does an accessibility snapshot stay usable: per window, per client, or only the latest one? */
export default async function (p: ProbeCtx) {
  await p.sh('setsid -f thunar /home/cua >/dev/null 2>&1; setsid -f xfce4-terminal --disable-server --title=snap-term >/dev/null 2>&1; true');
  await p.sleep(2500);
  const wins = ((await p.call('WindowsService/ListWindows', {})) as { windows: Win[] }).windows;
  const thunar = wins.find((w) => w.title.includes('Thunar'));
  const term = wins.find((w) => w.title.includes('snap-term'));
  if (!thunar || !term) return { wins: wins.map((w) => w.title) };
  const find = async (win: Win, name: string) =>
    (await p.call('AccessibilityService/Find', { window: { id: win.ref.id }, query: { nameContains: name } })) as {
      snapshotId: string;
      nodes?: Node[];
    };
  const focus = async (snap: string, el: string) => {
    try {
      await p.call('AccessibilityService/Act', {
        element: { snapshotId: snap, elementId: el },
        action: 'ACCESSIBILITY_ACTION_FOCUS',
      });
      return 'ok';
    } catch (e) {
      return String(e).slice(0, 120);
    }
  };
  const a = await find(thunar, 'Home');
  const aEl = a.nodes?.[0]?.elementId ?? '0';
  const results: Record<string, string> = {};
  results['A right away'] = await focus(a.snapshotId, aEl);
  const b = await find(thunar, 'Reload');
  results['A after a newer snapshot of the same window'] = await focus(a.snapshotId, aEl);
  results['B (the newer one)'] = await focus(b.snapshotId, b.nodes?.[0]?.elementId ?? '0');
  const c = await find(thunar, 'Home');
  await find(term, 'File');
  results['C after a snapshot of another window'] = await focus(c.snapshotId, c.nodes?.[0]?.elementId ?? '0');
  const d = await find(thunar, 'Home');
  await p.sleep(5_000);
  results['D after 5 s'] = await focus(d.snapshotId, d.nodes?.[0]?.elementId ?? '0');
  await p.sleep(25_000);
  results['D after 30 s'] = await focus(d.snapshotId, d.nodes?.[0]?.elementId ?? '0');
  return results;
}
