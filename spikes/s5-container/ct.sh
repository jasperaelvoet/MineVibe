#!/bin/sh
# Run the spike's Apple `container` CLI with a hard timeout (apple/container#2275 can hang forever).
# usage: ct.sh <timeout-seconds> <container args...>
# Exit 142 (SIGALRM) means the call timed out; the timeout is also logged to out/timeouts.log.
#
# Roots: the first attempt used the dev home under ~/Documents/MineVibe/.minevibe-dev and wedged:
# InternetSharing (root) cannot read container-network-vmnet inside a TCC-protected folder, so
# vmnet_network_create fails (1001) and the apiserver ping hangs. The roots therefore default to
# a folder outside ~/Documents. Override with MV_CT_INSTALL_ROOT / MV_CT_APP_ROOT.
set -u
T="$1"; shift
SP="${MV_CT_BASE:-$HOME/Library/Application Support/MineVibe-dev/container-spike}"
export CONTAINER_INSTALL_ROOT="${MV_CT_INSTALL_ROOT:-$SP/root}"
export CONTAINER_APP_ROOT="${MV_CT_APP_ROOT:-$SP/app}"
perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$T" "$CONTAINER_INSTALL_ROOT/bin/container" "$@"
rc=$?
if [ "$rc" -eq 142 ]; then
  echo "$(date -u +%FT%TZ) TIMEOUT after ${T}s: container $*" >> "$(dirname "$0")/out/timeouts.log"
  echo "ct.sh: TIMEOUT after ${T}s: container $1" >&2
fi
exit "$rc"
