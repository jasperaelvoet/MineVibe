// S5 step 6a/6b: unary JPEG screenshot latency and openMedia (BGRA / default) frame delivery.
import "./env.mjs";
import { ImageFormat } from "@trycua/cua";
import { connectPc, save, pct, sleep, withTimeout } from "./lib.mjs";

const mediaOnly = process.argv.includes("--media-only");

const pc = await connectPc();
const out = { transport: pc.transport() };
let session;

async function shots(label, opts, n = 50) {
  const lat = [];
  const bytes = [];
  let w = 0;
  let h = 0;
  // one warm-up
  await pc.screenshot(opts);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    const shot = await withTimeout(pc.screenshot(opts), 10_000, "screenshot");
    lat.push(performance.now() - s);
    bytes.push(shot.image.byteLength);
    w = shot.width;
    h = shot.height;
  }
  const total = performance.now() - t0;
  const r = {
    label,
    n,
    size: `${w}x${h}`,
    p50ms: +pct(lat, 50).toFixed(1),
    p95ms: +pct(lat, 95).toFixed(1),
    maxms: +Math.max(...lat).toFixed(1),
    fps: +((n * 1000) / total).toFixed(1),
    avgBytes: Math.round(bytes.reduce((a, b) => a + b, 0) / n),
  };
  console.log(JSON.stringify(r));
  return r;
}

// Move the mouse in a background loop to generate X damage during some measurements.
let jiggle = false;
async function jiggler() {
  let i = 0;
  while (jiggle) {
    i++;
    await pc.moveTo(200 + ((i * 37) % 800), 200 + ((i * 23) % 400)).catch(() => {});
    await sleep(16);
  }
}

out.screenshots = [];
const J = ImageFormat.Jpeg;
if (!mediaOnly) {
out.screenshots.push(await shots("jpeg 1280 q75", { format: J, quality: 75, maxDimension: 1280, includeCursor: false }));
out.screenshots.push(await shots("jpeg 960 q75", { format: J, quality: 75, maxDimension: 960, includeCursor: false }));
out.screenshots.push(await shots("jpeg 640 q75", { format: J, quality: 75, maxDimension: 640, includeCursor: false }));
out.screenshots.push(await shots("png native", { format: ImageFormat.Png, includeCursor: false }, 20));
jiggle = true;
const jp = jiggler();
out.screenshots.push(await shots("jpeg 1280 q75 + mouse moving", { format: J, quality: 75, maxDimension: 1280, includeCursor: true }));
jiggle = false;
await jp;

// Concurrency: 4 parallel screenshot loops at 640 (how many PCs/tiers one client can feed).
{
  const n = 25;
  const t0 = performance.now();
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      for (let i = 0; i < n; i++) await pc.screenshot({ format: J, quality: 75, maxDimension: 640, includeCursor: false });
    }),
  );
  const total = performance.now() - t0;
  out.parallel640 = { loops: 4, each: n, aggregateFps: +((4 * n * 1000) / total).toFixed(1) };
  console.log("parallel640", JSON.stringify(out.parallel640));
}
}

// Real damage: an xfce4-terminal printing continuously (cursor moves alone produce no frame).
async function startDamage() {
  return pc.spawn({
    program: "xfce4-terminal",
    args: ["--geometry=100x30+80+80", "-x", "sh", "-c", "while true; do date +%s.%N; done"],
    env: new Map([["DISPLAY", ":1"]]),
    user: "cua",
    stdin: false,
    tag: "s5-damage",
  });
}

async function media(label, requestJson, { seconds = 5, maxFps = 30, maxDimension = 0, ack = true } = {}) {
  const frames = [];
  const events = [];
  let session;
  const pendingAcks = [];
  const sendAck = (seq) => {
    // Viewer protocol (rcdp v2, capability frame_ack.v1): one ack per decoded frame.
    session.sendControl(JSON.stringify({ type: "frame_ack", payload: { session_id: session.sessionId(), sequence: seq, decode_queue: 0 } }));
  };
  const sink = {
    onFrame(f) {
      frames.push({ t: performance.now(), codec: f.codec, w: f.width, h: f.height, bytes: f.data.byteLength, key: f.keyframe, seq: Number(f.sequence) });
      if (!ack) return;
      if (session) sendAck(Number(f.sequence));
      else pendingAcks.push(Number(f.sequence));
    },
    onEvent(e) {
      events.push({ t: performance.now(), kind: e.kind, json: e.json.slice(0, 300) });
    },
  };
  const opts = { maxFps, maxDimension, audio: false, disableVideo: false };
  if (requestJson) opts.requestJson = requestJson;
  const r = { label, requestJson, maxFps, maxDimension, ack };
  const tOpen = performance.now();
  try {
    session = await withTimeout(pc.openMedia(opts, sink), 15_000, "openMedia");
  } catch (e) {
    r.error = String(e?.message ?? e);
    console.log(label, "openMedia failed:", r.error);
    return r;
  }
  for (const s of pendingAcks.splice(0)) sendAck(s);
  r.openMs = Math.round(performance.now() - tOpen);
  r.codec = session.codec();
  try {
    r.openResponse = JSON.parse(session.openResponseJson());
  } catch {
    r.openResponse = session.openResponseJson();
  }
  const phases = [];
  async function phase(name, ms, kind) {
    let proc;
    if (kind === "damage") proc = await startDamage();
    if (kind === "damage") await sleep(500); // let the window map
    const start = performance.now();
    const before = frames.length;
    if (kind === "move") {
      jiggle = true;
      const j = jiggler();
      await sleep(ms);
      jiggle = false;
      await j;
    } else {
      await sleep(ms);
    }
    const got = frames.slice(before);
    const dur = (performance.now() - start) / 1000;
    if (proc) await proc.kill().catch(() => {});
    const gaps = got.slice(1).map((f, i) => f.t - got[i].t);
    const p = {
      name,
      seconds: +dur.toFixed(2),
      frames: got.length,
      fps: +(got.length / dur).toFixed(1),
      gapP50ms: gaps.length ? +pct(gaps, 50).toFixed(1) : null,
      gapP95ms: gaps.length ? +pct(gaps, 95).toFixed(1) : null,
      avgBytes: got.length ? Math.round(got.reduce((a, f) => a + f.bytes, 0) / got.length) : 0,
      size: got.length ? `${got[0].w}x${got[0].h}` : null,
      keyframes: got.filter((f) => f.key).length,
      MBps: +(got.reduce((a, f) => a + f.bytes, 0) / dur / 1e6).toFixed(1),
    };
    phases.push(p);
    console.log(label, JSON.stringify(p));
  }
  await phase("first 1s (initial)", 1000, "idle");
  await phase("idle", seconds * 1000, "idle");
  await phase("pointer moving only", seconds * 1000, "move");
  await phase("terminal damage", seconds * 1000, "damage");
  await phase("idle again", 3000, "idle");
  r.phases = phases;
  r.stats = session.stats();
  r.events = events.filter((e) => e.kind !== "stats").slice(0, 12);
  r.eventKinds = [...new Set(events.map((e) => e.kind))];
  r.firstFrameMs = frames.length ? Math.round(frames[0].t - tOpen) : null;
  await session.close().catch(() => {});
  return r;
}

out.media = [];
out.media.push(await media("bgra native, no ack", '{"codecs":["MEDIA_CODEC_BGRA"]}', { ack: false, seconds: 3 }));
out.media.push(await media("bgra native", '{"codecs":["MEDIA_CODEC_BGRA"]}'));
out.media.push(await media("bgra 640", '{"codecs":["MEDIA_CODEC_BGRA"]}', { maxDimension: 640 }));
out.media.push(await media("h264 (default)", undefined));

save(mediaOnly ? "frames-media.json" : "frames.json", out);
console.log("saved");
process.exit(0);
