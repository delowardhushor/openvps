#!/usr/bin/env bash
# Build a release tarball: release/openvps-<version>.tar.gz (+ .sha256)
# The package is architecture-independent: the server has no native or
# runtime npm dependencies, and the installer supplies Node.js.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Read "version" without needing Node.js (so packaging works on a bare server).
pkg_version() { sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1" | head -n1; }
VERSION="$(pkg_version package.json)"
[[ -n "$VERSION" ]] || { echo "Could not read version from package.json" >&2; exit 1; }
for p in server web; do
  v="$(pkg_version "$p/package.json")"
  [[ "$v" == "$VERSION" ]] || { echo "Version mismatch: $p/package.json is $v, root is $VERSION" >&2; exit 1; }
done

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  npm ci
  npm run build
fi
[[ -f server/dist/main.js && -f web/dist/index.html ]] || { echo "Build output missing" >&2; exit 1; }

NAME="openvps-$VERSION"
OUT="$ROOT/release"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/$NAME"
mkdir -p "$D/server" "$D/web" "$D/scripts" "$D/packaging"
cp -r server/dist "$D/server/"
cp server/package.json "$D/server/"
cp -r web/dist "$D/web/"
cp scripts/install.sh scripts/upgrade.sh scripts/uninstall.sh "$D/scripts/"
cp packaging/* "$D/packaging/"
cp LICENSE README.md CHANGELOG.md "$D/"
echo "$VERSION" >"$D/VERSION"

mkdir -p "$OUT"
# Reproducible-ish archive: fixed owner, sorted entries, normalized mtimes.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}" \
  -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
echo "Built $OUT/$NAME.tar.gz"
cat "$OUT/$NAME.tar.gz.sha256"
