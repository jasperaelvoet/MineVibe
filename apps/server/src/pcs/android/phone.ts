/**
 * What PcManager runs inside a PC (as root, `container exec`) to connect it to its Android phone (PLAN §8.7). The
 * phone gets a new address on the PC's network every start and container names do not resolve there, so the PC
 * learns it as `android-phone` in /etc/hosts (vminitd writes that file at every start) and in
 * /etc/minevibe/android-phone. The `android` helper (images/linux-pc/android) reads either.
 */

/** `$1` = the phone's IPv4 address, `$2` = the `android` helper script in base64 ("" keeps the image's own). */
export const LINK_PHONE_SCRIPT = `set -eu
ip="$1"
case "$ip" in *[!0-9.]*|'') echo "bad address" >&2; exit 2 ;; esac
tmp="$(mktemp)"
grep -v '[[:space:]]android-phone$' /etc/hosts > "$tmp" || true
printf '%s\\tandroid-phone\\n' "$ip" >> "$tmp"
cat "$tmp" > /etc/hosts
rm -f "$tmp"
mkdir -p /etc/minevibe
printf '%s\\n' "$ip" > /etc/minevibe/android-phone
chmod 0644 /etc/minevibe/android-phone
if [ -n "\${2:-}" ]; then
  printf '%s' "$2" | base64 -d > /usr/local/bin/android.new
  chmod 0755 /usr/local/bin/android.new
  mv -f /usr/local/bin/android.new /usr/local/bin/android
fi
`;

/**
 * Nested virtualization: the kernel creates /dev/kvm as root-only (`crw------- root root`, measured), so the guest user
 * an agent runs as could not use it. The PC is single-tenant, so it is opened to everyone, as CI runners do.
 */
export const OPEN_KVM_SCRIPT = `[ -c /dev/kvm ] || { echo "no /dev/kvm" >&2; exit 3; }
chmod 0666 /dev/kvm
`;

/** Forgets the phone (it was turned off while the PC runs). */
export const UNLINK_PHONE_SCRIPT = `set -eu
tmp="$(mktemp)"
grep -v '[[:space:]]android-phone$' /etc/hosts > "$tmp" || true
cat "$tmp" > /etc/hosts
rm -f "$tmp" /etc/minevibe/android-phone
`;
