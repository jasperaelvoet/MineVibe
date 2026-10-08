// Guest CPU cost of each frame tier (container stats cpuUsageUsec delta) with continuous screen damage.
import "./env.mjs";
import { ImageFormat } from "@trycua/cua";
import { connectPc, ct, save, sleep, NAME } from "./lib.mjs";

const pc = await connectPc();
const cpuUsec = async () => JSON.parse((await ct(["stats", "--no-stream", "--format", "json", NAME], { timeoutMs: 20_000 })).stdout)[0].cpuUsageUsec;
const hostVm = () => {
  // nothing host-side here; VZ process CPU is sampled separately with ps
};
async function measure(label, fn, seconds = 5) {
  const stop = { v: false };
  const c0 = await cpuUsec();
  const t0 = performance.now();
  const p = fn(stop);
  await sleep(seconds * 1000);
  stop.v = true;
  const extra = await p;
  const c1 = await cpuUsec();
  const wall = (performance.now() - t0) / 1000;
  const r = { label, guestCores: +((c1 - c0) / 1e6 / wall).toFixed(2), ...extra };
  console.log(JSON.stringify(r));
  return r;
}
const damage = await pc.spawn({ program: "xfce4-terminal", args: ["--geometry=100x30+80+80", "-x", "sh", "-c", "while true; do date +%s.%N; done"], env: new Map([["DISPLAY", ":1"]]), user: "cua", stdin: false, tag: "s5-cost" });
await sleep(800);
const out = [];
out.push(await measure("damage only (no consumer)", async () => ({})));
async function media(stop, requestJson, maxDimension = 0) {
  let n = 0;
  let bytes = 0;
  const s = await pc.openMedia({ maxFps: 30, maxDimension, audio: false, disableVideo: false, ...(requestJson ? { requestJson } : {}) }, {
    onFrame(f) {
      n++;
      bytes += f.data.byteLength;
    },
    onEvent() {},
  });
  const t0 = performance.now();
  while (!stop.v) await sleep(50);
  const dt = (performance.now() - t0) / 1000;
  await s.close().catch(() => {});
  return { fps: +(n / dt).toFixed(1), MBps: +(bytes / dt / 1e6).toFixed(1) };
}
out.push(await measure("bgra 1280 30fps", (s) => media(s, '{"codecs":["MEDIA_CODEC_BGRA"]}')));
out.push(await measure("bgra 640 30fps", (s) => media(s, '{"codecs":["MEDIA_CODEC_BGRA"]}', 640)));
out.push(await measure("h264 1280 30fps", (s) => media(s)));
async function poll(stop, maxDimension, fps) {
  let n = 0;
  const t0 = performance.now();
  while (!stop.v) {
    const s = performance.now();
    await pc.screenshot({ format: ImageFormat.Jpeg, quality: 75, maxDimension, includeCursor: false });
    n++;
    const wait = 1000 / fps - (performance.now() - s);
    if (wait > 0) await sleep(wait);
  }
  return { fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1) };
}
out.push(await measure("jpeg 960 @8fps", (s) => poll(s, 960, 8)));
out.push(await measure("jpeg 640 @4fps", (s) => poll(s, 640, 4)));
out.push(await measure("jpeg 1280 @30fps", (s) => poll(s, 1280, 30)));
await damage.kill().catch(() => {});
await sleep(1500);
out.push(await measure("idle desktop, no consumer", async () => ({})));
save("cost.json", out);
process.exit(0);
