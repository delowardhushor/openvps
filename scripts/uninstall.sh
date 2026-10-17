#!/usr/bin/env bash
# Remove OpenVPS.
#
#   sudo openvps uninstall            # remove the program; keep /etc/openvps and /var/lib/openvps
#   sudo openvps uninstall --purge    # also remove config, data and the openvps user
#
# Applications, Nginx sites, PM2 processes and firewall rules are left untouched.

set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
if [[ -f "$SCRIPT_DIR/install.sh" ]]; then
  # shellcheck source=install.sh
  . "$SCRIPT_DIR/install.sh"
else
  PREFIX=/opt/openvps ETC=/etc/openvps DATA=/var/lib/openvps UNIT=/etc/systemd/system/openvps.service
  BIN=/usr/local/bin/openvps SVC_USER=openvps C_B='' C_R='' C_0=''
  info() { echo "==> $*"; }
  ok() { echo " ✓ $*"; }
  warn() { echo " ! $*" >&2; }
  die() { echo "Error: $*" >&2; exit 1; }
  confirm() { [[ "${ASSUME_YES:-0}" == 1 ]] && return 0; local r; read -r -p "$1 [y/N] " r </dev/tty; [[ "$r" =~ ^[Yy] ]]; }
fi

PURGE=0 ASSUME_YES=0 BACKUP=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --no-backup) BACKUP=0; shift ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help)
      echo "Usage: sudo openvps uninstall [--purge] [--no-backup] [--yes]"
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ $EUID -eq 0 ]] || die "Run as root: sudo openvps uninstall"

echo
echo "${C_B}This will remove:${C_0}"
echo "  - the openvps service, $BIN and $PREFIX"
if ((PURGE)); then
  echo "  - ${C_R}configuration ($ETC), data ($DATA) and the '$SVC_USER' user${C_0}"
  ((BACKUP)) && echo "  - (a final archive of config and data is saved to /root first)"
else
  echo "Kept: $ETC and $DATA (reinstalling later will reuse them; use --purge to delete)."
fi
echo "Not touched: your applications, Nginx, PM2, Node.js, firewall rules."
echo
confirm "Uninstall OpenVPS?" || die "Cancelled."

if systemctl list-unit-files openvps.service >/dev/null 2>&1; then
  systemctl disable --now openvps >/dev/null 2>&1 || true
fi
rm -f "$UNIT" "$BIN"
systemctl daemon-reload || true
rm -rf "$PREFIX"
ok "Removed the service and program files"

if ((PURGE)); then
  if ((BACKUP)) && [[ -d "$DATA" || -d "$ETC" ]]; then
    archive="/root/openvps-final-$(date +%Y%m%d%H%M%S).tar.gz"
    tar -czf "$archive" --ignore-failed-read "$ETC" "$DATA" 2>/dev/null || true
    chmod 600 "$archive"
    ok "Saved config and data to $archive"
  fi
  rm -rf "$ETC" "$DATA"
  if id -u "$SVC_USER" >/dev/null 2>&1; then userdel "$SVC_USER" >/dev/null 2>&1 || true; fi
  ok "Removed configuration, data and the '$SVC_USER' user"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'OpenVPS panel'; then
  warn "A ufw rule tagged 'OpenVPS panel' still exists. Remove it with: sudo ufw status numbered; sudo ufw delete <n>"
fi
echo
echo "OpenVPS has been uninstalled."
