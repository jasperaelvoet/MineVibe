import type { ProbeCtx } from './client.js';

const clip = (v: unknown, n = 2500) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
};

export default async function (p: ProbeCtx) {
  const tryCall = async (label: string, m: string, req: unknown, n = 1500) => {
    try {
      const r = await p.call(m, req);
      p.log(label, 'OK', clip(r, n));
      return r;
    } catch (e) {
      p.log(label, 'ERR', String(e).slice(0, 500));
      return null;
    }
  };
  // Modifier and key shapes
  await tryCall('press mods zz', 'ComputerService/Keyboard', { press: { key: { character: 'a' }, modifiers: ['zz'] } });
  await tryCall('press key zz', 'ComputerService/Keyboard', { press: { key: { zz: 1 } } });
  await tryCall('click mods zz', 'ComputerService/Pointer', { click: { position: { x: 10, y: 10 }, modifiers: ['zz'] } });
  await tryCall('scroll unit zz', 'ComputerService/Pointer', { scroll: { position: { x: 10, y: 10 }, deltaY: 1, unit: 'zz' } });
  await tryCall('type mode zz', 'ComputerService/Keyboard', { type: { text: 'x', mode: 'zz' } });
  await tryCall('Act action zz', 'AccessibilityService/Act', { element: { snapshotId: 'x', elementId: '0' }, action: 'zz' });
  await tryCall('Act delivery zz', 'AccessibilityService/Act', { element: { snapshotId: 'x', elementId: '0' }, action: 'ACCESSIBILITY_ACTION_PRESS', delivery: 'zz' });
  await tryCall('ListWindows filter zz', 'WindowsService/ListWindows', { filter: { zz: 1 } });
  await tryCall('LaunchApp app zz', 'WindowsService/LaunchApp', { app: { zz: 1 } });
  await tryCall('Screenshot window zz', 'ComputerService/Screenshot', { window: { zz: 1 } });
  await tryCall('Pointer target zz', 'ComputerService/Pointer', { target: { zz: 1 } });
  await tryCall('drag path zz', 'ComputerService/Pointer', { drag: { from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, path: [{ zz: 1 }] } });
  await tryCall('cursor', 'ComputerService/GetCursorPosition', {});
  await tryCall('drivers', 'DriverService/ListTools', {}, 4000);
  // Screenshot via callJson with a region
  const shot = (await tryCall('Screenshot region', 'ComputerService/Screenshot', {
    region: { x: 0, y: 0, width: 320, height: 200 },
    format: 'IMAGE_FORMAT_JPEG',
    quality: 80,
  }, 300)) as Record<string, unknown> | null;
  if (shot) p.log('shot keys', Object.keys(shot), 'w', shot.width, 'h', shot.height);
  const shot2 = (await tryCall('Screenshot region maxDim', 'ComputerService/Screenshot', {
    region: { x: 100, y: 100, width: 200, height: 100 },
    format: 'IMAGE_FORMAT_JPEG',
    maxDimension: 800,
  }, 300)) as Record<string, unknown> | null;
  if (shot2) p.log('shot2 keys', Object.keys(shot2), 'w', shot2.width, 'h', shot2.height, 'other', clip({ ...shot2, image: undefined, data: undefined }, 500));
}
