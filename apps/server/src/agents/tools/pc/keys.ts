/**
 * The `key` / `hold_key` text (PC tools V2 §6): xdotool key names joined by `+` into a chord, chords separated by
 * spaces and pressed in order (`"ctrl+a Delete"`). Matching is case-insensitive and ignores `_`/`-`
 * (InputRouter.normalizeKeyName): `Return`, `KP_Enter`, `Page_Down`, `Prior`, `super`, `ctrl`, `bracketleft`, `F5`,
 * `XF86AudioMute`, or one printable character. `plus` is the `+` character; `ISO_Left_Tab` is shift+Tab.
 */

import { normalizeKeyName } from '../../../pcs/InputRouter.js';
import { badKey } from './formats.js';

export type KeyParse = { ok: true; chords: string[][] } | { ok: false; error: string };

/** Splits one chord on `+`, keeping a literal `+` key (`ctrl++`, a lone `+`). */
function splitChord(chord: string): string[] {
  if (chord === '+') return ['+'];
  const parts = chord.split('+');
  const keys: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === '' && i === parts.length - 1 && i > 0 && parts[i - 1] === '') {
      keys.pop();
      keys.push('+');
    } else keys.push(p);
  }
  return keys;
}

/** One key name as cua key names (one, or shift+Tab for ISO_Left_Tab). */
function keyNames(name: string): string[] | null {
  if (/^iso[_-]?left[_-]?tab$/i.test(name)) return ['KEY_SHIFT', 'KEY_TAB'];
  const n = normalizeKeyName(name);
  return n ? [n] : null;
}

/** Parses key text into chords of cua key names. */
export function parseKeyText(text: string): KeyParse {
  if (text.length === 0) return { ok: false, error: badKey(text) };
  if (text.trim().length === 0) return { ok: true, chords: [['KEY_SPACE']] };
  const chords: string[][] = [];
  for (const token of text.trim().split(/\s+/)) {
    const names = splitChord(token);
    if (names.some((n) => n.length === 0)) return { ok: false, error: badKey(token) };
    const chord: string[] = [];
    for (const name of names) {
      const keys = keyNames(name);
      if (!keys) return { ok: false, error: badKey(name === token ? name : token) };
      for (const k of keys) if (!chord.includes(k)) chord.push(k);
    }
    if (chord.length > 6) return { ok: false, error: badKey(token) };
    chords.push(chord);
  }
  if (chords.length > 50) return { ok: false, error: 'Too many keys in one call (at most 50 chords).' };
  return { ok: true, chords };
}

/** Modifier text (`"ctrl+shift"`) for the click tools: cua modifier names, or an error. */
export function parseModifiers(text: string | undefined): KeyParse {
  if (text === undefined || text.trim().length === 0) return { ok: true, chords: [[]] };
  const parsed = parseKeyText(text.replace(/\s+/g, '+'));
  if (!parsed.ok) return parsed;
  const keys = parsed.chords.flat();
  const bad = keys.find((k) => !/^KEY_(SHIFT|CONTROL|ALT|META|FN)(_LEFT|_RIGHT)?$/.test(k));
  if (bad) {
    return {
      ok: false,
      error: `"${text}" is not a modifier. Use "shift", "ctrl", "alt" or "super" ("cmd" on macOS), joined with + ("ctrl+shift").`,
    };
  }
  return { ok: true, chords: [keys] };
}
