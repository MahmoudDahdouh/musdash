#!/usr/bin/env bash
#
# musdash installer. One command on a fresh Ubuntu host, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/MahmoudDahdouh/musdash/main/scripts/install.sh | bash
#
# Installs Docker, the build tools, and Bun; fetches the source; compiles the
# binary ON THIS HOST; installs a systemd unit. No build machine, no release
# artifact, no DNS required.
#
# Options (env vars):
#   MUSDASH_REPO=<git url>        source to build from
#   MUSDASH_REF=<branch|tag|sha>  what to check out (default: main)
#   MUSDASH_DASHBOARD_HOST=<fqdn> serve the dashboard on a domain, with HTTPS
#   MUSDASH_SRC=<path>            build from a local checkout instead of cloning
set -euo pipefail

MUSDASH_USER="${MUSDASH_USER:-musdash}"
MUSDASH_REPO="${MUSDASH_REPO:-https://github.com/MahmoudDahdouh/musdash.git}"
MUSDASH_REF="${MUSDASH_REF:-main}"
# Where the source is compiled. Kept out of INSTALL_DIR so the toolchain and
# node_modules are never mistaken for runtime state worth backing up.
SRC_DIR="${MUSDASH_SRC:-/opt/musdash-src}"
BUN_INSTALL="${BUN_INSTALL:-/usr/local}"
INSTALL_DIR="${INSTALL_DIR:-/opt/musdash}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
NETWORK="${MUSDASH_NETWORK:-musdash}"
PORT="${MUSDASH_PORT:-8000}"
# Pinned, and kept in step with src/build/bootstrap.ts: buildctl is copied out
# of this exact image, so a mismatch here is a client/daemon version skew.
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:v0.27.0}"
RAILPACK_VERSION="${RAILPACK_VERSION:-v0.37.0}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# The install is long and noisy; the URL at the end is the one line that
# matters, so it gets a name above it and a box around it rather than
# scrolling past as more log output.
banner() {
  printf '\033[1;36m'
  cat <<'ART'
 __  __ _   _ ____  ____    _    ____  _   _
|  \/  | | | / ___||  _ \  / \  / ___|| | | |
| |\/| | | | \___ \| | | |/ _ \ \___ \| |_| |
| |  | | |_| |___) | |_| / ___ \ ___) |  _  |
|_|  |_|\___/|____/|____/_/   \_\____/|_| |_|
ART
  printf '\033[0m'
}

frame() {
  local line width=0 bar
  for line in "$@"; do
    if [ "${#line}" -gt "$width" ]; then width=${#line}; fi
  done
  bar=$(printf '%*s' "$((width + 2))" '')
  bar=${bar// /─}
  printf '\033[1;36m┌%s┐\033[0m\n' "$bar"
  for line in "$@"; do
    printf '\033[1;36m│\033[0m %s%*s \033[1;36m│\033[0m\n' "$line" "$((width - ${#line}))" ''
  done
  printf '\033[1;36m└%s┘\033[0m\n' "$bar"
}

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
# Both are external binaries musdash shells out to (DECISIONS: shell out, never
# reimplement). Installed here rather than at first build so a missing one is a
# clear install-time failure instead of a cryptic ENOENT inside a deploy.
#
# buildctl is copied out of the BuildKit image musdash already runs, which keeps
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
if ! id "$MUSDASH_USER" >/dev/null 2>&1; then
  log "Creating system user $MUSDASH_USER"
  useradd --system --create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$MUSDASH_USER"
fi
usermod -aG docker "$MUSDASH_USER"
install -d -o "$MUSDASH_USER" -g "$MUSDASH_USER" -m 0750 "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/logs"

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
# The container itself is created by musdash on first boot, not here: one code
# path that also re-creates the proxy if it is ever removed, instead of a second
# definition in shell that only runs at install time and silently drifts.
docker volume create musdash-caddy-data >/dev/null
docker volume create musdash-caddy-config >/dev/null
log "Caddy volumes ready; musdash starts Caddy on first boot"

# -------------------------------------------------------------- toolchain
# Bun compiles the binary. Installed to /usr/local so root and the service user
# see the same one; the upstream script honours BUN_INSTALL for exactly this.
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun"
  command -v unzip >/dev/null 2>&1 || {
    apt-get update -qq && apt-get install -y -qq unzip >/dev/null
  }
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$BUN_INSTALL" bash >/dev/null
fi
BUN_BIN="$(command -v bun || echo "$BUN_INSTALL/bin/bun")"
[ -x "$BUN_BIN" ] || die "bun was installed but is not executable at $BUN_BIN"
log "Bun ready: $($BUN_BIN --version)"

command -v git >/dev/null 2>&1 || {
  log "Installing git"
  apt-get update -qq && apt-get install -y -qq git >/dev/null
}

# ------------------------------------------------------------------ source
# A local checkout wins over cloning: it is how an operator installs a working
# copy they have already modified, and how this script is tested.
if [ -f "./package.json" ] && [ -d "./src" ]; then
  log "Building from the current directory"
  SRC_DIR="$(pwd)"
elif [ -d "$SRC_DIR/.git" ]; then
  log "Updating the source in $SRC_DIR"
  git -C "$SRC_DIR" fetch --depth=1 origin "$MUSDASH_REF"
  git -C "$SRC_DIR" checkout -q FETCH_HEAD
else
  log "Cloning $MUSDASH_REPO ($MUSDASH_REF)"
  rm -rf "$SRC_DIR"
  git clone --depth=1 --branch "$MUSDASH_REF" "$MUSDASH_REPO" "$SRC_DIR" 2>/dev/null     || die "could not clone $MUSDASH_REPO. If it is private, clone it yourself and re-run this script from inside the checkout."
fi

# ----------------------------------------------------------------- binary
# Compiled here rather than shipped as a release artifact: it needs no published
# build, works from a private repo, and guarantees the binary matches this host's
# libc. Costs about a minute.
log "Building the binary (this takes ~60s)"
cd "$SRC_DIR"
"$BUN_BIN" install --frozen-lockfile >/dev/null 2>&1 || "$BUN_BIN" install >/dev/null
"$BUN_BIN" run build >/dev/null

[ -f "$SRC_DIR/dist/musdash" ] || die "the build produced no dist/musdash"
# Stop before overwriting: replacing the binary under a running process is what
# leaves a half-upgraded service that restarts into the old code.
systemctl stop musdash >/dev/null 2>&1 || true
install -o "$MUSDASH_USER" -g "$MUSDASH_USER" -m 0755 "$SRC_DIR/dist/musdash" "$INSTALL_DIR/musdash"
log "Installed $INSTALL_DIR/musdash"

# --------------------------------------------------------------- env file
ENV_FILE="$INSTALL_DIR/musdash.env"
# Optional here: the dashboard address is set from the Settings page once
# musdash is up. This only pre-seeds it for an unattended install.
if [ -n "${MUSDASH_DASHBOARD_HOST:-}" ]; then
  DASHBOARD_HOST_LINE="MUSDASH_DASHBOARD_HOST=$MUSDASH_DASHBOARD_HOST"
else
  DASHBOARD_HOST_LINE="#MUSDASH_DASHBOARD_HOST=mus.example.com"
fi

if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
MUSDASH_PORT=$PORT
MUSDASH_DATA_DIR=$DATA_DIR
MUSDASH_NETWORK=$NETWORK
MUSDASH_CADDY_ADMIN=http://127.0.0.1:2019

# --- Dashboard address -------------------------------------------------
# SET THIS FROM THE SETTINGS PAGE, not here. The value below is only a seed for
# an unattended install; once you save a hostname in the dashboard, that wins
# and this line is ignored.
#
# Unset, the dashboard answers on this host's bare IP over HTTP, which is the
# only address a box without DNS has. Until a hostname is set, two things are
# true and neither is a bug:
#   - the admin session cookie travels in plaintext (no cert exists for an IP)
#   - GitHub cannot be connected; its App requires a public HTTPS URL
${DASHBOARD_HOST_LINE}

# Point a wildcard A record (*.example.com) at this host to get automatic
# HTTPS subdomains for every resource. Optional: without it, resources have no
# auto-subdomain and you attach real domains on each resource's Domains tab.
#MUSDASH_WILDCARD_DOMAIN=mus.example.com
# Not needed to connect GitHub: the App's redirect and webhook URLs are derived
# from the dashboard host above. Set this only when something else fronts
# musdash on a different name, such as a tunnel or an external load balancer.
#MUSDASH_PUBLIC_URL=https://mus.example.com
#MUSDASH_ACME_EMAIL=you@example.com

# Staging is the safe default. Production issuance is rate limited to 50
# certificates per registered domain per week, so switch it off deliberately.
MUSDASH_ACME_STAGING=false

MUSDASH_DEFAULT_MEMORY_MB=512
MUSDASH_HEALTH_TIMEOUT_SEC=60
MUSDASH_LOG_LEVEL=info
NODE_ENV=production
EOF
  chown "$MUSDASH_USER:$MUSDASH_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

# ---------------------------------------------------------------- systemd
log "Installing the systemd unit"
cat > /etc/systemd/system/musdash.service <<EOF
[Unit]
Description=musdash
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$MUSDASH_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_DIR/musdash
Restart=always
RestartSec=3
# The reconciler heals drift on boot, so an unattended restart is safe.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# --------------------------------------------------------------- firewall
# The dashboard binds every interface, because Caddy is in a container and dials
# the host through its bridge address — a socket on 127.0.0.1 cannot accept that
# connection. So the firewall, not the bind address, is what keeps the port off
# the internet. This is only meaningful when ufw is actually enabled; on a box
# with no firewall the port is open either way, which is worth knowing.
if command -v ufw >/dev/null 2>&1; then
  log "Allowing the proxy to reach the dashboard, and denying everyone else"
  ufw allow in on docker0 to any port "$PORT" proto tcp >/dev/null 2>&1 || true
  BRIDGE_ID=$(docker network inspect "$NETWORK" -f '{{.Id}}' 2>/dev/null | cut -c1-12)
  if [ -n "$BRIDGE_ID" ]; then
    ufw allow in on "br-$BRIDGE_ID" to any port "$PORT" proto tcp >/dev/null 2>&1 || true
  fi
  ufw deny "$PORT/tcp" >/dev/null 2>&1 || true
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    log "ufw is installed but inactive — port $PORT is reachable from anywhere"
  fi
else
  log "No ufw here; port $PORT is reachable from anywhere. Firewall it."
fi

systemctl daemon-reload
systemctl enable --now musdash

# Caddy is started by musdash on first boot, via the queue, so port 80 is not
# serving the instant the unit goes active. Give it a moment before printing a
# URL that tells the operator to open it.
sleep 5
if systemctl is-active --quiet musdash; then
  IP=$(hostname -I | awk '{print $1}')
  log "musdash is running"
  echo
  banner
  echo
  if [ -n "${MUSDASH_DASHBOARD_HOST:-}" ]; then
    frame "Open https://$MUSDASH_DASHBOARD_HOST to create your admin account."
    echo "  (If the certificate is not ready yet, give Caddy a few seconds.)"
  else
    frame "Open http://$IP to create your admin account."
    echo
    echo "  That is plain HTTP: no certificate authority issues for an IP."
    echo "  Once you point a domain here, open Settings in the dashboard and"
    echo "  enter it under Dashboard address. HTTPS follows within seconds,"
    echo "  no restart and no SSH — and this address keeps working as a"
    echo "  fallback if DNS or the certificate ever breaks."
  fi
  echo
  echo "  Logs: journalctl -u musdash -f"
else
  die "musdash failed to start — check: journalctl -u musdash -n 50"
fi
