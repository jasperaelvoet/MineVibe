import { describe, expect, it } from 'vitest';
import { wrapBash } from '../../src/agents/tools/pcServer.js';
import { isApiError } from '../../src/contracts/common.js';
import {
  absolutePaths,
  anchorGlob,
  applyEdit,
  exitCodeOf,
  formatRgJson,
  grepArgs,
  JobBuffer,
  mirrorPrompt,
  OutputCapture,
  parseRgCount,
  shellQuote,
  splitGlob,
} from '../../src/pcs/guest.js';

describe('OutputCapture (30k head + tail)', () => {
  it('keeps everything under the cap', () => {
    const c = new OutputCapture(100);
    c.append('hello ');
    c.append('world');
    expect(c.text()).toBe('hello world');
    expect(c.truncated).toBe(false);
  });

  it('keeps the head and the tail of a long stream within the cap', () => {
    const c = new OutputCapture(200);
    c.append('HEAD'.repeat(10));
    for (let i = 0; i < 1000; i++) c.append(`line ${i}\n`);
    c.append('\n__MV_PWD__/home/cua/app');
    const out = c.text();
    expect(c.truncated).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith('HEADHEAD')).toBe(true);
    expect(out.endsWith('\n__MV_PWD__/home/cua/app')).toBe(true);
    const omitted = Number(/\((\d+) characters omitted\)/.exec(out)?.[1]);
    const shown = out.length - (/\n… \(\d+ characters omitted\) …\n/.exec(out)?.[0].length ?? 0);
    expect(omitted + shown).toBe(c.total);
  });

  it('works at the real cap', () => {
    const c = new OutputCapture();
    c.append('x'.repeat(100_000));
    expect(c.text().length).toBeLessThanOrEqual(30_000);
  });
});

describe('JobBuffer', () => {
  it('reads by offset and keeps only the newest characters', () => {
    const b = new JobBuffer(10);
    b.append('0123456789');
    expect(b.read(0, 4)).toEqual({ text: '0123', next: 4, more: true, skipped: false });
    b.append('abcde');
    expect(b.base).toBe(5);
    expect(b.end).toBe(15);
    expect(b.read(2, 100)).toEqual({ text: '56789abcde', next: 15, more: false, skipped: true });
    expect(b.read(15, 100)).toEqual({ text: '', next: 15, more: false, skipped: false });
  });
});

describe('applyEdit (Edit semantics)', () => {
  it('replaces one unique match', () => {
    expect(applyEdit('a = 1;\nb = 2;\n', 'b = 2', 'b = 3', false)).toEqual({
      content: 'a = 1;\nb = 3;\n',
      count: 1,
    });
  });

  it('replaces every match with replace_all and counts them', () => {
    expect(applyEdit('x x x', 'x', 'y', true)).toEqual({ content: 'y y y', count: 3 });
  });

  it('treats replacement text literally ($& is not a pattern)', () => {
    expect(applyEdit('cost', 'cost', '$&$1', false).content).toBe('$&$1');
  });

  it('refuses a missing, empty or ambiguous old_string', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return isApiError(e) ? e.code : 'other';
      }
      return 'none';
    };
    expect(codeOf(() => applyEdit('abc', 'zzz', 'y', false))).toBe('EDIT_NOT_FOUND');
    expect(codeOf(() => applyEdit('abc', '', 'y', false))).toBe('EDIT_NOT_FOUND');
    expect(codeOf(() => applyEdit('x x', 'x', 'y', false))).toBe('EDIT_AMBIGUOUS');
  });
});

describe('glob helpers', () => {
  it('anchors patterns the way the built-in Glob reads them', () => {
    expect(anchorGlob('*.ts')).toBe('/*.ts');
    expect(anchorGlob('src/*.ts')).toBe('/src/*.ts');
    expect(anchorGlob('**/*.ts')).toBe('**/*.ts');
    expect(anchorGlob('/abs/*.ts')).toBe('/abs/*.ts');
  });

  it('splits an absolute pattern into a directory and a relative pattern', () => {
    expect(splitGlob('/home/cua/app/src/**/*.ts', '/x')).toEqual({
      dir: '/home/cua/app/src',
      pattern: '**/*.ts',
    });
    expect(splitGlob('/home/cua/*.md', '/x')).toEqual({ dir: '/home/cua', pattern: '*.md' });
    expect(splitGlob('**/*.ts', '/work')).toEqual({ dir: '/work', pattern: '**/*.ts' });
  });

  it('joins ripgrep paths onto the directory', () => {
    expect(absolutePaths('./a.ts\n./src/b.ts\n\n', '/work/')).toEqual(['/work/a.ts', '/work/src/b.ts']);
    expect(absolutePaths('./etc/x\n', '/')).toEqual(['/etc/x']);
  });
});

describe('grep helpers', () => {
  it('passes the pattern with -e and the path after --', () => {
    const args = grepArgs({
      pattern: '-v',
      path: '/work',
      outputMode: 'content',
      caseInsensitive: true,
      before: 2,
      after: 1,
      glob: '*.ts',
      type: 'ts',
      multiline: true,
    });
    expect(args).toEqual([
      '--no-config',
      '--hidden',
      '--no-messages',
      '-g',
      '!.git',
      '--json',
      '-i',
      '-U',
      '--multiline-dotall',
      '-t',
      'ts',
      '-g',
      '*.ts',
      '-B',
      '2',
      '-A',
      '1',
      '-e',
      '-v',
      '--',
      '/work',
    ]);
    expect(grepArgs({ pattern: 'x', path: '/w', outputMode: 'files_with_matches' })).toContain(
      '--files-with-matches',
    );
    expect(grepArgs({ pattern: 'x', path: '/w', outputMode: 'count' })).toContain('--count');
  });

  const msg = (type: string, path: string, line: number, text: string) =>
    JSON.stringify({ type, data: { path: { text: path }, line_number: line, lines: { text: `${text}\n` } } });

  it('formats rg --json like rg -n, with context separators', () => {
    const out = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/w/a.ts' } } }),
      msg('context', '/w/a.ts', 1, 'before'),
      msg('match', '/w/a.ts', 2, 'needle here'),
      msg('match', '/w/a.ts', 9, 'needle again'),
      JSON.stringify({ type: 'end', data: {} }),
      msg('match', '/w/b.ts', 3, 'needle'),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n');
    expect(formatRgJson(out, { lineNumbers: true, context: true })).toEqual({
      lines: [
        '/w/a.ts-1-before',
        '/w/a.ts:2:needle here',
        '--',
        '/w/a.ts:9:needle again',
        '--',
        '/w/b.ts:3:needle',
      ],
      matches: 3,
      incomplete: false,
    });
    expect(formatRgJson(out, { lineNumbers: false, context: false }).lines).toEqual([
      '/w/a.ts-before',
      '/w/a.ts:needle here',
      '/w/a.ts:needle again',
      '/w/b.ts:needle',
    ]);
  });

  it('splits multiline matches, decodes bytes and reports a cut-off last line', () => {
    const out = [
      JSON.stringify({
        type: 'match',
        data: { path: { text: '/w/m' }, line_number: 4, lines: { text: 'one\ntwo\n' } },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: Buffer.from('/w/bin').toString('base64') },
          line_number: 1,
          lines: { bytes: Buffer.from('x\n').toString('base64') },
        },
      }),
      '{"type":"match","data":{"pa',
    ].join('\n');
    expect(formatRgJson(out, { lineNumbers: true, context: false })).toEqual({
      lines: ['/w/m:4:one', '/w/m:5:two', '/w/bin:1:x'],
      matches: 3,
      incomplete: true,
    });
  });

  it('sums rg --count output', () => {
    expect(parseRgCount('/w/a:3\n/w/b:2\n')).toEqual({ lines: ['/w/a:3', '/w/b:2'], matches: 5 });
  });
});

describe('exits and prompts', () => {
  it('maps exits to shell codes', () => {
    expect(exitCodeOf({ code: 3 })).toBe(3);
    expect(exitCodeOf({ signal: 'kill' })).toBe(137);
    expect(exitCodeOf({ signal: 'SIGTERM' })).toBe(143);
    expect(exitCodeOf({})).toBe(137);
  });

  it('builds the ShellMirror prompt from the tool server wrapper only', () => {
    const p = mirrorPrompt(wrapBash('npm test\nnpm run lint'), {
      agentId: 'ada',
      pcId: 'linux-1',
      cwd: '/home/cua/app',
    });
    expect(p).toContain('ada@linux-1');
    expect(p).toContain('~/app');
    expect(p).toContain('$ npm test …');
    expect(p).not.toContain('\n');
    expect(mirrorPrompt('ls -la', { agentId: 'ada', pcId: 'linux-1', cwd: undefined })).toBeNull();
  });

  it('colours the prompt with real escape sequences and strips the ones a command carries', () => {
    const ESC = '\u001b';
    const p = mirrorPrompt(wrapBash(`printf '${ESC}[2J${ESC}]0;pwned\u0007'`), {
      agentId: 'ada',
      pcId: 'linux-1',
      cwd: '/home/cua',
    });
    expect(p).toBe(`${ESC}[1;32mada@linux-1${ESC}[0m:${ESC}[1;34m~${ESC}[0m$ printf '[2J]0;pwned'`);
  });

  it('quotes shell words', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
