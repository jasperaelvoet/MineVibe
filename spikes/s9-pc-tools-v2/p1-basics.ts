import type { ProbeCtx } from './client.js';

/** P0 items 1, 5 (ListWindows), 10: methods, features, binaries, default handlers, displays. */
export default async function (p: ProbeCtx) {
  const methods = p.c.jsonMethods();
  const caps = await p.c.capabilities();
  const which = await p.sh(
    'for b in pdftotext tesseract xdg-open gtk-launch firefox firefox-esr chromium chromium-browser google-chrome code mousepad xfce4-terminal gedit xdotool wmctrl python3 node; do printf "%s=%s\\n" $b "$(command -v $b || echo -)"; done; echo https=$(xdg-mime query default x-scheme-handler/https 2>/dev/null); echo text=$(xdg-mime query default text/plain 2>/dev/null); ls /usr/share/applications | head -80 | tr "\\n" " "',
  );
  const displays = await p.c.displays();
  const windows = await p.call('WindowsService/ListWindows', {});
  return {
    methods,
    caps: JSON.parse(JSON.stringify(caps, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))),
    which: which.out,
    displays: JSON.parse(displays),
    windows,
    transport: p.c.transport(),
  };
}
