import { describe, expect, it } from 'vitest';
import { HOME, REPO } from '../../../eval/pc/content.js';
import { PC_ID, ScriptedPc, unwrapBash } from '../../../eval/pc/ScriptedPc.js';
import { stripPwdMarker, wrapBash } from '../../../src/agents/tools/pcServer.js';
import { isApiError } from '../../../src/contracts/common.js';

async function sh(pc: ScriptedPc, command: string, cwd = HOME) {
  const res = await pc.exec(PC_ID, { command: wrapBash(command), cwd, env: { MV_CWD: cwd }, tag: 'ada:1' });
  if (res.kind !== 'done') throw new Error('background');
  const { output, cwd: newCwd } = stripPwdMarker(res.output);
  return { output: output.replace(/\s+$/, ''), exitCode: res.exitCode, cwd: newCwd };
}

describe('ScriptedPc shell', () => {
  it('unwraps the pc__bash wrapper and reports the cwd marker', async () => {
    expect(unwrapBash(wrapBash('cd repo && ls'))).toBe('cd repo && ls');
    expect(unwrapBash('plain')).toBe('plain');
    const pc = new ScriptedPc();
    const res = await sh(pc, 'cd ~/repo && pwd');
    expect(res).toEqual({ output: REPO, exitCode: 0, cwd: REPO });
  });

  it('runs the failing test, and it passes after the fix', async () => {
    const pc = new ScriptedPc();
    const before = await sh(pc, 'npm test', REPO);
    expect(before.exitCode).toBe(1);
    expect(before.output).toContain('✖ subtotal multiplies price by quantity');
    expect(before.output).toContain('8 !== 19');
    await pc.editFile(PC_ID, {
      path: `${REPO}/src/cart.js`,
      oldString: 'sum + item.price,',
      newString: 'sum + item.price * item.qty,',
    });
    const after = await sh(pc, 'cd ~/repo && node --test');
    expect(after.exitCode).toBe(0);
    expect(after.output).toContain('ℹ pass 2');
    expect(pc.testRuns.map((r) => r.passed)).toEqual([false, true]);
    expect(pc.testFileIntact()).toBe(true);
    const status = await sh(pc, 'git status', REPO);
    expect(status.output).toContain('modified:   src/cart.js');
    const diff = await sh(pc, 'git diff', REPO);
    expect(diff.output).toContain('+  return items.reduce((sum, item) => sum + item.price * item.qty, 0);');
  });

  it('pipes, lists, operators, redirects and globs', async () => {
    const pc = new ScriptedPc();
    expect((await sh(pc, 'ls ~/repo')).output).toBe('README.md  package.json  src  test');
    expect((await sh(pc, 'cat ~/repo/src/cart.js | grep -n price')).output).toBe(
      '2:  return items.reduce((sum, item) => sum + item.price, 0);',
    );
    expect((await sh(pc, 'false && echo no || echo yes')).output).toBe('yes');
    expect((await sh(pc, 'echo hi > /tmp/x.txt; cat /tmp/x.txt')).output).toBe('hi');
    expect((await sh(pc, 'ls ~/repo/src/*.js')).output).toBe(`${REPO}/src/cart.js`);
    expect((await sh(pc, 'grep -rn "qty" .', REPO)).output).toContain('test/cart.test.js:6:');
    expect((await sh(pc, 'find . -name "*.js"', REPO)).output).toBe('./src/cart.js\n./test/cart.test.js');
    expect((await sh(pc, "sed -n '1,2p' src/cart.js", REPO)).output).toBe(
      'export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);',
    );
  });

  it('reads basic regular expressions in sed and grep, like GNU sed/grep', async () => {
    const pc = new ScriptedPc();
    // `+` is literal in a BRE: this is the edit Opus tried in the baseline.
    await sh(pc, "sed -i 's/sum + item.price, 0/sum + item.price * item.qty, 0/' src/cart.js", REPO);
    expect((await sh(pc, 'npm test', REPO)).exitCode).toBe(0);
    expect((await sh(pc, "grep -c 'sum + item' src/cart.js", REPO)).output).toBe('1');
    expect((await sh(pc, "grep -E -c 'sum +item' src/cart.js", REPO)).output).toBe('0');
    expect((await sh(pc, "echo a/b | sed 's/\\//-/'")).output).toBe('a-b');
    expect((await sh(pc, "echo price=5 | sed 's/\\(price\\)=\\([0-9]\\)/\\2 \\1 &/'")).output).toBe(
      '5 price price=5',
    );
    expect((await sh(pc, "echo aaa | sed -E 's/a+/b/'")).output).toBe('b');
  });

  it('reports disk usage and fails like an offline box', async () => {
    const pc = new ScriptedPc();
    expect((await sh(pc, 'df -h /')).output).toMatch(/overlay\s+50G\s+41G\s+9\.0G\s+82% \/$/);
    const du = (await sh(pc, 'du -sh ~/* 2>/dev/null | sort -h')).output.split('\n');
    expect(du.at(-1)).toBe(`18G\t${HOME}/Downloads`);
    const curl = await sh(pc, 'curl https://wiki.office.lan/releases');
    expect(curl).toMatchObject({ exitCode: 6 });
    expect(curl.output).toContain('Could not resolve host');
    expect((await sh(pc, 'frobnicate')).exitCode).toBe(127);
    expect((await sh(pc, 'node -e "process.exit(0)"')).exitCode).toBe(1);
  });

  it('file calls follow the guest semantics', async () => {
    const pc = new ScriptedPc();
    const read = await pc.readFile(PC_ID, { path: `${REPO}/src/cart.js`, offset: 2, limit: 1 });
    expect(read).toEqual({
      content: '  return items.reduce((sum, item) => sum + item.price, 0);\n',
      startLine: 2,
      totalLines: 11,
      truncated: true,
    });
    for (const [req, code] of [
      [{ path: `${REPO}/src/cart.js`, oldString: 'nope', newString: 'x' }, 'EDIT_NOT_FOUND'],
      [{ path: `${REPO}/src/cart.js`, oldString: 'items', newString: 'x' }, 'EDIT_AMBIGUOUS'],
      [{ path: `${REPO}/missing.js`, oldString: 'a', newString: 'b' }, 'NOT_FOUND'],
    ] as const) {
      await pc.editFile(PC_ID, req).then(
        () => {
          throw new Error('expected a failure');
        },
        (err: unknown) => expect(isApiError(err, code)).toBe(true),
      );
    }
    expect((await pc.glob(PC_ID, { pattern: '**/*.js', path: REPO })).paths).toEqual([
      `${REPO}/src/cart.js`,
      `${REPO}/test/cart.test.js`,
    ]);
    const grep = await pc.grep(PC_ID, {
      pattern: 'qty',
      path: REPO,
      outputMode: 'content',
      lineNumbers: true,
    });
    expect(grep.output.split('\n').map((l) => l.split(':').slice(0, 2).join(':'))).toEqual([
      `${REPO}/test/cart.test.js:6`,
      `${REPO}/test/cart.test.js:10`,
    ]);
    expect(grep.matches).toBe(2);
  });
});

describe('ScriptedPc screen', () => {
  it('opens the browser, searches the wiki and reaches the releases page', async () => {
    const pc = new ScriptedPc();
    const png = (await pc.screenshot(PC_ID)).data;
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1280, 800]);
    await pc.pointer(PC_ID, { action: 'click', x: 95, y: 265 });
    expect(pc.desktop.app).toBe('desktop'); // one click selects
    await pc.pointer(PC_ID, { action: 'double_click', x: 95, y: 265 });
    expect(pc.desktop.describe()).toBe('browser about:home');
    await pc.pointer(PC_ID, { action: 'click', x: 640, y: 254 });
    await pc.type(PC_ID, 'latest release');
    await pc.keyboard(PC_ID, { action: 'press', keys: ['Return'] });
    expect(pc.desktop.page).toBe('results');
    await pc.pointer(PC_ID, { action: 'click', x: 500, y: 327 });
    expect(pc.desktop.page).toBe('releases');
    await pc.keyboard(PC_ID, { action: 'press', keys: ['alt', 'Left'] });
    expect(pc.desktop.page).toBe('results');
    expect(pc.desktop.visited).toEqual(['start', 'results', 'releases', 'results']);
  });

  it('navigates by address bar and from the shell', async () => {
    const pc = new ScriptedPc();
    await sh(pc, 'xdg-open http://wiki.office.lan/');
    expect(pc.desktop.describe()).toBe('browser wiki.office.lan/');
    await pc.keyboard(PC_ID, { action: 'press', keys: ['ctrl', 'l'] });
    await pc.type(PC_ID, 'wiki.office.lan/releases\n');
    expect(pc.desktop.page).toBe('releases');
    await pc.keyboard(PC_ID, { action: 'press', keys: ['ctrl', 'l'] });
    await pc.type(PC_ID, 'google.com\n');
    expect(pc.desktop.page).toBe('notfound');
    const frame = (await pc.screenshot(PC_ID)).data;
    expect(frame.length).toBeGreaterThan(1000);
  });
});
