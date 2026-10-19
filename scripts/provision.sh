#!/usr/bin/env bash
# Set up (or repair) the pieces OpenVPS needs to manage applications. Safe to run repeatedly.
#
#   sudo openvps provision
#
# What it does:
#   - creates the unprivileged user "ovapps" (home /var/lib/ovapps) and /srv/apps
#   - installs OpenVPS's bundled PM2 into /opt/openvps/pm2 for that user
#   - finds the PM2 root already uses (if any) so the panel can show and control those apps
#   - installs and starts openvps-apps.service (PM2 for ovapps) and openvps-agent.service
#   - prepares the folder Let's Encrypt validation files are served from and checks for Nginx/Certbot
#   - installs MongoDB Community Edition (official MongoDB apt repository) when MongoDB is not
#     on the server, or just the MongoDB Database Tools when only the server is there
#     (skip with: sudo openvps provision --no-mongodb, or OPENVPS_SKIP_MONGODB=1)
# It never changes root's PM2 processes, their configuration, or files in /srv/apps.

set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=install.sh
. "$SCRIPT_DIR/install.sh"

RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_USER=ovapps
APPS_HOME=/var/lib/ovapps
APPS_ROOT=/srv/apps
AGENT_STATE=/var/lib/openvps-agent
BACKUP_DIR=/var/backups/openvps
PM2_DIR="$PREFIX/pm2"
AGENT_UNIT=/etc/systemd/system/openvps-agent.service
APPS_UNIT=/etc/systemd/system/openvps-apps.service

provision_user() {
  if ! id -u "$APPS_USER" >/dev/null 2>&1; then
    local gopt=(--user-group)
    if getent group "$APPS_USER" >/dev/null; then gopt=(--gid "$APPS_USER"); fi
    useradd --system "${gopt[@]}" --home-dir "$APPS_HOME" --no-create-home --shell /usr/sbin/nologin "$APPS_USER"
    ok "Created the apps user '$APPS_USER'"
  fi
  install -d -m 0750 -o "$APPS_USER" -g "$APPS_USER" "$APPS_HOME"
  if [[ ! -d "$APPS_ROOT" ]]; then
    install -d -m 0755 -o "$APPS_USER" -g "$APPS_USER" "$APPS_ROOT"
    ok "Created $APPS_ROOT for application code"
  fi
  # Agent state: root-owned so the apps user cannot plant symlinks; group-readable for PM2.
  install -d -m 0755 -o root -g root "$AGENT_STATE"
  install -d -m 0750 -o root -g "$APPS_USER" "$AGENT_STATE/apps"
}

provision_pm2() {
  local src="$RELEASE_DIR/vendor/pm2"
  if [[ ! -f "$src/node_modules/pm2/package.json" ]]; then
    warn "This package does not include PM2 (vendor/pm2). Managed applications are unavailable."
    return 1
  fi
  local want have=""
  want="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$src/node_modules/pm2/package.json" | head -n1)"
  if [[ -f "$PM2_DIR/node_modules/pm2/package.json" ]]; then
    have="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$PM2_DIR/node_modules/pm2/package.json" | head -n1)"
  fi
  if [[ "$have" == "$want" ]]; then
    ok "PM2 $want for $APPS_USER already installed"
    PM2_CHANGED=0
    return 0
  fi
  rm -rf "$PM2_DIR.new"
  cp -a "$src" "$PM2_DIR.new"
  chown -R root:root "$PM2_DIR.new"
  chmod -R u=rwX,go=rX "$PM2_DIR.new"
  rm -rf "$PM2_DIR.old"
  if [[ -d "$PM2_DIR" ]]; then mv "$PM2_DIR" "$PM2_DIR.old"; fi
  mv "$PM2_DIR.new" "$PM2_DIR"
  rm -rf "$PM2_DIR.old"
  PM2_CHANGED=1
  ok "Installed PM2 $want for $APPS_USER${have:+ (was $have)}"
}

# Find the pm2 that root already uses, without running root's shell startup files
# (an interactive shell would take over the terminal and hang).
#   1. From root's running PM2 daemon: its Node.js binary usually has pm2 next to it (npm -g, nvm, volta).
#   2. Standard install locations.
pm2_beside_node() { # pm2_beside_node <node binary>
  local bin_dir lib
  bin_dir="$(dirname "$1")"
  if [[ -x "$bin_dir/pm2" ]]; then echo "$bin_dir/pm2"; return 0; fi
  lib="$(dirname "$bin_dir")/lib/node_modules/pm2/bin/pm2"
  if [[ -f "$lib" ]]; then echo "$lib"; return 0; fi
  return 1
}

detect_root_pm2() {
  local found="" pid exe c
  if [[ -r /root/.pm2/pm2.pid ]]; then
    pid="$(tr -dc '0-9' </root/.pm2/pm2.pid)"
    if [[ -n "$pid" && -e "/proc/$pid/exe" ]]; then
      exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
      if [[ -n "$exe" ]]; then found="$(pm2_beside_node "$exe" || true)"; fi
    fi
  fi
  if [[ -z "$found" ]]; then
    for c in /usr/local/bin/pm2 /usr/bin/pm2 /root/.volta/bin/pm2 /root/.npm-global/bin/pm2 \
      /root/.local/share/pnpm/pm2 /root/.nvm/versions/node/*/bin/pm2; do
      if [[ -x "$c" ]]; then found="$c"; fi
    done
  fi
  if [[ -n "$found" && ! "$found" =~ ^/[A-Za-z0-9/._@+-]+$ ]]; then
    warn "Ignoring unusual pm2 path: $found"
    found=""
  fi
  if [[ -n "$found" && -f "$found" ]]; then
    ROOT_PM2="$found"
    ok "Found root's PM2 at $ROOT_PM2"
  else
    ROOT_PM2=""
    info "No PM2 found for root (fine if your apps don't use PM2 as root)."
  fi
  local json
  if [[ -n "$ROOT_PM2" ]]; then json="{ \"rootPm2Bin\": \"$ROOT_PM2\" }"; else json='{ "rootPm2Bin": null }'; fi
  printf '%s\n' "$json" >"$ETC/agent.json.tmp"
  chown root:"$SVC_USER" "$ETC/agent.json.tmp"
  chmod 0640 "$ETC/agent.json.tmp"
  mv "$ETC/agent.json.tmp" "$ETC/agent.json"
}

install_units() {
  install -m 0644 "$RELEASE_DIR/packaging/openvps-agent.service" "$AGENT_UNIT"
  install -m 0644 "$RELEASE_DIR/packaging/openvps-apps.service" "$APPS_UNIT"
  systemctl daemon-reload
  if [[ "${HAVE_PM2:-1}" == 1 ]]; then
    if [[ "${PM2_CHANGED:-0}" == 1 ]] && systemctl is-active --quiet openvps-apps; then
      # New PM2 version: restart the daemon so it matches the CLI (apps are resurrected).
      systemctl restart openvps-apps
      ok "Restarted PM2 for $APPS_USER on the new version"
    else
      systemctl enable --now openvps-apps >/dev/null 2>&1
    fi
    systemctl enable openvps-apps >/dev/null 2>&1 || true
  fi
  systemctl enable openvps-agent >/dev/null 2>&1
  systemctl restart openvps-agent
  local i
  for i in $(seq 1 20); do
    if [[ -S /run/openvps-agent/agent.sock ]]; then break; fi
    sleep 0.5
  done
  if [[ -S /run/openvps-agent/agent.sock ]]; then
    ok "Agent is running"
  else
    journalctl -u openvps-agent -n 20 --no-pager >&2 || true
    die "The OpenVPS agent did not start (see the log above)."
  fi
  : "$i"
}

provision_sites() {
  # HTTP-01 challenge files for Let's Encrypt; Nginx (www-data) must be able to read them.
  install -d -m 0755 -o root -g root "$AGENT_STATE" "$AGENT_STATE/acme" "$AGENT_STATE/acme/.well-known" "$AGENT_STATE/acme/.well-known/acme-challenge"
  if command -v nginx >/dev/null 2>&1 || [[ -x /usr/sbin/nginx ]]; then
    ok "Nginx found: sites and domains can be managed"
  else
    warn "Nginx is not installed, so sites and domains are unavailable. Install it with: sudo apt install nginx"
  fi
  local c found=""
  for c in /usr/bin/certbot /snap/bin/certbot /usr/local/bin/certbot; do
    if [[ -x "$c" ]]; then found="$c"; break; fi
  done
  if [[ -n "$found" ]]; then
    ok "Certbot found ($found): HTTPS certificates can be issued"
  else
    warn "Certbot is not installed, so HTTPS certificates can't be issued. Install it with: sudo apt install certbot"
  fi
}

MONGO_SERIES=8.0

# Install MongoDB from MongoDB's own apt repository (Ubuntu only: that is all OpenVPS supports).
#   - nothing on the server        -> mongodb-org (server, shell and Database Tools)
#   - mongod already there         -> only mongodb-database-tools; the existing server is not touched
#   - mongodump already there      -> nothing
# The server listens on 127.0.0.1 only and has no users; see docs/backups.md.
provision_mongodb() {
  if command -v mongodump >/dev/null 2>&1 && command -v mongorestore >/dev/null 2>&1; then
    ok "mongodump found: MongoDB backups are available"
    return 0
  fi
  if [[ "${OPENVPS_SKIP_MONGODB:-0}" == 1 ]]; then
    warn "mongodump is not installed (skipped by request). Install the MongoDB Database Tools to back up MongoDB; see docs/backups.md."
    return 0
  fi
  local id="" codename="" arch pkg why
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && echo "${ID:-}")" codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  fi
  arch="$(dpkg --print-architecture 2>/dev/null || true)"
  if [[ "$id" != ubuntu || ! "$codename" =~ ^(jammy|noble)$ || ! "$arch" =~ ^(amd64|arm64)$ ]] || ! command -v apt-get >/dev/null 2>&1; then
    warn "MongoDB was not installed automatically (supported: Ubuntu 22.04/24.04 on amd64/arm64). Install the MongoDB Database Tools yourself; see docs/backups.md."
    return 0
  fi

  pkg=mongodb-org
  why="MongoDB is not installed"
  if command -v mongod >/dev/null 2>&1 || [[ -e /lib/systemd/system/mongod.service || -e /etc/systemd/system/mongod.service || -x /usr/local/bin/mongod || -x /snap/bin/mongod ]]; then
    pkg=mongodb-database-tools
    why="MongoDB is installed but its backup tools are not"
  elif [[ "$arch" == amd64 ]] && ! grep -qw avx /proc/cpuinfo 2>/dev/null; then
    # MongoDB 5.0+ needs AVX on x86-64; the tools do not.
    pkg=mongodb-database-tools
    why="this CPU has no AVX support, which the MongoDB server needs"
  fi

  info "$why. Installing $pkg (MongoDB Community $MONGO_SERIES) from repo.mongodb.org"
  local keyring="/usr/share/keyrings/mongodb-server-$MONGO_SERIES.gpg"
  local list="/etc/apt/sources.list.d/mongodb-org-$MONGO_SERIES.list"
  command -v curl >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1 || {
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg >/dev/null 2>&1 || {
      warn "Could not install curl/gnupg, so MongoDB was not installed. Install it by hand; see docs/backups.md."
      return 0
    }
  }
  local tmp
  tmp="$(mktemp)"
  if ! curl -fsSL --retry 3 --max-time 60 "https://pgp.mongodb.com/server-$MONGO_SERIES.asc" -o "$tmp" \
    || ! gpg --batch --yes --dearmor -o "$keyring" "$tmp"; then
    rm -f "$tmp"
    warn "Could not fetch the MongoDB signing key, so MongoDB was not installed. Check this server's internet access, then run: sudo openvps provision"
    return 0
  fi
  rm -f "$tmp"
  chmod 0644 "$keyring"
  printf 'deb [ arch=%s signed-by=%s ] https://repo.mongodb.org/apt/ubuntu %s/mongodb-org/%s multiverse\n' "$arch" "$keyring" "$codename" "$MONGO_SERIES" >"$list"
  if ! DEBIAN_FRONTEND=noninteractive apt-get update -o Dir::Etc::sourcelist="$list" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 \
    || ! DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg" >/dev/null 2>&1; then
    warn "Installing $pkg failed. Try it by hand to see the error: sudo apt-get update && sudo apt-get install -y $pkg"
    return 0
  fi
  ok "Installed $pkg (MongoDB Community $MONGO_SERIES)"
  if [[ "$pkg" == mongodb-org ]]; then
    systemctl enable --now mongod >/dev/null 2>&1 || warn "MongoDB was installed but could not be started: check 'systemctl status mongod'"
    if systemctl is-active --quiet mongod; then
      ok "MongoDB is running on 127.0.0.1:27017 (local only, no users yet; see docs/backups.md)"
    fi
  fi
}

provision_backups() {
  # Local backups hold database dumps and app files: root only.
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  command -v tar >/dev/null 2>&1 || warn "tar is not installed, so backups are unavailable. Install it with: sudo apt install tar"
  provision_mongodb || warn "MongoDB setup failed; backups of folders still work."
  ok "Backups are stored in $BACKUP_DIR (root only)"
}

main_provision() {
  local a
  for a in "$@"; do
    case "$a" in
      --no-mongodb) OPENVPS_SKIP_MONGODB=1 ;;
      *) die "Unknown option: $a (supported: --no-mongodb)" ;;
    esac
  done
  [[ $EUID -eq 0 ]] || die "Run as root: sudo openvps provision"
  [[ -d "$ETC" ]] || die "OpenVPS is not installed ($ETC is missing)."
  info "Setting up applications, sites and backups"
  provision_user
  HAVE_PM2=1
  provision_pm2 || HAVE_PM2=0
  detect_root_pm2
  provision_sites
  provision_backups
  install_units
  ok "Applications, sites and backups are ready"
}

main_provision "$@"
