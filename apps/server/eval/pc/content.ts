/**
 * What is on the scripted PC: the user's home with a small Node repo whose test fails (`~/repo`), big files for the
 * disk-usage scenario, and the fixed outputs of system commands (`df`, `free`, `uname`). The repo's tests are
 * "run" by checking the source, never by executing model-written code.
 */

import { human, MemFs } from './fs.js';

export const HOME = '/home/cua';
export const REPO = `${HOME}/repo`;
export const HOSTNAME = 'linux-1';

export const CART_JS = `export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

export function applyDiscount(total, percent) {
  return Math.round(total * (100 - percent)) / 100;
}

export function total(items, discountPercent = 0) {
  return applyDiscount(subtotal(items), discountPercent);
}
`;

export const CART_TEST_JS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, total } from '../src/cart.js';

test('subtotal multiplies price by quantity', () => {
  assert.equal(subtotal([{ price: 5, qty: 2 }, { price: 3, qty: 3 }]), 19);
});

test('total applies a percentage discount', () => {
  assert.equal(total([{ price: 10, qty: 1 }], 10), 9);
});
`;

const PACKAGE_JSON = `{
  "name": "shop-cart",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const README = `# shop-cart

Tiny cart helpers for the office shop. Run the tests with \`npm test\`.
`;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Big placeholder files: path → bytes. */
export const BIG_FILES: Readonly<Record<string, number>> = {
  [`${HOME}/Downloads/ubuntu-24.04.2-desktop-amd64.iso`]: 6.1 * GiB,
  [`${HOME}/Downloads/dataset-2026.tar.gz`]: 11.8 * GiB,
  [`${HOME}/Videos/standup-recording.mp4`]: 9.4 * GiB,
  [`${HOME}/.cache/pip/wheels.bin`]: 6.2 * GiB,
  [`${HOME}/Documents/report.pdf`]: 240 * MiB,
};

/** A fresh PC file system. */
export function homeFs(): MemFs {
  const fs = new MemFs(
    {
      [`${REPO}/package.json`]: PACKAGE_JSON,
      [`${REPO}/README.md`]: README,
      [`${REPO}/src/cart.js`]: CART_JS,
      [`${REPO}/test/cart.test.js`]: CART_TEST_JS,
      [`${REPO}/.gitignore`]: 'node_modules/\n',
      [`${HOME}/.bashrc`]: '# ~/.bashrc\nexport PATH="$HOME/.local/bin:$PATH"\n',
      [`${HOME}/Documents/notes.md`]: '# Notes\n- order more coffee\n',
    },
    [`${HOME}/Desktop`, `${HOME}/Downloads`, `${HOME}/Videos`, `${HOME}/.cache/pip`, `${REPO}/.git`],
  );
  for (const [path, bytes] of Object.entries(BIG_FILES)) {
    fs.write(path, '(binary)');
    fs.sizes.set(path, Math.round(bytes));
  }
  return fs;
}

/** The root file system as `df` reports it. */
export const DISK = { size: 50 * GiB, used: 41 * GiB, avail: 9 * GiB, pct: 82 } as const;

export function dfOutput(humanReadable: boolean, onlyRoot: boolean): string {
  const rows = humanReadable
    ? [
        ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'],
        ['overlay', '50G', '41G', '9.0G', '82%', '/'],
        ['tmpfs', '64M', '0', '64M', '0%', '/dev'],
        ['shm', '64M', '0', '64M', '0%', '/dev/shm'],
        ['/dev/vda1', '50G', '41G', '9.0G', '82%', '/etc/hosts'],
      ]
    : [
        ['Filesystem', '1K-blocks', 'Used', 'Available', 'Use%', 'Mounted on'],
        ['overlay', '52428800', '42991616', '9437184', '82%', '/'],
        ['tmpfs', '65536', '0', '65536', '0%', '/dev'],
        ['shm', '65536', '0', '65536', '0%', '/dev/shm'],
        ['/dev/vda1', '52428800', '42991616', '9437184', '82%', '/etc/hosts'],
      ];
  const picked = onlyRoot ? rows.slice(0, 2) : rows;
  const widths = picked[0]?.map((_, i) => Math.max(...picked.map((r) => (r[i] ?? '').length))) ?? [];
  return picked
    .map((r) =>
      r
        .map((c, i) =>
          i === 0 ? c.padEnd(widths[i] ?? 0) : i === r.length - 1 ? c : c.padStart(widths[i] ?? 0),
        )
        .join(' '),
    )
    .join('\n');
}

export const FREE_H = `               total        used        free      shared  buff/cache   available
Mem:           3.8Gi       1.2Gi       1.9Gi        12Mi       0.9Gi       2.4Gi
Swap:             0B          0B          0B`;

export const UNAME_A = `Linux ${HOSTNAME} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux`;

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
`;

/** Extracts the text of function `name` (declaration or const arrow) from a JS source, or null. */
function functionText(src: string, name: string): string | null {
  const re = new RegExp(`(function\\s+${name}\\s*\\(|(const|let|var)\\s+${name}\\s*=)`);
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  const open = src.indexOf('{', start);
  if (open < 0) {
    const end = src.indexOf('\n', start);
    return src.slice(start, end < 0 ? undefined : end);
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Whether `subtotal` multiplies price by quantity (the fix). */
export function subtotalFixed(src: string): boolean {
  const body = functionText(src, 'subtotal');
  if (!body) return false;
  return /\bqty\b/.test(body) && /\bprice\b/.test(body) && /\*/.test(body);
}

function discountIntact(src: string): boolean {
  const body = functionText(src, 'applyDiscount');
  return body !== null && /100\s*-\s*percent/.test(body);
}

export interface TestRun {
  readonly exitCode: number;
  readonly output: string;
  readonly passed: boolean;
}

/** "Runs" the repo's tests (node --test output). */
export function runRepoTests(fs: MemFs, viaNpm: boolean): TestRun {
  const src = fs.read(`${REPO}/src/cart.js`) ?? '';
  const first = subtotalFixed(src);
  const second = discountIntact(src) && functionText(src, 'total') !== null;
  const lines: string[] = [];
  if (viaNpm) lines.push('', '> shop-cart@1.0.0 test', '> node --test', '');
  const failure = [
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '  8 !== 19',
    '',
    `      at TestContext.<anonymous> (file://${REPO}/test/cart.test.js:6:10)`,
    '      at Test.runInAsyncScope (node:async_hooks:211:14)',
    '      at Test.run (node:internal/test_runner/test:979:25)',
  ];
  lines.push(
    first
      ? '✔ subtotal multiplies price by quantity (0.62ms)'
      : '✖ subtotal multiplies price by quantity (0.91ms)',
  );
  if (!first) lines.push(...failure);
  lines.push(
    second
      ? '✔ total applies a percentage discount (0.18ms)'
      : '✖ total applies a percentage discount (0.20ms)',
  );
  if (!second)
    lines.push('  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '  NaN !== 9');
  const pass = (first ? 1 : 0) + (second ? 1 : 0);
  lines.push(
    'ℹ tests 2',
    'ℹ suites 0',
    `ℹ pass ${pass}`,
    `ℹ fail ${2 - pass}`,
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 48.3',
  );
  if (pass < 2) {
    lines.push('', '✖ failing tests:', '');
    if (!first)
      lines.push(
        'test at test/cart.test.js:5:1',
        '✖ subtotal multiplies price by quantity (0.91ms)',
        ...failure.slice(0, 3),
      );
    if (!second)
      lines.push('test at test/cart.test.js:9:1', '✖ total applies a percentage discount (0.20ms)');
  }
  const passed = pass === 2;
  return { exitCode: passed ? 0 : 1, output: lines.join('\n'), passed };
}

export { human };
