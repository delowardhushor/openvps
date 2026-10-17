#!/bin/sh
# /usr/local/bin/openvps — wrapper around the OpenVPS admin CLI.
# Database commands run as the unprivileged "openvps" user; install
# management commands (upgrade, uninstall) run the release scripts as root.
set -eu

PREFIX=/opt/openvps
NODE="$PREFIX/node/bin/node"
APP="$PREFIX/current"
export OPENVPS_CONFIG="${OPENVPS_CONFIG:-/etc/openvps/config.json}"

case "${1:-}" in
  upgrade|uninstall)
    if [ "$(id -u)" -ne 0 ]; then
      echo "This command needs root: sudo openvps $*" >&2
      exit 1
    fi
    cmd="$1"
    shift
    exec bash "$APP/scripts/$cmd.sh" "$@"
    ;;
  version|--version|help|--help|-h|"")
    exec "$NODE" --disable-warning=ExperimentalWarning "$APP/server/dist/cli.js" "$@"
    ;;
esac

if [ "$(id -un)" = "openvps" ]; then
  exec "$NODE" --disable-warning=ExperimentalWarning "$APP/server/dist/cli.js" "$@"
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "This command needs root: sudo openvps $*" >&2
  exit 1
fi
cd /
exec runuser -u openvps -- env OPENVPS_CONFIG="$OPENVPS_CONFIG" \
  "$NODE" --disable-warning=ExperimentalWarning "$APP/server/dist/cli.js" "$@"
