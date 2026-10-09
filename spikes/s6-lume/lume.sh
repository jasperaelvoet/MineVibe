#!/bin/bash
# Spike S6: runs MineVibe's dev Lume (never a user-installed one) with telemetry and update checks off and its
# config, caches and temp files under MineVibe-dev/lume (PLAN §8.6: outside ~/Documents).
set -euo pipefail
ROOT="$HOME/Library/Application Support/MineVibe-dev/lume"
export LUME_TELEMETRY_ENABLED=0 LUME_UPDATE_CHECK=0
export XDG_CONFIG_HOME="$ROOT/config" XDG_CACHE_HOME="$ROOT/xdg-cache" TMPDIR="$ROOT/tmp/"
exec "$ROOT/install/0.6.1/lume.app/Contents/MacOS/lume" "$@"
