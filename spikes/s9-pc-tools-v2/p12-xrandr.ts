import type { ProbeCtx } from './client.js';

/** Can the guest display be resized (to test scaled screenshot coordinates on a real PC)? */
export default async function (p: ProbeCtx) {
  const q = await p.sh('xrandr 2>&1 | head -5');
  p.log('xrandr', q.out);
  const r = await p.sh('xrandr --fb 1920x1200 2>&1; xrandr 2>&1 | head -2');
  p.log('resize', r.out, r.err);
  p.log('displays', await p.c.displays());
  const s = await p.c.screenshot({ format: p.jpeg, quality: 50, maxDimension: 4000, includeCursor: false });
  p.log('shot', s.width, s.height);
  await p.call('ComputerService/Pointer', { move: { position: { x: 1800, y: 1100 } } });
  p.log('cursor', await p.call('ComputerService/GetCursorPosition', {}));
  const back = await p.sh('xrandr --fb 1280x800 2>&1; xrandr 2>&1 | head -1');
  p.log('back', back.out);
  p.log('displays', await p.c.displays());
}
