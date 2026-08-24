#!/usr/bin/env bash
#
# mosdash installer. One command on a fresh Ubuntu host:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/mosdash/main/scripts/install.sh | sudo bash
#
# Installs Docker if absent, creates the mosdash network, starts Caddy, installs
# the binary and a systemd unit, and generates the secret key.
set -euo pipefail

MOSDASH_USER="${MOSDASH_USER:-mosdash}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mosdash}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
NETWORK="${MOSDASH_NETWORK:-mosdash}"
PORT="${MOSDASH_PORT:-8000}"
# Pinned, and kept in step with src/build/bootstrap.ts: buildctl is copied out
# of this exact image, so a mismatch here is a client/daemon version skew.
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:v0.27.0}"
RAILPACK_VERSION="${RAILPACK_VERSION:-v0.37.0}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo)"

# --------------------------------------------------------------- Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
else
  log "Docker already present: $(docker --version)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ------------------------------------------------------------ build tools
# Both are external binaries mosdash shells out to (DECISIONS: shell out, never
# reimplement). Installed here rather than at first build so a missing one is a
# clear install-time failure instead of a cryptic ENOENT inside a deploy.
#
# buildctl is copied out of the BuildKit image mosdash already runs, which keeps
# the client and daemon versions matched by construction and needs no second
# download.
if ! command -v buildctl >/dev/null 2>&1; then
  log "Installing buildctl from $BUILDKIT_IMAGE"
  docker pull "$BUILDKIT_IMAGE" >/dev/null
  cid=$(docker create "$BUILDKIT_IMAGE")
  docker cp "$cid:/usr/bin/buildctl" /usr/local/bin/buildctl >/dev/null
  docker rm "$cid" >/dev/null
  chmod 755 /usr/local/bin/buildctl
else
  log "buildctl already present: $(buildctl --version)"
fi

if ! command -v railpack >/dev/null 2>&1; then
  log "Installing railpack $RAILPACK_VERSION"
  rp_tmp=$(mktemp -d)
  curl -fsSL -o "$rp_tmp/rp.tar.gz" \
    "https://github.com/railwayapp/railpack/releases/download/${RAILPACK_VERSION}/railpack-${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  tar -xzf "$rp_tmp/rp.tar.gz" -C "$rp_tmp"
  install -m 755 "$rp_tmp/railpack" /usr/local/bin/railpack
  rm -rf "$rp_tmp"
else
  log "railpack already present: $(railpack --version)"
fi

# ------------------------------------------------------------ user + dirs
if ! id "$MOSDASH_USER" >/dev/null 2>&1; then
  log "Creating system user $MOSDASH_USER"
  useradd --system --create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$MOSDASH_USER"
fi
usermod -aG docker "$MOSDASH_USER"
install -d -o "$MOSDASH_USER" -g "$MOSDASH_USER" -m 0750 "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/logs"

# ---------------------------------------------------------------- network
# Must be user-defined: the default bridge provides no name resolution, and
# Caddy dials app containers by name.
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  log "Creating the $NETWORK network"
  docker network create "$NETWORK" >/dev/null
fi

# ------------------------------------------------------------------ Caddy
# Certificates and config live on named volumes. Losing the certificate store
# means re-issuing everything and burning the Let's Encrypt rate limit.
#
# The container itself is created by mosdash on first boot, not here: one code
# path that also re-creates the proxy if it is ever removed, instead of a second
# definition in shell that only runs at install time and silently drifts.
docker volume create mosdash-caddy-data >/dev/null
docker volume create mosdash-caddy-config >/dev/null
log "Caddy volumes ready; mosdash starts Caddy on first boot"

# ----------------------------------------------------------------- binary
if [ -f "./dist/mosdash" ]; then
  log "Installing the local build"
  install -o "$MOSDASH_USER" -g "$MOSDASH_USER" -m 0755 ./dist/mosdash "$INSTALL_DIR/mosdash"
elif [ -f "$INSTALL_DIR/mosdash" ]; then
  log "Reusing the existing binary"
else
  die "no ./dist/mosdash found — build it first with 'bun run build'"
fi

# --------------------------------------------------------------- env file
ENV_FILE="$INSTALL_DIR/mosdash.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
MOSDASH_PORT=$PORT
MOSDASH_DATA_DIR=$DATA_DIR
MOSDASH_NETWORK=$NETWORK
MOSDASH_CADDY_ADMIN=http://127.0.0.1:2019

# Point a wildcard A record (*.example.com) at this host to get automatic
# HTTPS subdomains for every resource.
#MOSDASH_WILDCARD_DOMAIN=mos.example.com
#MOSDASH_ACME_EMAIL=you@example.com

# Staging is the safe default. Production issuance is rate limited to 50
# certificates per registered domain per week, so switch it off deliberately.
MOSDASH_ACME_STAGING=false

MOSDASH_DEFAULT_MEMORY_MB=512
MOSDASH_HEALTH_TIMEOUT_SEC=60
MOSDASH_LOG_LEVEL=info
NODE_ENV=production
EOF
  chown "$MOSDASH_USER:$MOSDASH_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

# ---------------------------------------------------------------- systemd
log "Installing the systemd unit"
cat > /etc/systemd/system/mosdash.service <<EOF
[Unit]
Description=mosdash
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$MOSDASH_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_DIR/mosdash
Restart=always
RestartSec=3
# The reconciler heals drift on boot, so an unattended restart is safe.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mosdash

sleep 2
if systemctl is-active --quiet mosdash; then
  IP=$(hostname -I | awk '{print $1}')
  log "mosdash is running"
  echo
  echo "  Open http://$IP:$PORT to create your admin account."
  echo "  After that it binds to 127.0.0.1 and is reached through Caddy."
  echo
  echo "  Edit $ENV_FILE to set your wildcard domain and ACME email,"
  echo "  then: systemctl restart mosdash"
else
  die "mosdash failed to start — check: journalctl -u mosdash -n 50"
fi
