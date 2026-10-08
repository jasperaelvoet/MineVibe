import type { ProbeCtx } from './client.js';

/** The full cua KEY_* enum and the MOUSE_BUTTON_* enum, from serde's "unknown variant" errors. */
export default async function (p: ProbeCtx) {
  const variants = async (m: string, req: unknown) => {
    try {
      await p.call(m, req);
      return 'accepted';
    } catch (e) {
      const s = String(e);
      const m2 = /expected one of (.*?) at line/.exec(s);
      return m2 ? (m2[1] as string).replace(/`/g, '').split(', ') : s;
    }
  };
  const keys = await variants('ComputerService/Keyboard', { press: { key: { named: 'zz' } } });
  const buttons = await variants('ComputerService/Pointer', { click: { button: 'zz' } });
  const states = await variants('AccessibilityService/Find', { query: { states: ['zz'] } });
  const winState = await variants('WindowsService/ListWindows', { filter: { zz: 1 } });
  return { keys, buttons, states, winState };
}
