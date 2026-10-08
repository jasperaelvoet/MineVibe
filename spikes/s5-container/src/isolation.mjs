// S5 step 7: can a guest reach host services? Host servers on 127.0.0.1:47999 and 0.0.0.0:47998,
// probed from inside the guest (as cua, via spacesd) at the vmnet gateway, magic hostnames, the host LAN IP,
// the host's own published spacesd port, and a second container's IP.
import "./env.mjs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { connectPc, ct, save, sleep, withTimeout } from "./lib.mjs";

const servers = [];
function serve(host, port, id) {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      res.end(`${id} from ${req.socket.remoteAddress}\n`);
    });
    s.on("error", reject);
    s.listen(port, host, () => {
      servers.push(s);
      resolve();
    });
  });
}
await serve("127.0.0.1", 47999, "LOOPBACK-47999");
await serve("0.0.0.0", 47998, "ANY-47998");

const def = execFileSync("route", ["-n", "get", "default"]).toString();
const ifname = /interface: (\S+)/.exec(def)?.[1];
const lan = (networkInterfaces()[ifname] ?? []).find((a) => a.family === "IPv4")?.address;
const allV4 = Object.entries(networkInterfaces()).flatMap(([n, as]) => as.filter((a) => a.family === "IPv4" && !a.internal).map((a) => `${n}=${a.address}`));

const pc = await connectPc();
const run = async (line) => {
  const o = await withTimeout(pc.run({ program: "sh", args: ["-c", line], env: new Map(), stdin: false, user: "cua", timeoutMs: 15_000 }), 20_000, line);
  return (Buffer.from(o.stdout).toString() + Buffer.from(o.stderr).toString()).trim();
};

// A second container (tiny HTTP server) to test guest -> guest.
const peer = await ct(["run", "-d", "--rm", "--name", "mv-s5-peer", "-l", "minevibe=s5-peer", "ghcr.io/trycua/linux:24.04", "python3", "-m", "http.server", "8080"], { timeoutMs: 120_000 });
await sleep(1500);
let peerIp;
try {
  const insp = JSON.parse((await ct(["inspect", "mv-s5-peer"], { timeoutMs: 30_000 })).stdout);
  peerIp = insp[0]?.status?.networks?.[0]?.ipv4Address?.split("/")[0] ?? insp[0]?.networks?.[0]?.ipv4Address?.split("/")[0];
} catch {}

const res = { hostLanIf: ifname, hostLanIp: lan, hostIPv4: allV4, peerIp, peerRun: peer.code, probes: [] };
res.guestNet = await run("ip -4 addr show eth0 | grep inet; ip route; cat /etc/resolv.conf | grep -v '^#'");
res.dns = await run("for h in host.docker.internal host.containers.internal gateway.docker.internal host.lima.internal; do printf '%s: ' $h; getent hosts $h || echo NXDOMAIN; done");

const targets = [
  ["gateway 192.168.64.1:47999 (host loopback-only server)", "http://192.168.64.1:47999/"],
  ["gateway 192.168.64.1:47998 (host 0.0.0.0 server)", "http://192.168.64.1:47998/"],
  ["host.docker.internal:47999", "http://host.docker.internal:47999/"],
  ["host.docker.internal:47998", "http://host.docker.internal:47998/"],
  ["host.containers.internal:47998", "http://host.containers.internal:47998/"],
  [`host LAN ${lan}:47999`, `http://${lan}:47999/`],
  [`host LAN ${lan}:47998`, `http://${lan}:47998/`],
  ["guest 127.0.0.1:47999 (own loopback)", "http://127.0.0.1:47999/"],
  ["gateway 192.168.64.1:43211 (host-published spacesd, bound 127.0.0.1)", "http://192.168.64.1:43211/"],
  [`host LAN ${lan}:43211 (published spacesd)`, `http://${lan}:43211/`],
  ["gateway 192.168.64.1:22 (host sshd if any)", "http://192.168.64.1:22/"],
  ["internet https://example.com", "https://example.com/"],
];
if (peerIp) targets.push([`peer container ${peerIp}:8080 (guest -> guest)`, `http://${peerIp}:8080/`]);
for (const [name, url] of targets) {
  const out = await run(`curl -sS -m 4 -o /tmp/body -w '%{http_code}' '${url}' 2>&1; echo; head -c 120 /tmp/body 2>/dev/null; rm -f /tmp/body`);
  const code = out.split("\n")[0];
  const reachable = /^\d{3}$/.test(code) && code !== "000";
  res.probes.push({ name, url, reachable, out: out.slice(0, 220) });
  console.log(reachable ? "REACHABLE  " : "unreachable", name, "|", out.replace(/\n/g, " ").slice(0, 140));
}

await ct(["stop", "mv-s5-peer"], { timeoutMs: 60_000 });
await ct(["delete", "mv-s5-peer"], { timeoutMs: 30_000 }).catch(() => {});
for (const s of servers) s.close();
save("isolation.json", res);
console.log(JSON.stringify({ guestNet: res.guestNet, dns: res.dns, hostIPv4: res.hostIPv4, peerIp }, null, 1));
process.exit(0);
