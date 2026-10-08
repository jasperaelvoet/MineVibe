/**
 * PC scenarios (Opus 5.5 at medium, seated at `linux-1`): a shell + edit task, a GUI task, and a report.
 */

import type { PcScenario } from '../harness/types.js';
import { REPO, runRepoTests } from '../pc/content.js';
import { LATEST_RELEASE } from '../pc/desktop.js';

const pc = (name: string) => `mcp__pc__${name}`;

export const fixTest: PcScenario = {
  suite: 'pc',
  id: 'pc.fix_test',
  title: 'fix the failing test in ~/repo',
  prompt: 'fix the failing test in ~/repo',
  checks(t) {
    const run = runRepoTests(t.pc.fs, false);
    const ranAfter = t.pc.testRuns.some((r) => r.passed);
    return [
      {
        name: 'tests_pass',
        pass: run.passed,
        required: true,
        detail: run.passed ? 'npm test passes' : 'npm test still fails',
      },
      {
        name: 'test_file_untouched',
        pass: t.pc.testFileIntact(),
        required: true,
        detail: t.pc.testFileIntact() ? 'test/cart.test.js unchanged' : 'the test was edited',
      },
      {
        name: 'verified_with_tests',
        pass: ranAfter,
        required: false,
        detail: ranAfter ? 'saw the tests pass' : 'never saw them pass',
      },
    ];
  },
  replay: {
    good: [
      [
        { tool: pc('bash'), input: { command: 'cd ~/repo && npm test' } },
        { tool: pc('read'), input: { file_path: `${REPO}/src/cart.js` } },
        {
          tool: pc('edit'),
          input: {
            file_path: `${REPO}/src/cart.js`,
            old_string: 'sum + item.price,',
            new_string: 'sum + item.price * item.qty,',
          },
        },
        { tool: pc('bash'), input: { command: 'npm test' } },
        { text: 'Fixed subtotal() to multiply by quantity; both tests pass now.' },
      ],
    ],
    bad: [
      [
        {
          tool: pc('edit'),
          input: { file_path: `${REPO}/test/cart.test.js`, old_string: '), 19);', new_string: '), 8);' },
        },
        { text: 'Updated the test.' },
      ],
    ],
  },
};

const RELEASE_RE = new RegExp(`${LATEST_RELEASE.name}|${LATEST_RELEASE.version.replace(/\./g, '\\.')}`, 'i');

export const browserFind: PcScenario = {
  suite: 'pc',
  id: 'pc.browser_find',
  title: 'open the browser and find X',
  prompt: 'open the browser and find the name of the latest MineVibe release on the team wiki',
  checks(t) {
    const said = t.speech.join('\n');
    const visited = t.pc.desktop.visited.includes('releases');
    return [
      {
        name: 'answer_correct',
        pass: RELEASE_RE.test(said),
        required: true,
        detail: RELEASE_RE.test(said) ? 'named 0.7.3 Copper Golem' : `said: ${t.finalText.slice(0, 100)}`,
      },
      {
        name: 'used_the_browser',
        pass: visited,
        required: true,
        detail: `pages: ${t.pc.desktop.visited.join(' > ') || 'none'}`,
      },
      {
        name: 'screenshots',
        pass: t.pc.screenshots > 0,
        required: false,
        detail: `${t.pc.screenshots} screenshots`,
      },
    ];
  },
  replay: {
    good: [
      [
        { tool: pc('screenshot'), input: {} },
        { tool: pc('double_click'), input: { x: 95, y: 265 } },
        { tool: pc('screenshot'), input: {} },
        { tool: pc('click'), input: { x: 640, y: 254 } },
        { tool: pc('type'), input: { text: 'minevibe releases' } },
        { tool: pc('key'), input: { keys: 'Enter' } },
        { tool: pc('screenshot'), input: {} },
        { tool: pc('click'), input: { x: 500, y: 327 } },
        { tool: pc('screenshot'), input: {} },
        { text: 'The latest release is 0.7.3, "Copper Golem".' },
      ],
    ],
    bad: [[{ text: 'The latest release is probably 0.7.2.' }]],
  },
};

const USAGE_RE =
  /\b82\s?%|\b41(\.0)?\s?G(i?B)?\b[^.\n]*\b50(\.0)?\s?G|\b9(\.0)?\s?G(i?B)?\b[^.\n]*(free|avail|left)/i;

export const diskUsage: PcScenario = {
  suite: 'pc',
  id: 'pc.disk_usage',
  title: 'check disk usage and report',
  prompt: 'check disk usage and report',
  checks(t) {
    const said = t.speech.join('\n');
    const ranDf = t.pc.execs.some((e) => /\bdf\b/.test(e.command));
    return [
      {
        name: 'reported_usage',
        pass: USAGE_RE.test(said),
        required: true,
        detail: t.finalText.slice(0, 120),
      },
      { name: 'ran_df', pass: ranDf, required: false, detail: ranDf ? 'used df' : 'no df' },
      {
        name: 'named_biggest_folder',
        pass: /downloads/i.test(said),
        required: false,
        detail: 'mentions ~/Downloads (18G)',
      },
    ];
  },
  replay: {
    good: [
      [
        { tool: pc('bash'), input: { command: 'df -h /' } },
        { tool: pc('bash'), input: { command: 'du -sh ~/* ~/.cache 2>/dev/null | sort -h' } },
        { text: 'The disk is 82% full: 41G of 50G used, 9G free. Biggest: ~/Downloads (18G).' },
      ],
    ],
    bad: [[{ text: 'Disk usage looks fine.' }]],
  },
};

export const PC_SCENARIOS: readonly PcScenario[] = [fixTest, browserFind, diskUsage];
