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

# Find the pm2 that root already uses (system-wide npm, or nvm in root's shell profile).
detect_root_pm2() {
  local found=""
  found="$(HOME=/root timeout 15 bash -lic 'command -v pm2' 2>/dev/null </dev/null | tail -n1 || true)"
  if [[ -z "$found" || ! -x "$found" ]]; then
    local c
    for c in /usr/local/bin/pm2 /usr/bin/pm2 /root/.nvm/versions/node/*/bin/pm2 /root/.volta/bin/pm2 /root/.npm-global/bin/pm2; do
      if [[ -x "$c" ]]; then found="$c"; fi
    done
  fi
  if [[ -n "$found" && ! "$found" =~ ^/[A-Za-z0-9/._@+-]+$ ]]; then
    warn "Ignoring unusual pm2 path: $found"
    found=""
  fi
  if [[ -n "$found" && -x "$found" ]]; then
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

main_provision() {
  [[ $EUID -eq 0 ]] || die "Run as root: sudo openvps provision"
  [[ -d "$ETC" ]] || die "OpenVPS is not installed ($ETC is missing)."
  info "Setting up application management"
  provision_user
  HAVE_PM2=1
  provision_pm2 || HAVE_PM2=0
  detect_root_pm2
  install_units
  ok "Application management is ready"
}

main_provision "$@"
