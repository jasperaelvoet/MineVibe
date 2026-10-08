#!/bin/sh
# S5 step 6f: named volume persistence across stop/start and across delete + re-run ("recreate keeps volumes"),
# plus a named-volume overlay for <vault>/node_modules nested inside the path-identical bind mount.
set -u
cd "$(dirname "$0")"
V="$PWD/out/vault"
C=./ct.sh
ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

echo "== write marker into /home/cua (as cua)"
$C 30 exec --user cua mv-pc-s5 sh -c 'echo "persist $(date +%s)" > /home/cua/persist.txt; cat /home/cua/persist.txt'

echo "== stop / start"
t=$(ms); $C 60 stop mv-pc-s5; echo "stop_ms=$(( $(ms)-t ))"
t=$(ms); $C 120 start mv-pc-s5; echo "start_ms=$(( $(ms)-t ))"
node src/boot.mjs --no-run | grep -E 'SERVING|first answered'
$C 30 exec --user cua mv-pc-s5 cat /home/cua/persist.txt && echo "PASS marker survives stop/start"

echo "== delete + re-run with the same home volume (+ node_modules overlay volume)"
t=$(ms); $C 60 stop mv-pc-s5; $C 60 delete mv-pc-s5; echo "stop+delete_ms=$(( $(ms)-t ))"
# seed the overlay volume for uid 1000 (fresh named volumes are root-owned and empty)
t=$(ms); $C 120 run --rm --name mv-pc-s5-seed-nm -v mv-pc-s5-nm:/mnt/nm ghcr.io/trycua/linux:24.04 sh -c 'rm -rf /mnt/nm/lost+found; chown 1000:1000 /mnt/nm' 2>&1 | grep -v '^\['; echo "seed_nm_ms=$(( $(ms)-t ))"
node src/boot.mjs --extra "-v mv-pc-s5-nm:$V/node_modules" | grep -E 'run:|SERVING|first answered' | cut -c1-200
$C 30 exec --user cua mv-pc-s5 cat /home/cua/persist.txt && echo "PASS marker survives delete + re-run"

echo "== node_modules overlay"
$C 30 exec --user cua mv-pc-s5 sh -c "mount | grep -E 'node_modules|vault'; stat -c '%u:%g %a %n' $V/node_modules; echo linux-artifact > $V/node_modules/built.txt && echo overlay_write_ok; ls -la $V/node_modules"
echo "-- host view of $V/node_modules:"; ls -la "$V/node_modules" 2>&1
