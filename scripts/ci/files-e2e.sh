#!/usr/bin/env bash
# CI end-to-end test of the file manager with the real agent under systemd.
# What only a real host can prove: the agent starts its helper as the folder's owner
# (ovapps for /srv/apps), so files come out owned by that user, and the helper cannot touch
# files that user may not change. Runs on a GitHub Ubuntu runner after OpenVPS is installed.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

PASSWORD="${OPENVPS_PASSWORD:-correct horse battery staple}"
B=https://127.0.0.1:7443
JAR="$(mktemp)"
H=(-H 'content-type: application/json' -H 'x-openvps-request: 1')
api() { curl -sk -b "$JAR" -c "$JAR" "$@"; }
check() { if [[ "$2" != *"$3"* ]]; then echo "CHECK FAILED: $1: expected '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
q() { printf 'root=%s&path=%s' "$1" "$2"; }

echo "== 1. sign in (reuses the admin from an earlier step when there is one)"
if [[ "$(curl -sk $B/api/setup/status)" == *'"needsSetup":true'* ]]; then
  TOKEN="$(sudo openvps setup-token)"
  api "${H[@]}" -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"$PASSWORD\"}" $B/api/setup >/dev/null
else
  api "${H[@]}" -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" $B/api/auth/login >/dev/null
fi
ROOTS="$(api $B/api/files/roots)"
check "roots offered" "$ROOTS" '"/srv/apps"'

echo "== 2. work inside /srv/apps as the apps user"
sudo install -d -o ovapps -g ovapps /srv/apps/fm
R=/srv/apps
check "list" "$(api "$B/api/files/list?$(q $R fm)")" '"entries":[]'
check "mkdir" "$(api "${H[@]}" -d "{\"root\":\"$R\",\"path\":\"fm/sub\"}" $B/api/files/mkdir)" '"ok":true'
echo -n 'hello' | api "${H[@]:2}" -X POST -H 'content-type: application/octet-stream' --data-binary @- "$B/api/files/upload?$(q $R fm/sub/hello.txt)" >/dev/null
[[ "$(sudo cat /srv/apps/fm/sub/hello.txt)" == hello ]]
OWNER="$(stat -c '%U:%a' /srv/apps/fm/sub/hello.txt)"
check "uploaded file is owned by ovapps with normal permissions" "$OWNER" 'ovapps:644'
check "created folder is owned by ovapps" "$(stat -c '%U:%a' /srv/apps/fm/sub)" 'ovapps:755'

echo "== 3. a 70 MiB file goes through intact in both directions"
BIG="$(mktemp)"
head -c $((70 * 1024 * 1024)) /dev/urandom >"$BIG"
SUM="$(sha256sum "$BIG" | cut -d' ' -f1)"
CODE="$(api "${H[@]:2}" -X POST -H 'content-type: application/octet-stream' --data-binary @"$BIG" -o /dev/null -w '%{http_code}' "$B/api/files/upload?$(q $R fm/big.bin)")"
check "big upload accepted" "$CODE" 200
check "stored intact" "$(sudo sha256sum /srv/apps/fm/big.bin)" "$SUM"
check "no temporary file left" "$(sudo find /srv/apps/fm -name '.openvps-upload-*' | wc -l)" '0'
GOT="$(api "$B/api/files/download?$(q $R fm/big.bin)" | sha256sum | cut -d' ' -f1)"
check "downloaded intact" "$GOT" "$SUM"
rm -f "$BIG"

echo "== 4. the helper has only the apps user's rights"
echo root-owned | sudo tee /srv/apps/fm/rootfile.txt >/dev/null
sudo chmod 644 /srv/apps/fm/rootfile.txt
CODE="$(echo -n x | api "${H[@]:2}" -X POST -H 'content-type: application/octet-stream' --data-binary @- -o /dev/null -w '%{http_code}' "$B/api/files/upload?$(q $R fm/rootfile.txt)&overwrite=1")"
check "cannot replace a root-owned file" "$CODE" 403
[[ "$(sudo cat /srv/apps/fm/rootfile.txt)" == root-owned ]]
sudo -u ovapps ln -s /etc /srv/apps/fm/etc-link
sudo -u ovapps ln -s /root /srv/apps/fm/root-link
check "a link to /etc is not followed" "$(api -o /dev/null -w '%{http_code}' "$B/api/files/list?$(q $R fm/etc-link)")" 403
CODE="$(echo -n x | api "${H[@]:2}" -X POST -H 'content-type: application/octet-stream' --data-binary @- -o /dev/null -w '%{http_code}' "$B/api/files/upload?$(q $R fm/root-link/planted.txt)")"
check "no upload through a link to /root" "$CODE" 403
[[ ! -e /root/planted.txt ]]
check "traversal refused" "$(api -o /dev/null -w '%{http_code}' "$B/api/files/list?$(q $R ../../etc)")" 400
check "unknown folder refused" "$(api -o /dev/null -w '%{http_code}' "$B/api/files/list?$(q /etc '')")" 404

echo "== 5. rename, edit, delete"
check "move" "$(api "${H[@]}" -d "{\"root\":\"$R\",\"from\":\"fm/sub/hello.txt\",\"to\":\"fm/sub/hi.txt\"}" $B/api/files/move)" '"ok":true'
TXT="$(api "$B/api/files/text?$(q $R fm/sub/hi.txt)")"
check "text read" "$TXT" '"content":"hello"'
MT="$(echo "$TXT" | jq .mtimeMs)"
check "text save" "$(api "${H[@]}" -X PUT -d "{\"root\":\"$R\",\"path\":\"fm/sub/hi.txt\",\"content\":\"changed\",\"mtimeMs\":$MT}" $B/api/files/text)" '"replaced":true'
[[ "$(sudo cat /srv/apps/fm/sub/hi.txt)" == changed ]]
check "delete folder" "$(api "${H[@]}" -d "{\"root\":\"$R\",\"path\":\"fm/sub\"}" $B/api/files/delete)" '"ok":true'
[[ ! -e /srv/apps/fm/sub ]]
[[ -d /etc && -d /root ]]

echo "== 6. /var/www (owned by root) works too"
sudo install -d /var/www
echo -n 'site' | api "${H[@]:2}" -X POST -H 'content-type: application/octet-stream' --data-binary @- "$B/api/files/upload?$(q /var/www fm-test/index.html)" >/dev/null
[[ "$(cat /var/www/fm-test/index.html)" == site ]]
check "web folder file is world-readable" "$(stat -c '%a' /var/www/fm-test/index.html)" 644
sudo rm -rf /var/www/fm-test

echo "== 7. audit trail and a healthy agent"
AUD="$(api "$B/api/audit?action=file.&limit=100")"
for a in file.upload file.save file.move file.delete file.mkdir file.download; do check "audited $a" "$AUD" "$a"; done
check "agent still answers" "$(api $B/api/agent)" '"available":true'
sudo journalctl -u openvps-agent --no-pager | grep -iE "file helper (failed|could not)" && { echo "agent logged helper failures" >&2; exit 1; } || true
sudo rm -rf /srv/apps/fm
echo "ALL FILE MANAGER CHECKS PASSED"
