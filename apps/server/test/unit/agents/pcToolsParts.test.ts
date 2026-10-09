/**
 * The pieces of PC tools V2 that need no PC: batch bookkeeping, screenshot geometry, xdotool key text, the stream
 * marks, and the golden texts of Claude Code 2.1.293's built-ins (taken from the bundled `claude` binary).
 */

import { describe, expect, it } from 'vitest';
import { streamMark } from '../../../src/agents/AgentSession.js';
import { BatchBook, isPcToolUse } from '../../../src/agents/tools/pc/batch.js';
import { guardResult } from '../../../src/agents/tools/pc/context.js';
import * as F from '../../../src/agents/tools/pc/formats.js';
import {
  checkPoint,
  geometryFor,
  imageTokens,
  regionToScreen,
  toImage,
  toScreen,
} from '../../../src/agents/tools/pc/geometry.js';
import { parseKeyText, parseModifiers } from '../../../src/agents/tools/pc/keys.js';

describe('BatchBook', () => {
  it('knows the last pc call of a message, waiting for the message to end', async () => {
    const b = new BatchBook();
    b.messageStart('m1');
    b.toolUse('m1', 'a', 'mcp__pc__left_click');
    b.toolUse('m1', 'x', 'mcp__mc__status');
    b.toolUse('m1', 'b', 'Bash');
    const pending = b.isLast('b', 1_000);
    b.messageStop('m1');
    expect(await pending).toBe(true);
    expect(await b.isLast('a', 0)).toBe(false);
    expect(await b.isLast('nope', 0)).toBeNull();
    expect(await b.isLast(undefined)).toBeNull();
    expect(isPcToolUse('mcp__pc__key') && isPcToolUse('Read') && !isPcToolUse('mcp__mc__mine')).toBe(true);
  });

  it('halts the calls after a failed one in the same message only', () => {
    const b = new BatchBook();
    b.assistantMessage('m1', [
      { id: 'a', name: 'mcp__pc__left_click' },
      { id: 'b', name: 'mcp__pc__type' },
      { id: 'c', name: 'mcp__pc__key' },
    ]);
    b.assistantMessage('m2', [{ id: 'd', name: 'mcp__pc__key' }]);
    b.fail('b');
    expect([b.halted('a'), b.halted('b'), b.halted('c'), b.halted('d')]).toEqual([false, false, true, false]);
  });

  it('a call asked about before its block streamed is waited for briefly', async () => {
    const b = new BatchBook();
    b.messageStart('m1');
    const asked = b.isLast('late', 1_000);
    setTimeout(() => {
      b.toolUse(null, 'late', 'mcp__pc__type');
      b.messageStop();
    }, 20);
    expect(await asked).toBe(true);
  });
});

describe('stream marks', () => {
  it('reads message starts, tool_use block starts and stops; ignores the rest', () => {
    expect(streamMark({ type: 'message_start', message: { id: 'msg_1' } }, null)).toEqual({
      kind: 'message_start',
      messageId: 'msg_1',
    });
    expect(
      streamMark(
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 't', name: 'n' } },
        'msg_1',
      ),
    ).toEqual({ kind: 'tool_use', messageId: 'msg_1', toolUseId: 't', name: 'n' });
    expect(streamMark({ type: 'content_block_start', content_block: { type: 'text' } }, 'msg_1')).toBeNull();
    expect(streamMark({ type: 'message_stop' }, 'msg_1')).toEqual({
      kind: 'message_stop',
      messageId: 'msg_1',
    });
    expect(streamMark({ type: 'content_block_delta' }, null)).toBeNull();
  });
});

describe('screenshot geometry', () => {
  it('is 1:1 on the 1280x800 Linux PCs and scales larger screens to a 1280 long edge', () => {
    expect(geometryFor({ w: 1280, h: 800 })).toEqual({
      screenW: 1280,
      screenH: 800,
      imgW: 1280,
      imgH: 800,
      scale: 1,
    });
    expect(imageTokens(1280, 800)).toBe(1334);
    const g = geometryFor({ w: 1920, h: 1080 });
    expect([g.imgW, g.imgH]).toEqual([1280, 720]);
    const mac = geometryFor({ w: 2560, h: 1600 });
    expect([mac.imgW, mac.imgH, mac.scale]).toEqual([1280, 800, 0.5]);
    expect(toScreen(mac, 640, 400)).toEqual({ x: 1280, y: 800 });
    expect(toScreen(mac, 1279, 799)).toEqual({ x: 2558, y: 1598 });
    expect(toImage(mac, 2559, 1599)).toEqual({ x: 1279, y: 799 });
    expect(geometryFor({ w: 1024, h: 768 }).scale).toBe(1);
  });

  it('checks points and regions against the image', () => {
    const g = geometryFor({ w: 1280, h: 800 });
    expect(checkPoint(g, [1279, 799])).toEqual({ ok: true, x: 1279, y: 799 });
    expect(checkPoint(g, [1280, 5]).ok).toBe(false);
    expect(regionToScreen(g, [10, 20, 110, 70])).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(regionToScreen(g, [10, 20, 10, 70])).toBeNull();
    expect(regionToScreen(g, [0, 0, 1281, 10])).toBeNull();
    const mac = geometryFor({ w: 2560, h: 1600 });
    expect(regionToScreen(mac, [0, 0, 320, 200])).toEqual({ x: 0, y: 0, w: 640, h: 400 });
  });
});

describe('key text (xdotool names)', () => {
  it('parses chords, sequences, keysyms and the literal plus', () => {
    expect(parseKeyText('ctrl+s')).toEqual({ ok: true, chords: [['KEY_CONTROL', 's']] });
    expect(parseKeyText('ctrl+shift+t')).toEqual({ ok: true, chords: [['KEY_CONTROL', 'KEY_SHIFT', 't']] });
    expect(parseKeyText('ctrl+a Delete')).toEqual({
      ok: true,
      chords: [['KEY_CONTROL', 'a'], ['KEY_DELETE']],
    });
    expect(parseKeyText('Return')).toEqual({ ok: true, chords: [['KEY_ENTER']] });
    expect(parseKeyText('super')).toEqual({ ok: true, chords: [['KEY_META']] });
    expect(parseKeyText('alt+Tab')).toEqual({ ok: true, chords: [['KEY_ALT', 'KEY_TAB']] });
    expect(parseKeyText('ISO_Left_Tab')).toEqual({ ok: true, chords: [['KEY_SHIFT', 'KEY_TAB']] });
    expect(parseKeyText('ctrl++')).toEqual({ ok: true, chords: [['KEY_CONTROL', '+']] });
    expect(parseKeyText('ctrl+plus')).toEqual({ ok: true, chords: [['KEY_CONTROL', '+']] });
    expect(parseKeyText(' ')).toEqual({ ok: true, chords: [['KEY_SPACE']] });
    expect(parseKeyText('Ctrl-S')).toEqual({ ok: false, error: F.badKey('Ctrl-S') });
    expect(parseKeyText('ctrl+')).toMatchObject({ ok: false });
  });

  it('modifiers for clicks are modifiers only', () => {
    expect(parseModifiers('ctrl+shift')).toEqual({ ok: true, chords: [['KEY_CONTROL', 'KEY_SHIFT']] });
    expect(parseModifiers(undefined)).toEqual({ ok: true, chords: [[]] });
    expect(parseModifiers('ctrl+a')).toMatchObject({ ok: false });
  });
});

describe('golden texts (Claude Code 2.1.293)', () => {
  it('Read', () => {
    expect(F.READ_EMPTY).toBe(
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    );
    expect(F.readShorterThanOffset(9, 4)).toBe(
      '<system-reminder>Warning: the file exists but is shorter than the provided offset (9). The file has 4 lines.</system-reminder>',
    );
    expect(F.readMissing('/w')).toBe('File does not exist. Note: your current working directory is /w.');
    expect(F.READ_UNCHANGED).toBe(
      'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
    );
    expect(F.readPartialByLines('/w/a', 2000, 2500)).toBe(
      '[Truncated: PARTIAL view — /w/a: showing 2000 of 2500 lines. Call Read with offset/limit to page through. Do NOT answer from this page alone if the answer may be further in the file.]',
    );
  });

  it('Edit and Write', () => {
    expect(F.editUpdated('/w/a')).toBe('The file /w/a has been updated successfully.');
    expect(F.editUpdatedAll('/w/a')).toBe(
      'The file /w/a has been updated. All occurrences were successfully replaced.',
    );
    expect(F.editNotFound('x')).toBe('String to replace not found in file.\nString: x');
    expect(F.EDIT_SAME).toBe('No changes to make: old_string and new_string are exactly the same.');
    expect(F.EDIT_CREATE_EXISTS).toBe('Cannot create new file - file already exists.');
    expect(F.NOT_READ_YET).toBe('File has not been read yet. Read it first before writing to it.');
    expect(F.MODIFIED_SINCE_READ).toBe(
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    );
    expect(F.writeCreated('/w/a')).toBe(
      'File created successfully at: /w/a (file state is current in your context — no need to Read it back)',
    );
  });

  it('Grep and Glob', () => {
    expect(F.grepFiles(['a', 'b'], undefined, 0, 2)).toBe('Found 2 files\na\nb');
    expect(F.grepFiles(['a'], 1, 0, 2)).toBe('Found 1 file limit: 1\na');
    expect(F.grepFiles([], undefined, 5, 2)).toBe(
      'No entries at this offset. [Showing results with pagination = offset: 5]',
    );
    expect(F.grepFiles([], undefined, 0, 0)).toBe('No files found');
    expect(F.grepContent('a:1:x', 250, 10, 300)).toBe(
      'a:1:x\n\n[Showing results with pagination = limit: 250, offset: 10]',
    );
    expect(F.grepContent('', undefined, 0, 0)).toBe('No matches found');
    expect(F.grepCount('a:3\nb:1', 4, 2, undefined, 0)).toBe(
      'a:3\nb:1\n\nFound 4 total occurrences across 2 files.',
    );
    expect(F.grepCount('a:1', 1, 1, undefined, 0)).toBe('a:1\n\nFound 1 total occurrence across 1 file.');
    expect(F.globTruncated(100, 140, true)).toBe(
      '(Showing 100 of 140 matching files; 40 more are not listed. Narrow the pattern or path to see the rest.)',
    );
    expect(F.globTruncated(100, undefined, undefined)).toBe(
      '(Results are truncated. Consider using a more specific path or pattern.)',
    );
  });

  it('Bash', () => {
    expect(F.bashBackground('b1', '/p')).toBe(
      'Command running in background with ID: b1. Output is being written to: /p. You will be notified when it completes. To check interim output, use Read on that file path.',
    );
    expect(F.bashMovedToBackground(120_000, 'b1', '/p', 1_800_000)).toBe(
      'Command did not complete within its 120s timeout and was moved to the background (ID: b1). Output is being written to: /p. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.',
    );
    expect([
      F.formatDuration(1_800_000),
      F.formatDuration(7_200_000),
      F.formatDuration(5_400_000),
      F.formatDuration(45_000),
    ]).toEqual(['30m', '2h', '1h 30m', '45s']);
    expect(F.bashExit(2, 'boom')).toBe('Exit code 2\nboom');
    expect(F.taskStopped('b1', 'npm run dev')).toBe('Successfully stopped task: b1 (npm run dev)');
  });

  it('the exit codes some commands use for "nothing found"', () => {
    expect(F.interpretExit('grep -r foo .', 1)).toBe('No matches found');
    expect(F.interpretExit('cat x | rg foo', 1)).toBe('No matches found');
    expect(F.interpretExit('cd a && git grep foo', 1)).toBe('No matches found');
    expect(F.interpretExit('git diff --stat', 1)).toBe('Files differ');
    expect(F.interpretExit('diff a b 2>&1', 1)).toBe('Files differ');
    expect(F.interpretExit('test -f x', 1)).toBe('Condition is false');
    expect(F.interpretExit('[ -f x ]', 1)).toBe('Condition is false');
    expect(F.interpretExit('find / -name x', 1)).toBe('Some directories were inaccessible');
    expect(F.interpretExit('grep foo x', 2)).toBeNull();
    expect(F.interpretExit('npm test', 1)).toBeNull();
    expect(F.interpretExit('echo "a | grep b"; false', 1)).toBeNull();
  });

  it('task notifications', () => {
    expect(
      F.taskNotification({
        taskId: 'b1',
        toolUseId: 'toolu_1',
        outputFile: '/p',
        status: 'completed',
        summary: F.jobSummary('Build', { status: 'completed', exitCode: 0 }),
      }),
    ).toBe(
      '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/p</output-file>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>',
    );
    expect(F.jobSummary('Dev', { status: 'killed', exitCode: 137, why: 'it ran past its time limit' })).toBe(
      'Background command "Dev" was stopped (it ran past its time limit)',
    );
  });

  it('computer', () => {
    expect(F.BATCH_HALT).toBe('Not executed: an earlier computer action in this turn failed.');
    expect(F.outOfBounds(1400, 300, 1280, 800)).toBe(
      'Coordinate (1400, 300) is outside the screen (1280x800). Coordinates are pixels of the latest screenshot, origin top-left.',
    );
  });
});

describe('guardResult (D7)', () => {
  it('keeps a result under 60k characters by cutting the middle of its longest text, and leaves images alone', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
    const big = guardResult({ content: [{ type: 'text', text: `HEAD${'x'.repeat(100_000)}TAIL` }, image] });
    const text = (big.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(text.startsWith('HEAD')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(text).toMatch(/\.\.\. \[\d+ characters cut\] \.\.\./);
    expect(big.content[1]).toEqual(image);
    const small = { content: [{ type: 'text' as const, text: 'ok' }] };
    expect(guardResult(small)).toBe(small);
  });
});
