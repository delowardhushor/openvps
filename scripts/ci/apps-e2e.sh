#!/usr/bin/env bash
# CI end-to-end test of application management with real systemd and real PM2.
# Runs on a GitHub Ubuntu runner after OpenVPS has been installed from the package.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

B=https://127.0.0.1:7443
JAR="$(mktemp)"
H=(-H 'content-type: application/json' -H 'x-openvps-request: 1')
api() { curl -sk -b "$JAR" -c "$JAR" "$@"; }
check() { if [[ "$2" != *"$3"* ]]; then echo "CHECK FAILED: $1: expected '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
wait_http() { # wait_http URL EXPECTED
  for _ in $(seq 1 30); do
    if out="$(curl -s --max-time 2 "$1")" && [[ "$out" == *"$2"* ]]; then echo "$out"; return 0; fi
    sleep 1
  done
  echo "timeout waiting for $1 to return '$2' (last: ${out:-none})" >&2
  return 1
}

echo "== 1. root already runs an app under its own PM2 (like an existing server)"
NPM=/usr/local/bin/npm
[[ -x $NPM ]] || NPM="$(command -v npm)"
sudo "$NPM" install -g --no-audit --no-fund pm2@6 >/dev/null
ROOTPM2="$(sudo bash -lc 'command -v pm2')"
sudo mkdir -p /root/legacy
echo "require('http').createServer((q,s)=>s.end('legacy ok')).listen(4101); console.log('legacy up')" | sudo tee /root/legacy/server.js >/dev/null
sudo env HOME=/root PM2_HOME=/root/.pm2 "$ROOTPM2" start /root/legacy/server.js --name legacy-api
wait_http http://127.0.0.1:4101 'legacy ok' >/dev/null
sudo openvps provision

echo "== 2. sign in"
TOKEN="$(sudo openvps setup-token)"
api "${H[@]}" -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"correct horse battery staple\"}" $B/api/setup >/dev/null

echo "== 3. agent and root processes"
INFO="$(api $B/api/agent)"
check "agent available" "$INFO" '"available":true'
check "root pm2 available" "$(echo "$INFO" | jq -c .info.root)" '"available":true'
check "apps pm2 available" "$(echo "$INFO" | jq -c .info.apps)" '"available":true'
PROCS="$(api $B/api/processes)"
check "root app listed" "$PROCS" '"name":"legacy-api"'
check "restart root app" "$(api "${H[@]}" -X POST $B/api/processes/root/legacy-api/restart)" '"status":"online"'
wait_http http://127.0.0.1:4101 'legacy ok' >/dev/null
check "root app logs" "$(api "$B/api/processes/root/legacy-api/logs?stream=out&lines=20")" 'legacy up'

echo "== 4. create an app as the unprivileged apps user"
sudo install -d -o ovapps -g ovapps /srv/apps/demo
echo "require('http').createServer((q,s)=>s.end('demo '+process.env.GREETING+' as '+require('os').userInfo().username)).listen(process.env.PORT); console.log('demo listening on', process.env.PORT)" |
  sudo -u ovapps tee /srv/apps/demo/server.js >/dev/null
RUNTIME="$(echo "$INFO" | jq -r '.info.runtimes[0].path')"
SPEC="{\"name\":\"demo\",\"cwd\":\"/srv/apps/demo\",\"startType\":\"file\",\"script\":\"server.js\",\"npmScript\":null,\"args\":[],\"runtime\":\"$RUNTIME\",\"instances\":1,\"execMode\":\"fork\",\"maxMemoryMb\":256}"
CREATED="$(api "${H[@]}" -d "{\"spec\":$SPEC,\"env\":{\"PORT\":\"4100\",\"GREETING\":\"hello\",\"SECRET_KEY\":\"ci-secret-value\"}}" $B/api/apps)"
check "app created" "$CREATED" '"status":"online"'
[[ "$CREATED" != *ci-secret-value* ]] || { echo "secret leaked in API response" >&2; exit 1; }
check "app serves traffic as ovapps" "$(wait_http http://127.0.0.1:4100 'demo hello')" 'as ovapps'
check "app logs" "$(api "$B/api/processes/apps/demo/logs?stream=out&lines=20")" 'demo listening on 4100'

echo "== 5. env change restarts with new values"
api "${H[@]}" -X PUT -d '{"set":{"GREETING":"world"},"unset":[],"restart":true}' $B/api/apps/demo/env >/dev/null
check "new env applied" "$(wait_http http://127.0.0.1:4100 'demo world')" 'demo world'

echo "== 6. survives a PM2 daemon restart (as after a reboot)"
sudo systemctl restart openvps-apps
check "app resurrected" "$(wait_http http://127.0.0.1:4100 'demo world')" 'demo world'
sudo systemctl restart openvps-agent
sleep 2
check "agent restart does not kill apps" "$(wait_http http://127.0.0.1:4100 'demo world')" 'demo world'

echo "== 7. stop, start, delete"
check "stop" "$(api "${H[@]}" -X POST $B/api/processes/apps/demo/stop)" '"status":"stopped"'
if curl -s --max-time 2 http://127.0.0.1:4100 >/dev/null; then echo "app still answering after stop" >&2; exit 1; fi
check "start" "$(api "${H[@]}" -X POST $B/api/processes/apps/demo/start)" '"status":"online"'
wait_http http://127.0.0.1:4100 'demo world' >/dev/null
check "delete" "$(api "${H[@]}" -X DELETE $B/api/apps/demo)" '"ok":true'
check "audit trail" "$(api "$B/api/audit?action=app.&limit=50")" 'app.delete'
wait_http http://127.0.0.1:4101 'legacy ok' >/dev/null && echo "ok - root app untouched throughout"
echo "ALL APPLICATION CHECKS PASSED"
