// S5 step 5: `container run` the cua linux image and time boot until spacesd answers Health.
// usage: node src/boot.mjs [--no-run] [--url http://host:port]
import { ct, connectPc, token, save, sleep, NAME, HOST_PORT, VAULT, withTimeout } from "./lib.mjs";

const args = process.argv.slice(2);
const noRun = args.includes("--no-run");
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
const url = urlArg ?? `http://127.0.0.1:${HOST_PORT}`;
const extra = args.includes("--extra") ? args[args.indexOf("--extra") + 1].split(" ") : [];

const result = { url, steps: [] };
const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);

if (!noRun) {
  const runArgs = [
    "run", "-d", "--name", NAME,
    "--cpus", "2", "--memory", "4G", "--shm-size", "2G",
    "-e", "CUA_ENV_TOKEN",
    "-p", `127.0.0.1:${HOST_PORT}:3211`,
    "-v", `${VAULT}:${VAULT}`,
    "-v", `${NAME}-home:/home/cua`,
    "-l", "minevibe=pc",
    ...extra,
    "ghcr.io/trycua/linux:24.04",
  ];
  // The token goes only through the environment (inherited by -e CUA_ENV_TOKEN), never argv.
  const r = await ct(runArgs, { timeoutMs: 180_000, env: { CUA_ENV_TOKEN: token() } });
  result.run = { args: runArgs, code: r.code, ms: r.ms, timedOut: r.timedOut, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  console.log(`run: code=${r.code} ${r.ms}ms ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.code !== 0) {
    save("boot.json", result);
    process.exit(1);
  }
}

// Poll: TCP+gRPC Health via the cua client. First success = boot time.
let attempts = 0;
let lastErr = "";
let client;
while (since() < 180_000) {
  attempts++;
  try {
    client = await connectPc(url, { timeoutMs: 3_000 });
    const h = JSON.parse(await withTimeout(client.health(), 3_000, "health"));
    // health() resolves even when NOT_SERVING (e.g. X not up yet), so check the status.
    if (result.firstAnswerMs === undefined) {
      result.firstAnswerMs = since();
      result.firstHealth = h;
      console.log(`spacesd first answered after ${result.firstAnswerMs} ms: ${h.status}`);
    }
    if (h.status !== "HEALTH_STATUS_SERVING") throw new Error(`not serving: ${JSON.stringify(h.components)}`);
    result.health = h;
    result.bootMs = since();
    result.attempts = attempts;
    console.log(`spacesd SERVING after ${result.bootMs} ms (${attempts} attempts)`);
    break;
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    if (msg !== lastErr) {
      result.steps.push({ t: since(), err: msg });
      console.log(`  t=${since()}ms ${msg}`);
      lastErr = msg;
    }
    await sleep(250);
  }
}

if (client) {
  try {
    const caps = await withTimeout(client.capabilities(), 5_000, "capabilities");
    result.capabilities = caps;
    result.displays = JSON.parse(await withTimeout(client.displays(), 5_000, "displays"));
    result.transport = client.transport();
    result.endpoint = client.endpoint();
    result.jsonMethods = client.jsonMethods();
  } catch (e) {
    result.capsErr = String(e);
  }
}
save(noRun ? "boot-norun.json" : "boot.json", result);
console.log(JSON.stringify({ bootMs: result.bootMs, displays: result.displays, transport: result.transport }, null, 1));
process.exit(result.bootMs ? 0 : 2);
