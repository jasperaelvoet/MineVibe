#!/bin/sh
# MineVibe boot hook (PLAN §8.6). Runs as root as the container's init process, then execs cua's entrypoint.
#
# 1. Seeds /home/cua from /opt/minevibe/skel-home when the home volume is empty (a fresh Apple container
#    named volume is an empty, root-owned ext4 with only lost+found).
# 2. chowns 1000:1000 the home and every build-dir overlay listed in MV_CHOWN_PATHS (colon-separated
#    absolute paths, e.g. /Users/me/Code/foo/node_modules). Only named-volume mount points are touched,
#    never a host bind mount and never recursively.
set -u

SKEL=/opt/minevibe/skel-home
HOME_DIR=/home/cua
CUA_ENTRYPOINT=/opt/cua/desktop/entrypoint.sh
CUA_UID=1000
CUA_GID=1000

log() { echo "minevibe-entrypoint: $*" >&2; }

# True when the directory holds nothing but (possibly) lost+found.
only_lost_and_found() {
  [ -d "$1" ] || return 1
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "$entry" = "$1/lost+found" ] && continue
    return 1
  done
  return 0
}

fs_type() { findmnt -n -o FSTYPE --mountpoint "$1" 2>/dev/null | head -n 1; }

# --- 1. home ---------------------------------------------------------------------------------------------
mkdir -p "$HOME_DIR"
if only_lost_and_found "$HOME_DIR"; then
  log "seeding $HOME_DIR from $SKEL"
  rmdir "$HOME_DIR/lost+found" 2>/dev/null || true
  if cp -a "$SKEL/." "$HOME_DIR/"; then
    chown -R "$CUA_UID:$CUA_GID" "$HOME_DIR"
  else
    log "seeding $HOME_DIR failed"
  fi
else
  # An already-seeded volume may still carry an empty lost+found from mkfs.
  rmdir "$HOME_DIR/lost+found" 2>/dev/null || true
fi
chown "$CUA_UID:$CUA_GID" "$HOME_DIR" || log "chown $HOME_DIR failed"
chmod 0750 "$HOME_DIR" 2>/dev/null || true

# --- 2. build-dir overlays -------------------------------------------------------------------------------
if [ -n "${MV_CHOWN_PATHS:-}" ]; then
  old_ifs=$IFS
  IFS=':'
  for p in $MV_CHOWN_PATHS; do
    IFS=$old_ifs
    case "$p" in
      /*) ;;
      *) log "skip $p: not absolute"; continue ;;
    esac
    case "$p" in
      */../* | */.. | */./* | */. | / ) log "skip $p: not a normalized path"; continue ;;
    esac
    if ! mountpoint -q "$p" 2>/dev/null; then
      log "skip $p: not a mount point"
      continue
    fi
    t=$(fs_type "$p")
    case "$t" in
      ext4 | ext3 | ext2 | xfs | btrfs | tmpfs) ;;
      *) log "skip $p: filesystem '$t' is not a named volume"; continue ;;
    esac
    rmdir "$p/lost+found" 2>/dev/null || true
    chown "$CUA_UID:$CUA_GID" "$p" || log "chown $p failed"
  done
  IFS=$old_ifs
fi
unset MV_CHOWN_PATHS

exec "$CUA_ENTRYPOINT" "$@"
