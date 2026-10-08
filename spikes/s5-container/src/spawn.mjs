// S5 step 6d: spawn/run as `cua` with cwd inside the path-identical Vault mount; host-side ownership; API shape.
import "./env.mjs";
import { statSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ReplayMode } from "@trycua/cua";
import { connectPc, save, sleep, VAULT, withTimeout } from "./lib.mjs";

const pc = await connectPc();
const res = { vault: VAULT, checks: [] };
const check = (name, ok, detail) => {
  res.checks.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ?? "");
};
const txt = (b) => Buffer.from(b).toString();
const cmd = (program, args, extra = {}) => ({ program, args, env: new Map(), stdin: false, ...extra });

// run() as cua with cwd in the vault: identity, cwd, mount view, write a file.
const o = await withTimeout(
  pc.run(cmd("bash", ["-lc", "id; pwd; ls -ln; echo from-guest > guest-file.txt; mkdir -p sub && echo x > sub/y; stat -c '%U:%G %a %n' guest-file.txt host-file.txt"], { user: "cua", cwd: VAULT, timeoutMs: 10_000 })),
  20_000,
  "run",
);
res.runAsCua = { exit: o.exit, stdout: txt(o.stdout), stderr: txt(o.stderr) };
console.log(res.runAsCua.stdout);
check("run as cua, cwd in vault", o.exit.success && txt(o.stdout).includes("uid=1000(cua)") && txt(o.stdout).includes(VAULT), JSON.stringify(o.exit));
const gf = join(VAULT, "guest-file.txt");
if (existsSync(gf)) {
  const st = statSync(gf);
  res.hostView = { content: readFileSync(gf, "utf8").trim(), uid: st.uid, gid: st.gid, mode: (st.mode & 0o777).toString(8) };
  check("host sees guest-written file immediately", res.hostView.content === "from-guest", JSON.stringify(res.hostView));
} else check("host sees guest-written file immediately", false, "missing");

// Ownership quirks: what the guest sees for a host file; chmod; mode-0200 create; symlink; git.
const q = await pc.run(
  cmd(
    "bash",
    [
      "-c",
      [
        "set +e",
        "echo '--- guest view'; stat -c '%u:%g %a %n' . host-file.txt guest-file.txt",
        "echo '--- chmod 600'; chmod 600 guest-file.txt; echo rc=$?; stat -c '%a' guest-file.txt",
        "echo '--- O_CREAT mode 0200'; python3 -c \"import os; fd=os.open('m0200.txt', os.O_CREAT|os.O_WRONLY, 0o200); os.write(fd,b'x'); os.close(fd); print('ok')\" 2>&1",
        "echo '--- symlink'; ln -sf guest-file.txt link.txt; echo rc=$?; readlink link.txt",
        "echo '--- chown'; chown 0:0 guest-file.txt 2>&1; echo rc=$?",
        "echo '--- git'; git init -q repo && cd repo && git -c user.email=a@b -c user.name=s5 commit -q --allow-empty -m init && git log --oneline | head -1; echo rc=$?",
      ].join("\n"),
    ],
    { user: "cua", cwd: VAULT, timeoutMs: 15_000 },
  ),
);
res.quirks = txt(q.stdout) + txt(q.stderr);
console.log(res.quirks);
const m0200 = join(VAULT, "m0200.txt");
res.hostM0200 = existsSync(m0200) ? (statSync(m0200).mode & 0o777).toString(8) : null;
res.hostGuestFileModeAfterChmod = (statSync(gf).mode & 0o777).toString(8);
res.hostSymlink = (() => {
  try {
    return statSync(join(VAULT, "link.txt")) && readFileSync(join(VAULT, "link.txt"), "utf8").trim();
  } catch (e) {
    return String(e);
  }
})();

// Host -> guest visibility + inotify (host edit, guest watcher).
const ino = await pc.spawn(
  cmd(
    "python3",
    [
      "-c",
      `
import ctypes, os, select, sys, struct
libc = ctypes.CDLL("libc.so.6", use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
wd = libc.inotify_add_watch(fd, b"${VAULT}", 0x00000002 | 0x00000100 | 0x00000008)
print("watching", wd, flush=True)
r, _, _ = select.select([fd], [], [], 4.0)
if r:
    data = os.read(fd, 4096)
    _, mask, _, ln = struct.unpack_from("iIII", data)
    print("EVENT", hex(mask), data[16:16+ln].rstrip(b"\\0").decode(), flush=True)
else:
    print("NO_EVENT within 4s", flush=True)
`,
    ],
    { user: "cua", cwd: VAULT, timeoutMs: 10_000 },
  ),
);
await sleep(800);
writeFileSync(join(VAULT, "host-edit.txt"), `host edit ${Date.now()}\n`);
const inoOut = await withTimeout(ino.wait(), 15_000, "inotify wait");
res.inotifyHostEdit = txt(inoOut.stdout).trim() + txt(inoOut.stderr);
const seen = await pc.run(cmd("cat", [join(VAULT, "host-edit.txt")], { user: "cua" }));
check("guest sees host edit (content)", txt(seen.stdout).startsWith("host edit"), txt(seen.stdout).trim());
check("guest inotify fires for host-side edit", /^EVENT /m.test(res.inotifyHostEdit), res.inotifyHostEdit);

// Spawn API shape: background, tag, attach, signal, kill, timeout.
const bg = await pc.spawn(cmd("bash", ["-c", "for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 0.3; done"], { user: "cua", cwd: VAULT, tag: "s5-bg" }));
res.spawn = { pid: bg.pid(), tag: bg.tag() };
const firstEv = await withTimeout(bg.nextEvent(), 5_000, "nextEvent");
res.spawn.firstEvent = { kind: firstEv?.kind, offset: Number(firstEv?.offset ?? 0), data: txt(firstEv?.data ?? new ArrayBuffer(0)) };
await bg.detach();
await sleep(600);
const re = await withTimeout(pc.attach(undefined, "s5-bg", ReplayMode.All.new()), 5_000, "attach by tag");
res.spawn.attachPid = re.pid();
await re.signal("term");
const reOut = await withTimeout(re.wait(), 5_000, "wait after term");
res.spawn.afterTerm = { exit: reOut.exit, replayed: txt(reOut.stdout).split("\n").filter(Boolean).length };
check("spawn background + attach by tag + SIGTERM", reOut.exit.signal === "term" || reOut.exit.signal === "TERM" || !reOut.exit.success, JSON.stringify(res.spawn));

const to = await pc.run(cmd("sleep", ["10"], { user: "cua", timeoutMs: 700 }));
res.timeout = to.exit;
check("timeoutMs kills the process", to.exit.timedOut === true, JSON.stringify(to.exit));

const killp = await pc.spawn(cmd("sleep", ["30"], { user: "cua", tag: "s5-kill" }));
await killp.kill();
const ko = await withTimeout(killp.wait(), 5_000, "wait after kill");
check("kill() = SIGKILL", (ko.exit.signal ?? "").toLowerCase().includes("kill"), JSON.stringify(ko.exit));

const ps = JSON.parse(await pc.listProcesses(false));
res.listProcessesSample = ps.slice(0, 3);

// sh() runs as root by default? record identity.
const who = await pc.sh("id -un; echo $HOME", 5_000);
res.shDefaultUser = txt(who.stdout).trim();
// PTY session shape
const pty = await pc.spawn(cmd("bash", ["-i"], { user: "cua", cwd: VAULT, stdin: true, pty: { cols: 100, rows: 30 }, tag: "s5-pty" }));
await pty.writePty(new TextEncoder().encode("cd /tmp && pwd && exit\n").buffer);
const po = await withTimeout(pty.wait(), 5_000, "pty wait");
res.pty = txt(po.pty).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").slice(-200);
check("PTY spawn + writePty", res.pty.includes("/tmp"), JSON.stringify(res.pty.slice(-80)));

for (const f of ["host-edit.txt"]) try { unlinkSync(join(VAULT, f)); } catch {}
save("spawn.json", res);
const fails = res.checks.filter((c) => !c.ok).length;
console.log(`${res.checks.length - fails}/${res.checks.length} passed`);
process.exit(0);
