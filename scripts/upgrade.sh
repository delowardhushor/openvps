#!/usr/bin/env bash
# Upgrade an existing OpenVPS installation (FR-11).
#
#   sudo openvps upgrade                 # latest release
#   sudo openvps upgrade --version 0.2.0
#   sudo openvps upgrade --package ./openvps-0.2.0.tar.gz
#
# Procedure:
#   1. download and verify the new release; stage it beside the current one
#   2. snapshot the database to /var/lib/openvps/backups
#   3. stop the service, switch /opt/openvps/current, run migrations, start
#   4. health-check the new version
#   5. on any failure: restore the previous release AND the database snapshot
# Configuration in /etc/openvps is never overwritten.

set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=install.sh
. "$SCRIPT_DIR/install.sh"

KEEP_RELEASES=3

usage() {
  cat <<EOF
Upgrade OpenVPS

Usage: sudo openvps upgrade [options]

  --version X          Upgrade to release X (default: latest)
  --repo USER/NAME     GitHub repository (default: $OPENVPS_REPO)
  --package FILE       Upgrade from a local release tarball
  --reinstall          Allow reinstalling the currently installed version
  -y, --yes            Do not ask for confirmation
EOF
}

cli() { runuser -u "$SVC_USER" -- env OPENVPS_CONFIG="$ETC/config.json" "$PREFIX/node/bin/node" --disable-warning=ExperimentalWarning "$PREFIX/current/server/dist/cli.js" "$@"; }

rollback() {
  local reason="$1"
  warn "Upgrade failed: $reason"
  warn "Rolling back to $PREV_VERSION…"
  systemctl stop openvps >/dev/null 2>&1 || true
  activate_release "$PREV_DIR"
  if [[ -n "${DB_BACKUP:-}" && -f "$DB_BACKUP" ]]; then
    install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$DB_BACKUP" "$DATA/openvps.db"
    rm -f "$DATA/openvps.db-wal" "$DATA/openvps.db-shm"
    ok "Database restored from $DB_BACKUP"
  fi
  if [[ -f "$PREV_DIR/packaging/openvps.service" ]]; then
    install -m 0644 "$PREV_DIR/packaging/openvps.service" "$UNIT"
    install -m 0755 "$PREV_DIR/packaging/openvps-cli.sh" "$BIN"
    systemctl daemon-reload
  fi
  systemctl start openvps || true
  if wait_healthy "$PREV_VERSION"; then
    ok "Rolled back. OpenVPS $PREV_VERSION is running again."
  else
    warn "The previous version did not come back healthy either. See: journalctl -u openvps -n 100"
    warn "Recovery guide: docs/recovery.md"
  fi
  rm -rf "${NEW_DIR:?}"
  exit 1
}

main_upgrade() {
  ASSUME_YES=0 PACKAGE="" REINSTALL=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) OPENVPS_VERSION="${2:?}"; shift 2 ;;
      --repo) OPENVPS_REPO="${2:?}"; shift 2 ;;
      --package) PACKAGE="$(realpath "${2:?}")"; shift 2 ;;
      --reinstall) REINSTALL=1; shift ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ $EUID -eq 0 ]] || die "Run as root: sudo openvps upgrade"
  [[ -L "$PREFIX/current" ]] || die "No OpenVPS installation found in $PREFIX."
  detect_platform

  PREV_DIR="$(realpath "$PREFIX/current")"
  PREV_VERSION="$(tr -d '[:space:]' <"$PREV_DIR/VERSION")"
  info "Installed version: $PREV_VERSION"

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  obtain_package

  if [[ "$PKG_VERSION" == "$PREV_VERSION" && $REINSTALL == 0 ]]; then
    ok "Already on $PKG_VERSION. Nothing to do (use --reinstall to force)."
    exit 0
  fi
  if ! version_ge "$PKG_VERSION" "$PREV_VERSION"; then
    warn "$PKG_VERSION is older than the installed $PREV_VERSION. Downgrades are refused if the database schema is newer."
  fi
  confirm "Upgrade OpenVPS $PREV_VERSION -> $PKG_VERSION?" || die "Cancelled. Nothing was changed."

  ensure_node

  # Stage the new release under a temporary name so the current one stays intact.
  NEW_DIR="$PREFIX/releases/$PKG_VERSION.new"
  rm -rf "$NEW_DIR"
  cp -a "$PKG_DIR" "$NEW_DIR"
  chown -R root:root "$NEW_DIR"
  chmod -R u=rwX,go=rX "$NEW_DIR"

  DB_BACKUP="$DATA/backups/pre-upgrade-${PREV_VERSION}-to-${PKG_VERSION}-$(date +%Y%m%d%H%M%S).db"
  if [[ -f "$DATA/openvps.db" ]]; then
    cli backup-db "$DB_BACKUP" >/dev/null || die "Could not back up the database. Nothing was changed."
    ok "Database backed up to $DB_BACKUP"
  else
    DB_BACKUP=""
  fi

  info "Switching to $PKG_VERSION"
  systemctl stop openvps
  local final="$PREFIX/releases/$PKG_VERSION"
  if [[ "$final" == "$PREV_DIR" ]]; then
    # Reinstalling the same version: keep the old copy for rollback.
    PREV_DIR="$PREFIX/releases/$PKG_VERSION.prev"
    rm -rf "$PREV_DIR" && mv "$final" "$PREV_DIR"
    activate_release "$PREV_DIR"
  fi
  rm -rf "$final" && mv "$NEW_DIR" "$final"
  NEW_DIR="$final"
  activate_release "$final"
  install -m 0644 "$final/packaging/openvps.service" "$UNIT"
  install -m 0755 "$final/packaging/openvps-cli.sh" "$BIN"
  systemctl daemon-reload

  cli check-config >/dev/null 2>&1 || rollback "the existing configuration is not valid for $PKG_VERSION (run: sudo openvps check-config)"
  cli migrate >/dev/null 2>&1 || rollback "database migration failed"
  systemctl start openvps || rollback "service did not start"
  wait_healthy "$PKG_VERSION" || rollback "health check did not pass"
  ok "OpenVPS $PKG_VERSION is running"

  # Prune old releases, keeping the newest $KEEP_RELEASES (never the current one).
  local cur
  cur="$(realpath "$PREFIX/current")"
  find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{print $2}' |
    tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
      if [[ "$d" != "$cur" ]]; then rm -rf "$d"; fi
    done
  # Prune old private Node.js runtimes not in use.
  local node_cur
  node_cur="$(realpath "$PREFIX/node")"
  for d in "$PREFIX"/node-*; do
    if [[ -d "$d" && "$d" != "$node_cur" ]]; then rm -rf "$d"; fi
  done
  printf '\n%sUpgrade complete:%s %s -> %s\nPre-upgrade database snapshot: %s\n\n' "$C_G" "$C_0" "$PREV_VERSION" "$PKG_VERSION" "${DB_BACKUP:-none}"
}

main_upgrade "$@"
