import type { ProbeCtx } from './client.js';

/** Is ImageMagick in the guest (zoom upscaling), and how fast is a region capture + resize? */
export default async function (p: ProbeCtx) {
  const which = await p.sh('command -v import convert magick xwd ffmpeg python3; python3 -c "import PIL; print(\'PIL\', PIL.__version__)" 2>&1; true');
  p.log('which', which.out);
  const t0 = performance.now();
  const r = await p.c.run({
    program: 'bash',
    args: ['-lc', 'import -silent -window root -crop 200x100+100+100 +repage -filter Lanczos -resize 1280x800 jpg:- | wc -c'],
    env: new Map([['DISPLAY', ':1'], ['HOME', '/home/cua']]),
    stdin: false,
    user: 'cua',
    timeoutMs: 20_000,
  });
  p.log('import+resize', Math.round(performance.now() - t0), 'ms', Buffer.from(r.stdout).toString().trim(), Buffer.from(r.stderr).toString().slice(0, 300));
}
