#!/usr/bin/env bash
# OpenVPS installer for Ubuntu 24.04 LTS (x86-64).
#
#   curl -fsSL https://raw.githubusercontent.com/delowardhushor/openvps/main/scripts/install.sh -o install.sh
#   less install.sh            # read it first: it runs as root
#   sudo bash install.sh
#
# What it changes (and nothing else):
#   - creates the system user "openvps"
#   - /opt/openvps          application releases and a private Node.js runtime
#   - /etc/openvps          config.json and a self-signed TLS certificate
#   - /var/lib/openvps      database and runtime data
#   - /etc/systemd/system/openvps.service, /usr/local/bin/openvps
#   - optionally one ufw rule for the panel port (--open-firewall)
# It does not modify Nginx, PM2, any system Node.js, or existing firewall policy.
#
# This file is also sourced by upgrade.sh for its helper functions.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Defaults (override with flags or environment variables)
# ---------------------------------------------------------------------------
OPENVPS_REPO="${OPENVPS_REPO:-delowardhushor/openvps}"
OPENVPS_VERSION="${OPENVPS_VERSION:-latest}"
NODE_MAJOR="${OPENVPS_NODE_MAJOR:-24}"
NODE_MIN="22.13.0"
PORT="${OPENVPS_PORT:-7443}"

PREFIX=/opt/openvps
ETC=/etc/openvps
DATA=/var/lib/openvps
UNIT=/etc/systemd/system/openvps.service
BIN=/usr/local/bin/openvps
SVC_USER=openvps

SUPPORTED_IDS="ubuntu"
SUPPORTED_VERSIONS="24.04"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_B=$'\e[1m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_D=$'\e[2m' C_0=$'\e[0m'
else
  C_B='' C_G='' C_Y='' C_R='' C_D='' C_0=''
fi
info() { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; }
ok()   { printf ' %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf ' %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

confirm() {
  # $1 = question. Honors ASSUME_YES. Reads from the terminal even when piped.
  [[ "${ASSUME_YES:-0}" == 1 ]] && return 0
  local reply
  if [[ -r /dev/tty ]]; then
    read -r -p "$1 [y/N] " reply </dev/tty || return 1
  else
    die "No terminal to confirm on. Re-run with --yes to accept."
  fi
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

version_ge() { # version_ge A B  -> true if A >= B
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
detect_platform() {
  OS_ID="" OS_VERSION="" OS_PRETTY=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}" OS_VERSION="${VERSION_ID:-}" OS_PRETTY="${PRETTY_NAME:-}"
  fi
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) ARCH="$(uname -m)" ;;
  esac
}

# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------
fetch() { # fetch URL DEST
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$2" "$1"
}

resolve_version() {
  if [[ "$OPENVPS_VERSION" == latest ]]; then
    local json
    json="$(curl -fsSL --proto '=https' "https://api.github.com/repos/${OPENVPS_REPO}/releases/latest")" ||
      die "Could not query the latest release of ${OPENVPS_REPO}. Use --version or --package."
    OPENVPS_VERSION="$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
    [[ -n "$OPENVPS_VERSION" ]] || die "Could not determine the latest version."
  fi
  OPENVPS_VERSION="${OPENVPS_VERSION#v}"
  [[ "$OPENVPS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || die "Invalid version: $OPENVPS_VERSION"
}

# Produces $WORK/pkg/openvps-<version>/ from a release tarball (downloaded or local).
obtain_package() {
  local tarball
  mkdir -p "$WORK/pkg"
  if [[ -n "${PACKAGE:-}" ]]; then
    [[ -f "$PACKAGE" ]] || die "Package not found: $PACKAGE"
    tarball="$PACKAGE"
    if [[ -f "$PACKAGE.sha256" ]]; then
      (cd "$(dirname "$PACKAGE")" && sha256sum -c --quiet "$(basename "$PACKAGE").sha256") || die "Checksum mismatch for $PACKAGE"
      ok "Verified package checksum"
    else
      warn "No $PACKAGE.sha256 next to the package; skipping checksum verification"
    fi
  else
    resolve_version
    local name="openvps-${OPENVPS_VERSION}.tar.gz"
    local base="https://github.com/${OPENVPS_REPO}/releases/download/v${OPENVPS_VERSION}"
    info "Downloading OpenVPS ${OPENVPS_VERSION}"
    fetch "$base/$name" "$WORK/$name" || die "Download failed: $base/$name"
    fetch "$base/$name.sha256" "$WORK/$name.sha256" || die "Checksum file missing: $base/$name.sha256"
    (cd "$WORK" && sha256sum -c --quiet "$name.sha256") || die "Checksum mismatch: the download is corrupt or was tampered with"
    ok "Verified package checksum"
    tarball="$WORK/$name"
  fi
  tar -xzf "$tarball" -C "$WORK/pkg" --no-same-owner
  PKG_DIR="$(find "$WORK/pkg" -mindepth 1 -maxdepth 1 -type d -name 'openvps-*' | head -n1)"
  [[ -n "$PKG_DIR" && -f "$PKG_DIR/VERSION" && -f "$PKG_DIR/server/dist/main.js" && -f "$PKG_DIR/web/dist/index.html" ]] ||
    die "The package does not look like an OpenVPS release."
  PKG_VERSION="$(tr -d '[:space:]' <"$PKG_DIR/VERSION")"
  [[ "$PKG_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "Package has an invalid VERSION file."
}

# Installs a private Node.js runtime into /opt/openvps/node-<version> and points
# /opt/openvps/node at it. Never touches a system-wide Node.js installation.
ensure_node() {
  local current=""
  if [[ -x "$PREFIX/node/bin/node" ]]; then
    current="$("$PREFIX/node/bin/node" -v 2>/dev/null | sed 's/^v//')" || current=""
  fi
  if [[ -n "$current" ]] && version_ge "$current" "$NODE_MIN"; then
    ok "Node.js runtime $current already present"
    return 0
  fi
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  info "Installing private Node.js ${NODE_MAJOR}.x runtime"
  fetch "$base/SHASUMS256.txt" "$WORK/SHASUMS256.txt" || die "Could not reach nodejs.org"
  local file
  file="$(grep -oE "node-v[0-9.]+-linux-${ARCH}\.tar\.xz" "$WORK/SHASUMS256.txt" | head -n1)"
  [[ -n "$file" ]] || die "No Node.js build for linux-${ARCH}"
  fetch "$base/$file" "$WORK/$file" || die "Node.js download failed"
  (cd "$WORK" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node.js checksum mismatch"
  local ver="${file#node-v}"
  ver="${ver%%-linux*}"
  mkdir -p "$PREFIX/node-$ver"
  tar -xJf "$WORK/$file" -C "$PREFIX/node-$ver" --strip-components=1 --no-same-owner
  ln -sfn "node-$ver" "$PREFIX/node.tmp" && mv -Tf "$PREFIX/node.tmp" "$PREFIX/node"
  ok "Node.js $ver installed in $PREFIX/node-$ver"
}

# Copies an unpacked package into /opt/openvps/releases/<version>.
stage_release() {
  local dest="$PREFIX/releases/$PKG_VERSION"
  if [[ -e "$dest" ]]; then
    rm -rf "$dest.old" && mv "$dest" "$dest.old"
  fi
  mkdir -p "$PREFIX/releases"
  cp -a "$PKG_DIR" "$dest"
  chown -R root:root "$dest"
  chmod -R u=rwX,go=rX "$dest"
  rm -rf "$dest.old"
  RELEASE_DIR="$dest"
}

activate_release() { # activate_release <dir>
  ln -sfn "$1" "$PREFIX/current.tmp"
  mv -Tf "$PREFIX/current.tmp" "$PREFIX/current"
}

install_system_files() {
  install -m 0644 "$RELEASE_DIR/packaging/openvps.service" "$UNIT"
  install -m 0755 "$RELEASE_DIR/packaging/openvps-cli.sh" "$BIN"
  systemctl daemon-reload
}

wait_healthy() { # wait_healthy <expected version or ""> ; uses $PORT and config TLS
  local scheme=https url body
  if [[ -f "$ETC/config.json" ]] && grep -Eq '"enabled"[[:space:]]*:[[:space:]]*false' "$ETC/config.json"; then scheme=http; fi
  local port
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$ETC/config.json" 2>/dev/null | head -n1)"
  url="${scheme}://127.0.0.1:${port:-$PORT}/api/health"
  for _ in $(seq 1 30); do
    if body="$(curl -fsk --max-time 2 "$url" 2>/dev/null)"; then
      if [[ -z "${1:-}" ]] || grep -q "\"version\":\"$1\"" <<<"$body"; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
OpenVPS installer

Usage: sudo bash install.sh [options]

  --version X          Install release X (default: latest)
  --repo USER/NAME     GitHub repository to download from (default: $OPENVPS_REPO)
  --package FILE       Install from a local release tarball instead of downloading
  --port N             Panel HTTPS port (default: 7443)
  --open-firewall      If ufw is active, add a rule allowing the panel port
  --force-unsupported  Continue on an untested OS version or architecture
  -y, --yes            Do not ask for confirmation
  -h, --help           Show this help
EOF
}

parse_args() {
  ASSUME_YES=0 OPEN_FW=0 FORCE=0 PACKAGE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) OPENVPS_VERSION="${2:?}"; shift 2 ;;
      --repo) OPENVPS_REPO="${2:?}"; shift 2 ;;
      --package) PACKAGE="$(realpath "${2:?}")"; shift 2 ;;
      --port) PORT="${2:?}"; shift 2 ;;
      --open-firewall) OPEN_FW=1; shift ;;
      --force-unsupported) FORCE=1; shift ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
  done
  [[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "Invalid port: $PORT"
  [[ "$OPENVPS_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Invalid repository: $OPENVPS_REPO"
}

preflight() {
  info "Checking this server"
  [[ $EUID -eq 0 ]] || die "Run as root (sudo bash install.sh)."
  detect_platform

  local supported=1
  if [[ " $SUPPORTED_IDS " != *" $OS_ID "* || " $SUPPORTED_VERSIONS " != *" $OS_VERSION "* ]]; then
    supported=0
    warn "${OS_PRETTY:-This OS} is not supported (supported: Ubuntu $SUPPORTED_VERSIONS LTS)."
  fi
  if [[ "$ARCH" != x64 ]]; then
    if [[ "$ARCH" == arm64 ]]; then
      supported=0
      warn "arm64 is not yet tested (supported: x86-64)."
    else
      die "Unsupported CPU architecture: $ARCH"
    fi
  fi
  if ((supported == 0 && FORCE == 0)); then
    die "Refusing to install on an unsupported platform. Use --force-unsupported to try anyway."
  fi
  ((supported == 1)) && ok "$OS_PRETTY ($ARCH)"

  [[ -d /run/systemd/system ]] || die "systemd is required."
  local missing=() c
  for c in curl tar xz sha256sum openssl ss runuser install realpath; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if ((${#missing[@]})); then
    die "Missing required commands: ${missing[*]}. Install them with: apt-get install -y curl tar xz-utils openssl iproute2 util-linux coreutils"
  fi
  ok "Required tools present"

  if [[ -e "$PREFIX/current" || -f "$UNIT" ]]; then
    die "OpenVPS is already installed. Use 'sudo openvps upgrade' to update, or 'sudo openvps uninstall' first."
  fi
  if [[ -e "$ETC/config.json" || -e "$DATA/openvps.db" ]]; then
    warn "Found existing configuration or data from a previous installation in $ETC / $DATA."
    warn "It will be reused as-is (including the existing administrator account)."
  fi

  if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
    die "Port $PORT is already in use. Choose another with --port."
  fi
  ok "Port $PORT is free"

  local avail_kb
  avail_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
  ((avail_kb > 400 * 1024)) || die "At least 400 MB of free disk space is needed in /opt."
  local mem_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  ((mem_kb >= 450 * 1024)) || warn "Less than 512 MB RAM: OpenVPS will run, but leave little room for your apps."
  ok "Disk and memory OK"
}

show_plan() {
  local src="${PACKAGE:-github.com/${OPENVPS_REPO} release ${OPENVPS_VERSION}}"
  cat <<EOF

${C_B}OpenVPS will make these changes:${C_0}
  - create system user '${SVC_USER}' (no login shell)
  - install from: $src
  - install a private Node.js ${NODE_MAJOR}.x runtime in $PREFIX (system Node.js is not touched)
  - write $ETC/config.json and a self-signed TLS certificate in $ETC/tls
  - store data in $DATA
  - install and start systemd service 'openvps' on port $PORT (HTTPS)
  - install the admin command $BIN
  - create user 'ovapps' and /srv/apps for applications you add in OpenVPS, with its own PM2
  - install the root-only helper service openvps-agent (fixed, audited actions only)
EOF
  if ((OPEN_FW)); then echo "  - allow TCP $PORT in ufw if ufw is active"; fi
  echo
}

create_user_and_dirs() {
  if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    local gopt=(--user-group)
    # Reuse a leftover group of the same name instead of failing.
    if getent group "$SVC_USER" >/dev/null; then gopt=(--gid "$SVC_USER"); fi
    useradd --system "${gopt[@]}" --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
    CREATED_USER=1
    ok "Created system user '$SVC_USER'"
  fi
  [[ -d "$PREFIX" ]] || CREATED_PREFIX=1
  [[ -d "$ETC" ]] || CREATED_ETC=1
  [[ -d "$DATA" ]] || CREATED_DATA=1
  install -d -m 0755 -o root -g root "$PREFIX" "$PREFIX/releases"
  install -d -m 0750 -o root -g "$SVC_USER" "$ETC" "$ETC/tls"
  install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA" "$DATA/backups"
}

write_config() {
  if [[ -f "$ETC/config.json" ]]; then
    ok "Keeping existing $ETC/config.json"
    return
  fi
  cat >"$ETC/config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "tls": { "enabled": true, "certFile": "$ETC/tls/cert.pem", "keyFile": "$ETC/tls/key.pem" },
  "dataDir": "$DATA"
}
EOF
  chown root:"$SVC_USER" "$ETC/config.json"
  chmod 0640 "$ETC/config.json"
  ok "Wrote $ETC/config.json (all options: $PREFIX/current/packaging/config.example.json)"
}

server_ips() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9a-fA-F:.]+$' | grep -v '^fe80' | head -n 6
}

make_cert() { # make_cert <subjectAltName> ; prints OpenSSL's error output on failure
  { openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 825 \
    -subj "/CN=OpenVPS/O=OpenVPS self-signed" -addext "subjectAltName=$1" \
    -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$ETC/tls/key.pem" -out "$ETC/tls/cert.pem" >/dev/null; } 2>&1
}

write_tls() {
  if [[ -f "$ETC/tls/cert.pem" && -f "$ETC/tls/key.pem" ]]; then
    ok "Keeping existing TLS certificate"
    return
  fi
  # The CN is a fixed short name (it is limited to 64 characters); browsers match
  # the subjectAltName entries, which list the hostname and the server's IPs.
  local base="DNS:localhost,IP:127.0.0.1" san host ip err
  san="$base"
  host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)"
  host="${host%.}"
  if [[ "$host" =~ ^[A-Za-z0-9.-]{1,253}$ && "$host" != localhost ]]; then san="DNS:${host},${san}"; fi
  while read -r ip; do
    if [[ -n "$ip" ]]; then san="${san},IP:${ip}"; fi
  done < <(server_ips)
  if ! err="$(make_cert "$san")"; then
    warn "Certificate with names '$san' failed; retrying with a minimal name list."
    warn "OpenSSL said: $(tail -n 2 <<<"$err" | tr '\n' ' ')"
    ip="$(server_ips | grep -v ':' | head -n1)"
    if ! err="$(make_cert "${base}${ip:+,IP:${ip}}")"; then
      printf '%s\n' "$err" >&2
      die "Could not create a TLS certificate (OpenSSL error above). Please report it with the output of: openssl version; hostname -f; hostname -I"
    fi
  fi
  chown root:"$SVC_USER" "$ETC/tls/key.pem" "$ETC/tls/cert.pem"
  chmod 0640 "$ETC/tls/key.pem"
  chmod 0644 "$ETC/tls/cert.pem"
  FINGERPRINT="$(openssl x509 -in "$ETC/tls/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
  ok "Created a self-signed TLS certificate (valid 825 days)"
}

configure_firewall() {
  command -v ufw >/dev/null 2>&1 || return 0
  if ! ufw status 2>/dev/null | grep -q '^Status: active'; then return 0; fi
  if ufw status 2>/dev/null | grep -Eq "^${PORT}(/tcp)?[[:space:]]+ALLOW"; then return 0; fi
  if ((OPEN_FW)); then
    ufw allow "${PORT}/tcp" comment 'OpenVPS panel' >/dev/null
    ok "Allowed TCP $PORT in ufw"
  else
    FIREWALL_NOTE=1
  fi
}

# Undo what this run created if something fails part-way (FR-01, risk: installer damages server).
on_exit() {
  local code=$?
  rm -rf "${WORK:-/nonexistent}"
  if [[ "${INSTALL_STARTED:-0}" == 1 && "${INSTALL_DONE:-0}" != 1 ]]; then
    warn "Installation failed (exit $code). Reverting changes made by this run…"
    systemctl disable --now openvps >/dev/null 2>&1 || true
    rm -f "$UNIT" "$BIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "${CREATED_PREFIX:-0}" == 1 ]]; then
      rm -rf "$PREFIX"
    else
      # $PREFIX pre-existed (e.g. leftover runtime): remove only what this run added.
      # preflight refused to run if "current" already existed, so it is ours.
      rm -f "$PREFIX/current" "$PREFIX/current.tmp"
      if [[ -n "${RELEASE_DIR:-}" ]]; then rm -rf "$RELEASE_DIR"; fi
      rmdir "$PREFIX/releases" 2>/dev/null || true
    fi
    if [[ "${CREATED_ETC:-0}" == 1 ]]; then rm -rf "$ETC"; fi
    if [[ "${CREATED_DATA:-0}" == 1 ]]; then rm -rf "$DATA"; fi
    if [[ "${CREATED_USER:-0}" == 1 ]]; then userdel "$SVC_USER" >/dev/null 2>&1 || true; fi
    warn "Reverted. Nothing from this attempt was left behind."
  fi
  exit "$code"
}

main() {
  parse_args "$@"
  preflight
  show_plan
  confirm "Continue?" || die "Cancelled. Nothing was changed."

  WORK="$(mktemp -d)"
  trap on_exit EXIT
  # Never fail silently: name the command that failed.
  trap 'warn "Command failed (line $LINENO): $BASH_COMMAND"' ERR

  obtain_package
  info "Installing OpenVPS $PKG_VERSION"
  INSTALL_STARTED=1
  create_user_and_dirs
  ensure_node
  stage_release
  activate_release "$RELEASE_DIR"
  write_config
  write_tls
  install_system_files
  ok "Installed systemd service and $BIN"

  # Run migrations once up front so errors surface here rather than in a crash loop.
  runuser -u "$SVC_USER" -- env OPENVPS_CONFIG="$ETC/config.json" \
    "$PREFIX/node/bin/node" --disable-warning=ExperimentalWarning "$PREFIX/current/server/dist/cli.js" migrate >/dev/null

  systemctl enable --now openvps >/dev/null 2>&1
  if ! wait_healthy "$PKG_VERSION"; then
    journalctl -u openvps -n 30 --no-pager >&2 || true
    die "OpenVPS did not become healthy."
  fi
  ok "Service is running"
  INSTALL_DONE=1
  configure_firewall
  # Application management (agent, apps user, PM2). A failure here leaves the panel working.
  if [[ -f "$RELEASE_DIR/scripts/provision.sh" ]]; then
    bash "$RELEASE_DIR/scripts/provision.sh" || warn "Application management setup failed. Fix the issue above, then run: sudo openvps provision"
  fi

  local token
  token="$("$BIN" setup-token 2>/dev/null || true)"
  local ip
  ip="$(server_ips | grep -v ':' | head -n1)"

  cat <<EOF

${C_G}${C_B}OpenVPS $PKG_VERSION is installed.${C_0}

  Open:          ${C_B}https://${ip:-<server-ip>}:${PORT}${C_0}
${token:+  Setup token:   ${C_B}${token}${C_0}
}${token:-  Sign in with your existing administrator account.
}
  Your browser will warn about the self-signed certificate. Check that the
  fingerprint matches before you continue:
  ${C_D}SHA-256 ${FINGERPRINT:-$(openssl x509 -in "$ETC/tls/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)}${C_0}

  Useful commands:
    sudo openvps status            sudo systemctl status openvps
    sudo openvps setup-token       journalctl -u openvps -f
    sudo openvps upgrade           sudo openvps uninstall
    sudo openvps provision         (repair application management)
EOF
  if [[ "${FIREWALL_NOTE:-0}" == 1 ]]; then
    printf '\n  %sufw is active and does not allow port %s yet.%s Allow it (ideally only from your IP):\n' "$C_Y" "$PORT" "$C_0"
    printf '    sudo ufw allow from <your-ip> to any port %s proto tcp\n' "$PORT"
  fi
  printf '\n  Tip: restrict the panel port to trusted IPs in your provider firewall as well.\n\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
