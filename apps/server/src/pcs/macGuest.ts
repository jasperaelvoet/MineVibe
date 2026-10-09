import { basename } from 'node:path';
import type { MacShare } from './drivers/MacPcDriver.js';
import { MAC_SHARE_ROOT } from './guest.js';

/**
 * macOS PCs from the inside (PLAN §8.7, spike S6): which share is which, what MineVibe sets up in the guest after each
 * boot, and how it refreshes the guest's stale view of host edits.
 *
 * - **Shares.** Lume names a share after the last path component it is given, so MineVibe passes symlinks it names
 *   itself: `codex` for the Codex export, and each Vault folder's basename (made unique, never `setup` or `codex`).
 * - **Path identity.** Each Vault folder is reachable at its host path: `sudo mkdir -p <parent>` and a symlink to
 *   `/Volumes/My Shared Files/<share>`. Links of folders no longer mounted are removed; a path the guest already has
 *   for something else is left alone (and reported).
 * - **Once per disk.** `/etc/sudoers.d/minevibe` (NOPASSWD for `lume`, keeping `MV_TAG`/`MV_CALL`/`MV_MIRROR`, checked
 *   with `visudo -c`; the image's default password `lume` is used only to install it). Automatic update checks stay on:
 *   `softwareupdate --schedule off` exits 0 without effect on macOS 26, and its preferences need Full Disk Access.
 * - **ripgrep** from the setup share into `/usr/local/bin` (PcApi's glob and grep).
 * - **Display.** A fresh clone's guest starts in a 1024x768 mode although the VM's display is 1280x800; MineVibe
 *   switches it to the PC's 1280x800 once ({@link MAC_DISPLAY_JXA}, which persists), so frames have the monitor's 16:10
 *   shape.
 * - Everything runs with `umask 022`: spacesd's children have 077, and `sudo` keeps it, so folders made for path
 *   identity would otherwise be 0700 root (unreachable for `lume`).
 */

/** Share names MineVibe keeps for itself. */
const RESERVED = new Set(['setup', 'codex']);

/** A share name from a folder name: letters, digits, `.`, `_`, `-`, space; at most 48 characters. */
export function shareNameOf(folder: string): string {
  const n = basename(folder)
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 48)
    .trim();
  return n || 'vault';
}

export interface MacShareLink {
  share: MacShare;
  /** The path the guest gets a symlink at (the host path), or null for the Codex (linked at `~/codex`). */
  guestPath: string | null;
}

/** The shares of a macOS PC (Vault folders in order, then the Codex) with unique names. */
export function macShares(
  mounts: readonly { host: string; ro: boolean }[],
  codexExport: string | null,
): MacShareLink[] {
  const used = new Set<string>(RESERVED);
  const out: MacShareLink[] = [];
  for (const m of mounts) {
    const base = shareNameOf(m.host);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 44)}-${i}`;
    used.add(name.toLowerCase());
    out.push({ share: { name, hostPath: m.host, readOnly: m.ro }, guestPath: m.host });
  }
  if (codexExport)
    out.push({ share: { name: 'codex', hostPath: codexExport, readOnly: true }, guestPath: null });
  return out;
}

/** The Codex as a macOS guest sees it. */
export const MAC_CODEX_PATH = `${MAC_SHARE_ROOT}/codex`;

/** The image's default password: only used (once per disk) to install MineVibe's sudoers rule. Not a secret. */
const DEFAULT_PASSWORD = 'lume';

/**
 * The boot script, run as `lume` with `bash -c <script> setup <share> <host path> …`; env `MV_RG` (ripgrep in the setup
 * share, may be empty) and `MV_CODEX` (the Codex share name, may be empty). Prints `MVWARN …` lines and ends with `MVOK`;
 * exits 10/11 when sudo cannot be set up.
 */
export const MAC_SETUP_SCRIPT = `set -u
umask 022
S=${JSON.stringify(MAC_SHARE_ROOT)}
if ! sudo -n true 2>/dev/null; then
  printf '%s\\n' '${DEFAULT_PASSWORD}' | sudo -S -p '' true 2>/dev/null || { echo "MVERR sudo needs a password"; exit 10; }
  t=$(mktemp /tmp/mv-sudoers.XXXXXX)
  printf '%s\\n' 'lume ALL=(ALL) NOPASSWD: ALL' 'Defaults:lume env_keep += "MV_TAG MV_CALL MV_MIRROR"' > "$t"
  printf '%s\\n' '${DEFAULT_PASSWORD}' | sudo -S -p '' sh -c 'visudo -cf "$1" >/dev/null && install -m 0440 -o root -g wheel "$1" /etc/sudoers.d/minevibe' sh "$t" || { rm -f "$t"; echo "MVERR sudoers"; exit 11; }
  rm -f "$t"
  sudo -n true 2>/dev/null || { echo "MVERR sudoers"; exit 11; }
fi
sudo -n mkdir -p /var/db/minevibe && sudo -n chmod 0755 /var/db/minevibe
if [ -n "\${MV_RG:-}" ] && [ -x "$MV_RG" ] && ! cmp -s "$MV_RG" /usr/local/bin/rg; then
  sudo -n mkdir -p /usr/local/bin && sudo -n install -m 0755 "$MV_RG" /usr/local/bin/rg || echo "MVWARN ripgrep not installed"
fi
new=$(mktemp /tmp/mv-links.XXXXXX)
while [ $# -ge 2 ]; do
  share=$1; host=$2; shift 2
  target="$S/$share"
  if [ -L "$host" ]; then
    cur=$(readlink "$host")
    case "$cur" in
      "$S"/*) [ "$cur" = "$target" ] || sudo -n ln -sfn "$target" "$host" || { echo "MVWARN link $host"; continue; } ;;
      *) echo "MVWARN taken $host"; continue ;;
    esac
  elif [ -e "$host" ]; then
    echo "MVWARN taken $host"; continue
  else
    sudo -n mkdir -p "$(dirname "$host")" && sudo -n ln -s "$target" "$host" || { echo "MVWARN link $host"; continue; }
  fi
  printf '%s\\n' "$host" >> "$new"
done
if [ -f /var/db/minevibe/links ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    grep -qxF -- "$old" "$new" && continue
    if [ -L "$old" ]; then case "$(readlink "$old")" in "$S"/*) sudo -n rm -f "$old" ;; esac; fi
  done < /var/db/minevibe/links
fi
sudo -n install -m 0644 "$new" /var/db/minevibe/links; rm -f "$new"
if [ -n "\${MV_CODEX:-}" ] && [ -d "$S/$MV_CODEX" ] && [ ! -e "$HOME/codex" ] && [ ! -L "$HOME/codex" ]; then
  ln -s "$S/$MV_CODEX" "$HOME/codex" || echo "MVWARN ~/codex"
fi
echo MVOK`;

/**
 * Switches the main display to a 1x mode of exactly the size given (`1280x800`) for good: JavaScript for Automation
 * calling CoreGraphics through the ObjC bridge (`osascript -l JavaScript -e <this> 1280x800`, ~0.4 s; no Apple events,
 * so no Automation consent). A Swift script did the same but its first run in a fresh clone builds the Clang module
 * cache for tens of seconds. Prints `ok`, or why not.
 */
export const MAC_DISPLAY_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  const want = String(argv[0] || '').split('x').map(Number);
  const display = $.CGMainDisplayID();
  const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.kCGDisplayShowDuplicateLowResolutionModes);
  const modes = ObjC.castRefToObject($.CGDisplayCopyAllDisplayModes(display, opts));
  const seen = [];
  let pick = null;
  for (let i = 0; i < modes.count; i++) {
    const m = modes.objectAtIndex(i);
    const w = Number($.CGDisplayModeGetWidth(m));
    const h = Number($.CGDisplayModeGetHeight(m));
    const pw = Number($.CGDisplayModeGetPixelWidth(m));
    seen.push(w + 'x' + h + '@' + pw);
    if (!pick && w === want[0] && h === want[1] && pw === want[0] && Boolean($.CGDisplayModeIsUsableForDesktopGUI(m))) pick = m;
  }
  if (!pick) return 'no 1x mode ' + argv[0] + ' among ' + seen.join(' ');
  const config = Ref();
  $.CGBeginDisplayConfiguration(config);
  $.CGConfigureDisplayWithDisplayMode(config[0], display, pick, null);
  const err = Number($.CGCompleteDisplayConfiguration(config[0], $.kCGConfigurePermanently));
  return err === 0 ? 'ok' : 'error ' + err;
}`;

/** Runs {@link MAC_DISPLAY_JXA} (`$1` the script, `$2` the size). */
export const MAC_DISPLAY_SCRIPT = `exec osascript -l JavaScript -e "$1" "$2"`;

/** Arguments of {@link MAC_SETUP_SCRIPT}: `<share> <host path>` per Vault folder. */
export function macSetupArgs(links: readonly MacShareLink[]): string[] {
  return links.flatMap((l) => (l.guestPath ? [l.share.name, l.guestPath] : []));
}

/** What the setup script printed: its warnings, and whether it finished. */
export function parseSetupOutput(stdout: string): { ok: boolean; warnings: string[]; error: string | null } {
  const lines = stdout.split('\n').map((l) => l.trim());
  return {
    ok: lines.includes('MVOK'),
    warnings: lines.filter((l) => l.startsWith('MVWARN ')).map((l) => l.slice(7)),
    error: lines.find((l) => l.startsWith('MVERR '))?.slice(6) ?? null,
  };
}

/**
 * Refreshes the guest's view of host edits (S6: AppleVirtIOFS caches them). `purge` drops cached file data (in-place
 * rewrites); an unmount + `mount_virtiofs` also drops cached names (rename-replaced files), but only when nothing holds
 * the share busy. Shares found unmounted (a remount that failed before) are mounted again, so one failure never leaves
 * the Vault gone for the rest of the run. Prints `remounted`, `purged` or `MVERR …`.
 */
export const MAC_REFRESH_SCRIPT = `M=${JSON.stringify(MAC_SHARE_ROOT)}
mounted() { mount | grep -qF " on $M ("; }
sudo -n purge 2>/dev/null
if mounted && ! sudo -n umount "$M" 2>/dev/null; then echo purged; exit 0; fi
sudo -n mkdir -p "$M"
mounted || sudo -n mount_virtiofs -u "$(id -u)" -g "$(id -g)" com.apple.virtio-fs.automount "$M" 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do [ -d "$M/setup" ] && break; sleep 0.2; done
if [ -d "$M/setup" ]; then echo remounted; else echo "MVERR the shares did not come back"; fi`;
