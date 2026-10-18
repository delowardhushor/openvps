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

provision_backups() {
  # Local backups hold database dumps and app files: root only.
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  command -v tar >/dev/null 2>&1 || warn "tar is not installed, so backups are unavailable. Install it with: sudo apt install tar"
  if command -v mongodump >/dev/null 2>&1; then
    ok "mongodump found: MongoDB backups are available"
  else
    warn "mongodump is not installed (only needed to back up MongoDB). See docs/backups.md for installing the MongoDB Database Tools."
  fi
  ok "Backups are stored in $BACKUP_DIR (root only)"
}

main_provision() {
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
