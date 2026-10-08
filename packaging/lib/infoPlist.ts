/** Values for the `@TOKENS@` in apps/launcher-mac/Info.plist. */
export interface InfoPlistValues {
  /** CFBundleShortVersionString, e.g. `0.1.0`. */
  readonly VERSION: string;
  /** CFBundleVersion: a monotonically increasing build number. */
  readonly BUILD: string;
  /** `abc1234` or `abc1234-dirty`. */
  readonly COMMIT: string;
}

const VERSION_RE = /^\d+(\.\d+){0,2}$/;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Fills the template's tokens. Every token must be known and filled, and the versions well-formed. */
export function renderInfoPlist(template: string, values: InfoPlistValues): string {
  if (!VERSION_RE.test(values.VERSION)) throw new Error(`bad CFBundleShortVersionString ${values.VERSION}`);
  if (!VERSION_RE.test(values.BUILD)) throw new Error(`bad CFBundleVersion ${values.BUILD}`);
  const out = template.replace(/@([A-Z_]+)@/g, (match, name: string) => {
    const value = (values as unknown as Record<string, string | undefined>)[name];
    if (value === undefined) throw new Error(`Info.plist template has an unknown token ${match}`);
    return escapeXml(value);
  });
  return out;
}

/** The string value of a key in a plain XML plist (enough for checks of our own template). */
export function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m?.[1] ?? null;
}

/** The boolean value of a key in a plain XML plist. */
export function plistBool(xml: string, key: string): boolean | null {
  const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(xml);
  return m ? m[1] === 'true' : null;
}
