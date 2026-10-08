import { describe, expect, it } from 'vitest';
import { bubbleText } from '../../../src/agents/AgentBrain.js';
import { BUBBLE_MAX_CHARS } from '../../../src/agents/constants.js';

describe('bubbleText (the speech bubble over an agent)', () => {
  it('keeps the first two sentences', () => {
    expect(bubbleText('On it. Mining oak now. Then a table.')).toBe('On it. Mining oak now.');
  });

  it('never splits inside a token with dots, and never drops what came before it (acceptance run)', () => {
    const text =
      "The kernel version is 6.18.35 on aarch64, but /mnt/codex doesn't exist on linux-1, so the ls failed. Both commands only read, so I ran them without a plan and then stood up.";
    expect(bubbleText(text)).toBe(
      "The kernel version is 6.18.35 on aarch64, but /mnt/codex doesn't exist on linux-1, so the ls failed. Both commands only read, so I ran them without a plan and then stood up.",
    );
    expect(bubbleText('Edited src/app.ts and ran npm test. All green!')).toBe(
      'Edited src/app.ts and ran npm test. All green!',
    );
  });

  it('flattens whitespace, keeps text without an end mark, and caps the length', () => {
    expect(bubbleText('  Done\n\nfor   now  ')).toBe('Done for now');
    expect(bubbleText('Really?! Yes.')).toBe('Really?! Yes.');
    const long = bubbleText(`${'word '.repeat(100)}end.`);
    expect(long.length).toBe(BUBBLE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});
