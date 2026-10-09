/**
 * What a PC can run, in words (PLAN §8.7): the KICKOFF's one capability line and `pc__info`'s capability section.
 * Built from Node-controlled values only (the PC manager's settings and the guest probe's numbers and tool versions).
 *
 * The point is the live-play failure these came from: a desk agent asked to run an Android game declared it
 * impossible, scanned the PC's network for "your Mac or an Intel PC" and gave up. The lines therefore say what the PC
 * is (arm64, isolated), what the player can switch on (with the exact setting), and the one route that works.
 */

import type { PcGuestCapabilities, PcGuestInfo } from '../../contracts/PcApi.js';

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;

/** The command a seated agent runs an APK with (images/linux-pc/android). */
export const ANDROID_USAGE = 'android install <file.apk> && android open';

function where(pc: Pick<PcGuestInfo, 'pcId'>, player: string): string {
  return `${player} can turn it on in ${pc.pcId}'s settings (the config screen of its workstation)`;
}

/** "KVM …" in a few words: on, off (and who can turn it on), or not on this Mac. */
function kvmText(c: PcGuestCapabilities, pc: Pick<PcGuestInfo, 'pcId'>, player: string): string {
  const v = c.virtualization;
  if (v.unavailable) return `no KVM (nested virtualization: not on this Mac, ${v.unavailable})`;
  if (v.enabled) {
    return c.kvm === false
      ? 'nested virtualization is on but /dev/kvm is missing (restart the PC)'
      : 'KVM yes (nested virtualization on)';
  }
  return `no KVM (nested virtualization is off; ${where(pc, player)})`;
}

/** The Android phone in a few words. */
function phoneText(c: PcGuestCapabilities, pc: Pick<PcGuestInfo, 'pcId'>, player: string): string {
  const a = c.android;
  if (!a.enabled) {
    return a.unavailable
      ? `Android phone: not on this Mac (${a.unavailable})`
      : `Android phone: off (${where(pc, player)}; then \`${ANDROID_USAGE}\`)`;
  }
  switch (a.status) {
    case 'running':
      return `Android phone: running as ${a.host ?? 'android-phone'} (\`${ANDROID_USAGE}\`)`;
    case 'preparing':
    case 'starting':
      return `Android phone: ${a.status}${a.detail ? ` (${a.detail})` : ''}; \`android status\` says when it is ready`;
    case 'error':
      return `Android phone: failed (${a.detail ?? 'unknown'}); tell ${player}`;
    default:
      return 'Android phone: on, starts with the PC';
  }
}

/** The KICKOFF's capability line (≈60 tokens): one mention of the settings for whatever the player can turn on. */
export function capabilityLine(pc: PcGuestInfo, player: string): string | null {
  const c = pc.capabilities;
  if (!c) return null;
  const hw = [
    c.arch ? `${c.arch === 'aarch64' ? 'arm64' : c.arch} Linux` : 'arm64 Linux',
    c.cpus !== null ? `${c.cpus} vCPUs` : null,
    c.memoryMiB !== null ? `${gib(c.memoryMiB)} RAM` : null,
    c.diskFreeGiB !== null ? `${c.diskFreeGiB.toFixed(0)} GiB free` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const kvmOff = !c.virtualization.enabled && !c.virtualization.unavailable;
  const phoneOff = !c.android.enabled && !c.android.unavailable;
  const settings = `${player} can turn ${kvmOff && phoneOff ? 'either' : 'it'} on in ${pc.pcId}'s settings`;
  const apks = `APKs then run with \`${ANDROID_USAGE}\``;
  let switches: string;
  if (kvmOff && phoneOff) switches = `no KVM and no Android phone: ${settings} (${apks})`;
  else if (kvmOff) switches = `no KVM (${settings}); ${phoneText(c, pc, player)}`;
  else if (phoneOff) switches = `${kvmText(c, pc, player)}; no Android phone (${settings}; ${apks})`;
  else switches = `${kvmText(c, pc, player)}; ${phoneText(c, pc, player)}`;
  return `This PC: ${hw}; internet yes, the Mac, other PCs and the LAN off-limits; ${switches}.`;
}

/** `pc__info`'s capability section: one fact per line. */
export function capabilityDetails(pc: PcGuestInfo, player: string): string[] {
  const c = pc.capabilities;
  if (!c) return [];
  const hw = [
    `CPU ${c.arch ?? 'arm64'} (Apple silicon: arm64 binaries only)`,
    c.kernel ? `kernel ${c.kernel}` : null,
    c.cpus !== null ? `${c.cpus} vCPUs` : null,
    c.memoryMiB !== null ? `${gib(c.memoryMiB)} RAM` : null,
    c.diskFreeGiB !== null ? `${c.diskFreeGiB.toFixed(1)} GiB free in ${pc.home}` : null,
  ].filter(Boolean);
  return [
    'Capabilities:',
    `- ${hw.join(', ')}`,
    "- Network: internet yes. The Mac, other PCs and the local network are off-limits by design: this PC's own network holds only it (and its Android phone), and other PCs cannot be reached. Don't scan for machines (scans are refused).",
    `- ${kvmText(c, pc, player)}.`,
    `- ${phoneText(c, pc, player)}. There is no Android SDK emulator for arm64 Linux; the Android phone is the way to run APKs (64-bit arm64 apps, no Google Play services).`,
    `- Toolchains: ${c.toolchains.length > 0 ? c.toolchains.join(', ') : 'unknown (the PC is not running)'}`,
  ];
}
