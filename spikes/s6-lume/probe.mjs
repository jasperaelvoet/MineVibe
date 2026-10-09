// Spike S6 probes against a running macOS VM's spacesd (token from its setup share; never printed).
//   node probe.mjs <name> auth|caps|shots|sh <cmd>|sudo <cmd>|input|media|loopback
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, port, sleep } from './lib.mjs';
import { connect, ImageFormat, withTimeout } from './spacesd.mjs';

const [name, what, ...rest] = process.argv.slice(2);
const ip = readFileSync(join('out', `${name}.ip`), 'utf8').trim();
const token = readFileSync(
  join(process.env.HOME, 'Library/Application Support/MineVibe-dev/lume/shares', name, 'setup', 'env-token'),
  'utf8',
).trim();
const url = `http://${ip}:3211`;
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];

async function sh(c, script, { user, timeoutMs = 60_000, env = {} } = {}) {
  const t0 = performance.now();
  const out = await c.run(
    {
      program: 'bash',
      args: ['-c', script],
      env: new Map(Object.entries(env)),
      ...(user !== undefined ? { user } : {}),
      stdin: false,
      timeoutMs,
    },
  );
  return {
    code: out.exit.code,
    error: out.exit.error,
    ms: Math.round(performance.now() - t0),
    stdout: Buffer.from(out.stdout).toString('utf8'),
    stderr: Buffer.from(out.stderr).toString('utf8'),
  };
}

const c = what === 'auth' ? null : await connect(url, token);
switch (what) {
  case 'auth': {
    for (const [label, tok] of [
      ['ours', token],
      ['wrong', 'x'.repeat(48)],
      ['none', undefined],
    ]) {
      try {
        const cl = await connect(url, tok, 8000);
        const h = JSON.parse(await withTimeout(cl.health(), 8000, 'health'));
        // Health may answer without auth; a real call shows whether the token is accepted.
        let call = 'ok';
        try {
          await withTimeout(cl.displays(), 8000, 'displays');
        } catch (e) {
          call = String(e?.message ?? e).slice(0, 160);
        }
        log(label, 'health', h.status, '| displays:', call);
      } catch (e) {
        log(label, 'connect/health failed:', String(e?.message ?? e).slice(0, 200));
      }
    }
    break;
  }
  case 'caps': {
    const caps = await c.capabilities();
    const feats = (caps.features ?? []).filter((f) => f.supported).map((f) => f.name);
    log('os', caps.osName, caps.osVersion, '| transport', c.transport?.());
    log('features', feats.join(' '));
    log('displays', await c.displays());
    break;
  }
  case 'shots': {
    const lat = [];
    let shot;
    for (let i = 0; i < 21; i++) {
      const t = performance.now();
      shot = await c.screenshot({ format: ImageFormat.Jpeg, quality: 80, maxDimension: 1280, includeCursor: false });
      if (i > 0) lat.push(performance.now() - t);
    }
    writeFileSync(join('out', `${name}-shot.jpg`), Buffer.from(shot.image));
    log(`jpeg ${shot.width}x${shot.height} p50 ${pct(lat, 50).toFixed(1)} ms p95 ${pct(lat, 95).toFixed(1)} ms ${shot.image.byteLength} B`);
    const lat640 = [];
    for (let i = 0; i < 11; i++) {
      const t = performance.now();
      shot = await c.screenshot({ format: ImageFormat.Jpeg, quality: 80, maxDimension: 640, includeCursor: false });
      if (i > 0) lat640.push(performance.now() - t);
    }
    log(`jpeg ${shot.width}x${shot.height} p50 ${pct(lat640, 50).toFixed(1)} ms`);
    break;
  }
  case 'sh':
  case 'sudo': {
    const user = process.env.AS_USER === '-' ? undefined : (process.env.AS_USER ?? 'lume');
    // The image's default password (lume) on stdin; the script travels base64-encoded so nothing expands early.
    const b64 = Buffer.from(rest.join(' ')).toString('base64');
    const script =
      what === 'sudo'
        ? `f=$(mktemp); echo ${b64} | base64 -d > "$f"; sudo -S -p '' bash "$f" <<< lume; ec=$?; rm -f "$f"; exit $ec`
        : rest.join(' ');
    const r = await sh(c, script, { user });
    log(`exit ${r.code}${r.error ? ` (${r.error})` : ''} in ${r.ms} ms`);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stdout.write(`[stderr] ${r.stderr}`);
    break;
  }
  case 'input': {
    // Opens Terminal, types a command with the keyboard, presses Return and checks its effect from the shell.
    const marker = `/tmp/s6-input-${Date.now()}.txt`;
    await sh(c, 'open -a Terminal', { user: 'lume' });
    await sleep(4000);
    const before = createHash('sha1').update(Buffer.from((await c.screenshot({ format: ImageFormat.Jpeg, quality: 60, maxDimension: 640, includeCursor: false })).image)).digest('hex');
    const t0 = performance.now();
    await c.typeText(`echo s6-input-ok > ${marker}`);
    await c.press('KEY_ENTER');
    log(`typed + Enter in ${Math.round(performance.now() - t0)} ms`);
    await sleep(1500);
    const after = createHash('sha1').update(Buffer.from((await c.screenshot({ format: ImageFormat.Jpeg, quality: 60, maxDimension: 640, includeCursor: false })).image)).digest('hex');
    const r = await sh(c, `cat ${marker} 2>&1; rm -f ${marker}`, { user: 'lume' });
    log('screen changed:', before !== after, '| file:', r.stdout.trim());
    // Cmd+Q via the hotkey path (Cmd as cmd): Terminal quits.
    await c.hotkey(['KEY_META', 'q']).catch((e) => log('hotkey failed', String(e)));
    await sleep(1500);
    const q = await sh(c, 'pgrep -x Terminal || echo gone', { user: 'lume' });
    log('after cmd+q, Terminal:', q.stdout.trim());
    break;
  }
  case 'media': {
    let frames = 0;
    let bytes = 0;
    let session;
    const sink = {
      onFrame(f) {
        frames++;
        bytes += f.data.byteLength;
        session?.sendControl(JSON.stringify({ type: 'frame_ack', payload: { session_id: session.sessionId(), sequence: Number(f.sequence), decode_queue: 0 } }));
        if (frames === 1) log(`first frame ${f.codec} ${f.width}x${f.height} ${f.data.byteLength} B`);
      },
      onEvent() {},
    };
    const t0 = performance.now();
    try {
      session = await withTimeout(
        c.openMedia({ maxFps: 30, maxDimension: 0, audio: false, disableVideo: false, requestJson: '{"codecs":["MEDIA_CODEC_BGRA"]}' }, sink),
        15_000,
        'openMedia',
      );
    } catch (e) {
      log('openMedia failed', String(e?.message ?? e));
      break;
    }
    log(`openMedia ${Math.round(performance.now() - t0)} ms codec ${session.codec()}`);
    // Damage: a moving pointer is not enough on Linux; on macOS the cursor is composited by WindowServer.
    const start = frames;
    const s = performance.now();
    await sh(c, 'open -a Terminal', { user: 'lume' });
    for (let i = 0; i < 50; i++) {
      await c.typeText('x').catch(() => {});
      await sleep(40);
    }
    const dur = (performance.now() - s) / 1000;
    log(`frames while typing: ${frames - start} in ${dur.toFixed(1)} s = ${((frames - start) / dur).toFixed(1)} fps, ${(bytes / 1e6).toFixed(1)} MB total`);
    await c.hotkey(['KEY_META', 'q']).catch(() => {});
    session.close?.();
    break;
  }
  case 'loopback': {
    const gw = ip.replace(/\.\d+$/, '.1');
    const p = port();
    const r = await sh(
      c,
      `for t in ${gw}:${p} ${gw}:22 127.0.0.1:${p}; do h=\${t%:*}; q=\${t##*:}; if nc -z -G 3 -w 3 $h $q 2>/dev/null; then echo "$t open"; else echo "$t closed"; fi; done; curl -s -m 3 -o /dev/null -w '%{http_code}\\n' http://${gw}:${p}/lume/vms || echo curl-failed`,
      { user: 'lume' },
    );
    log(`guest -> host lume serve (gateway ${gw}, port ${p}):`);
    process.stdout.write(r.stdout);
    break;
  }
  default:
    console.error('usage: node probe.mjs <name> auth|caps|shots|sh|sudo|input|media|loopback');
    process.exit(2);
}
process.exit(0);
