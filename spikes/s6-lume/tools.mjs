// Spike S6: which shell tools behave how in the macOS guest (BSD userland, bash 3.2), for PcApi's guest scripts.
//   node tools.mjs <vm>
import { guest } from './g.mjs';

const name = process.argv[2] ?? 'mv-pc-mac-1';
const { sh } = await guest(name);
const checks = {
  'dirname --': 'dirname -- /a/b/c',
  'mkdir -p --': 'mkdir -p -- /tmp/s6x/y && echo ok',
  'stat -f %z': 'printf abc > /tmp/s6x/f && stat -f %z /tmp/s6x/f',
  'stat -L -f %HT|%z|%m': 'ln -sf /tmp/s6x/f /tmp/s6x/l && stat -L -f "%HT|%z|%m" /tmp/s6x/l',
  sha256sum: 'printf abc | sha256sum',
  'shasum -a 256': 'printf abc | shasum -a 256',
  'sed -u': 'printf "a __MV_PWD__x\\n" | sed -u "s/__MV_PWD__.*$//"',
  'awk /dev/stderr': 'echo x | awk "{ printf \\"%d\\\\n\\", NR > \\"/dev/stderr\\" }" 2>&1',
  'awk utf8 length': 'printf "\\303\\251\\n" | awk "{ print length(\\$0) }"',
  'wc -c format': 'printf abc | wc -c | od -c | head -1',
  'tee -a --': 'echo t | tee -a -- /tmp/s6x/t >/dev/null && cat /tmp/s6x/t',
  'ps -axwwE': 'MV_PROBE=zz sleep 5 & sleep 0.3; ps -axwwE -o pid=,ppid=,command= | grep -c "MV_PROBE=zz"; kill %1',
  'sudo ps -E root': 'sudo -n MV_ROOT=rr sleep 5 & sleep 0.5; sudo -n ps -axwwE -o pid=,command= | grep -v grep | grep -c "MV_ROOT=rr"',
  'sudo preserve-env': 'MV_TAG=q:1 sudo -n --preserve-env=MV_TAG bash -c "echo \\$MV_TAG"',
  'LC_ALL C.UTF-8': 'LC_ALL=C.UTF-8 locale 2>&1 | head -2',
  'locale -a utf8': 'locale -a | grep -i -E "^(C|en_US)\\.UTF-?8$"',
  'open --env': 'open --help 2>&1 | grep -i -- "--env" | head -2',
  'setsid/nohup': 'command -v setsid nohup',
  umask: 'umask',
  'bash -lc PATH': 'bash -lc "echo \\$PATH"',
  'tail -F': 'tail --help 2>&1 | head -1; man -P cat tail 2>/dev/null | grep -c -- " -F"',
  'tr -d NUL': 'printf "a\\000b" | tr -d "\\000" | wc -c',
  'mktemp': 'mktemp -d /tmp/s6x/m.XXXXXX',
};
for (const [label, script] of Object.entries(checks)) {
  const r = await sh(script, { timeoutMs: 20_000 });
  console.log(`${label.padEnd(24)} exit ${r.code} | ${(r.out + r.err).trim().replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
}
process.exit(0);
