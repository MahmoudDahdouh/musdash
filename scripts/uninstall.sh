#!/usr/bin/env bash
#
# musdash uninstaller. Removes what install.sh and musdash itself created, so
# the next install.sh starts from scratch. As root:
#
#   curl -fsSL https://raw.githubusercontent.com/MahmoudDahdouh/musdash/main/scripts/uninstall.sh | bash
#
# DESTRUCTIVE: the database and secret.key go with it, so every project,
# deployment and encrypted env var is gone. Back up /opt/musdash/data first if
# any of it matters.
#
# Keeps Docker itself, and by default the Caddy certificate volumes (a
# reinstall reuses them instead of re-issuing against Let's Encrypt's rate
# limit) and the tools install.sh reuses when present (bun, buildctl, railpack).
#
# Options (env vars):
#   MUSDASH_UNINSTALL_YES=1  skip the confirmation prompt
#   MUSDASH_PURGE=1          also remove the certificate volumes, bun, buildctl,
#                            railpack, and the Caddy and BuildKit images
#   INSTALL_DIR, MUSDASH_SRC, MUSDASH_USER  as given to install.sh
set -euo pipefail

MUSDASH_USER="${MUSDASH_USER:-musdash}"
SRC_DIR="${MUSDASH_SRC:-/opt/musdash-src}"
BUN_INSTALL="${BUN_INSTALL:-/usr/local}"
INSTALL_DIR="${INSTALL_DIR:-/opt/musdash}"
ENV_FILE="$INSTALL_DIR/musdash.env"
UNIT_FILE=/etc/systemd/system/musdash.service
SWAP_FILE=/musdash.swap
PURGE="${MUSDASH_PURGE:-0}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo)"

# The env file is the record of what this host was actually configured with;
# the defaults match install.sh for a host where it is already gone.
env_value() {
  awk -F= -v key="$1" '{ k = $1; gsub(/[ \t]/, "", k) } k == key { v = $2; gsub(/[ \t"\047\r]/, "", v); p = v } END { print p }' "$ENV_FILE" 2>/dev/null || true
}
PORT=$(env_value MUSDASH_PORT)
PORT="${PORT:-8000}"
DATA_DIR=$(env_value MUSDASH_DATA_DIR)
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
NETWORK=$(env_value MUSDASH_NETWORK)
NETWORK="${NETWORK:-${MUSDASH_NETWORK:-musdash}}"

# ---------------------------------------------------------------- confirm
# Under `curl | bash` stdin is the script itself, so the answer is read from
# the terminal. Typing the hostname, not "y", because this is the one command
# that cannot be undone and muscle memory should not be enough.
HOST=$(hostname)
if [ "${MUSDASH_UNINSTALL_YES:-0}" != "1" ]; then
  [ -r /dev/tty ] || die "no terminal to confirm on; re-run with MUSDASH_UNINSTALL_YES=1"
  echo "This deletes musdash from $HOST: every app it deployed, the database,"
  echo "secret.key (so every encrypted env var), $INSTALL_DIR and $SRC_DIR."
  if [ "$PURGE" = "1" ]; then
    echo "MUSDASH_PURGE=1: the certificate volumes, bun, buildctl and railpack go too."
  fi
  printf 'Type the hostname (%s) to continue: ' "$HOST"
  read -r answer </dev/tty || die "could not read from the terminal; re-run with MUSDASH_UNINSTALL_YES=1"
  [ "$answer" = "$HOST" ] || die "hostname did not match; nothing was removed"
fi

# ---------------------------------------------------------------- service
# First, so the reconciler cannot re-create the proxy or the build daemon
# while their containers are being removed below.
if [ -f "$UNIT_FILE" ]; then
  log "Stopping and removing the musdash service"
  systemctl disable --now musdash >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  systemctl reset-failed musdash >/dev/null 2>&1 || true
fi

# ----------------------------------------------------------------- Docker
if command -v docker >/dev/null 2>&1; then
  # Every container musdash creates carries musdash.managed — apps and the
  # Caddy and BuildKit sidecars alike. -v takes their anonymous volumes too.
  ids=$(docker ps -aq --filter label=musdash.managed)
  if [ -n "$ids" ]; then
    log "Removing $(echo "$ids" | wc -l | tr -d ' ') musdash containers"
    # shellcheck disable=SC2086 # one id per word
    docker rm -fv $ids >/dev/null
  fi

  images=$(docker images --format '{{.Repository}}:{{.Tag}}' | awk -F: '$1 ~ /^musdash\//' || true)
  if [ -n "$images" ]; then
    log "Removing $(echo "$images" | wc -l | tr -d ' ') built images"
    # shellcheck disable=SC2086
    docker rmi -f $images >/dev/null 2>&1 || true
  fi

  if docker volume inspect musdash-buildkit-cache >/dev/null 2>&1; then
    log "Removing the build cache volume"
    docker volume rm musdash-buildkit-cache >/dev/null
  fi

  # The bridge id names the interface install.sh opened the port on, and it
  # is gone once the network is.
  BRIDGE_ID=$(docker network inspect "$NETWORK" -f '{{.Id}}' 2>/dev/null | cut -c1-12 || true)
  if [ -n "$BRIDGE_ID" ]; then
    log "Removing the $NETWORK network"
    docker network rm "$NETWORK" >/dev/null
  fi

  if [ "$PURGE" = "1" ]; then
    for vol in musdash-caddy-data musdash-caddy-config; do
      if docker volume inspect "$vol" >/dev/null 2>&1; then
        log "Removing $vol"
        docker volume rm "$vol" >/dev/null
      fi
    done
    for image in caddy:2-alpine $(docker images --format '{{.Repository}}:{{.Tag}}' moby/buildkit); do
      if docker rmi "$image" >/dev/null 2>&1; then log "Removed image $image"; fi
    done
  else
    log "Keeping the certificate volumes musdash-caddy-data and musdash-caddy-config (MUSDASH_PURGE=1 removes them)"
  fi
fi

# --------------------------------------------------------------- firewall
# The same three rules install.sh adds; deleting one that is absent is a no-op.
if command -v ufw >/dev/null 2>&1; then
  log "Removing musdash's firewall rules for port $PORT"
  ufw delete allow in on docker0 to any port "$PORT" proto tcp >/dev/null 2>&1 || true
  if [ -n "${BRIDGE_ID:-}" ]; then
    ufw delete allow in on "br-$BRIDGE_ID" to any port "$PORT" proto tcp >/dev/null 2>&1 || true
  fi
  ufw delete deny "$PORT/tcp" >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ files
# Refuses anything that is not an absolute path below /, so an empty or
# mistyped variable can never become `rm -rf /`.
remove_dir() {
  case "$1" in
    /?*) ;;
    *) die "refusing to remove '$1'" ;;
  esac
  if [ -e "$1" ]; then
    log "Removing $1"
    rm -rf -- "$1"
  fi
}
remove_dir "$DATA_DIR"
remove_dir "$INSTALL_DIR"
remove_dir "$SRC_DIR"

if id "$MUSDASH_USER" >/dev/null 2>&1; then
  log "Removing the $MUSDASH_USER user"
  userdel "$MUSDASH_USER" >/dev/null 2>&1 || log "Could not remove the $MUSDASH_USER user; remove it with userdel"
fi

# ------------------------------------------------------------------- swap
# Only the file install.sh made (D38); swap that was here before is not ours.
if [ -f "$SWAP_FILE" ]; then
  log "Removing the swapfile $SWAP_FILE"
  swapoff "$SWAP_FILE" >/dev/null 2>&1 || true
  awk -v f="$SWAP_FILE" '$1 != f' /etc/fstab >/etc/fstab.musdash && cat /etc/fstab.musdash >/etc/fstab
  rm -f /etc/fstab.musdash "$SWAP_FILE"
fi

# ------------------------------------------------------------------ tools
if [ "$PURGE" = "1" ]; then
  for bin in /usr/local/bin/buildctl /usr/local/bin/railpack "$BUN_INSTALL/bin/bun" "$BUN_INSTALL/bin/bunx"; do
    if [ -e "$bin" ]; then
      log "Removing $bin"
      rm -f -- "$bin"
    fi
  done
fi

echo
log "musdash is uninstalled from $HOST"
echo "  Docker is still installed. If GitHub was connected, delete its App at"
echo "  https://github.com/settings/apps — this host no longer holds its key."
