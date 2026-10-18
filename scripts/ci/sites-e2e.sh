#!/usr/bin/env bash
# CI end-to-end test of sites and certificates with real systemd, real Nginx, real Certbot
# and Pebble (Let's Encrypt's test CA). Runs on a GitHub Ubuntu runner after OpenVPS is installed.
#
# Pebble validates HTTP-01 challenges by connecting to port 80 of whatever its DNS server
# (pebble-challtestsrv) returns, which is 127.0.0.1 for every name, i.e. this runner's Nginx.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

PEBBLE_VERSION=v2.7.0
B="${OPENVPS_URL:-https://127.0.0.1:7443}"
PASSWORD="${OPENVPS_PASSWORD:-correct horse battery staple}"
JAR="$(mktemp)"
WORK="$(mktemp -d)"
H=(-H 'content-type: application/json' -H 'x-openvps-request: 1')
# The test domains only exist through --resolve: never send them to an HTTP proxy.
curl() { command curl --noproxy '*' "$@"; }
api() { curl -sk -b "$JAR" -c "$JAR" "$@"; }
check() { if [[ "$2" != *"$3"* ]]; then echo "CHECK FAILED: $1: expected '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
refute() { if [[ "$2" == *"$3"* ]]; then echo "CHECK FAILED: $1: did not expect '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
# get DOMAIN PATH [curl args...]: request through the local Nginx as if DNS pointed here.
get() {
  local d="$1" p="$2" out="" _
  shift 2
  for _ in 1 2 3 4 5; do
    out="$(curl -s --max-time 10 --resolve "$d:80:127.0.0.1" --resolve "$d:443:127.0.0.1" "$@" "https://$d$p")" && [[ -n "$out" ]] && break
    sleep 1
  done
  printf '%s' "$out"
}

if [[ -n "${SKIP_SETUP:-}" ]]; then
  # Local dry run: Nginx, Certbot, Pebble and the panel are already set up by the caller.
  cp "${PEBBLE_ROOT:?}" "$WORK/pebble-root.pem"
  LEGACY_SUM="$(sudo sha256sum /etc/nginx/sites-available/legacy.test)"
else
echo "== 1. Nginx, Certbot and the Pebble test CA"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot >/dev/null
sudo systemctl enable --now nginx
for b in pebble pebble-challtestsrv; do
  curl -fsSL "https://github.com/letsencrypt/pebble/releases/download/$PEBBLE_VERSION/$b-linux-amd64.tar.gz" | tar -xz -C "$WORK"
  sudo install -m 0755 "$WORK/$b-linux-amd64/linux/amd64/$b" "/usr/local/bin/$b"
done
# Pebble's own HTTPS endpoint needs a certificate that Certbot (inside the agent) trusts.
sudo install -d -m 0755 /etc/pebble
sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=pebble-test-ca \
  -keyout /etc/pebble/ca.key -out /etc/pebble/ca.pem 2>/dev/null
sudo openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=localhost -keyout /etc/pebble/key.pem -out "$WORK/req.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$WORK/ext"
sudo openssl x509 -req -in "$WORK/req.csr" -CA /etc/pebble/ca.pem -CAkey /etc/pebble/ca.key -CAcreateserial -days 2 -extfile "$WORK/ext" -out /etc/pebble/cert.pem 2>/dev/null
sudo chmod 0644 /etc/pebble/*.pem
sudo tee /etc/pebble/config.json >/dev/null <<'JSON'
{ "pebble": { "listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
  "certificate": "/etc/pebble/cert.pem", "privateKey": "/etc/pebble/key.pem",
  "httpPort": 80, "tlsPort": 5001, "ocspResponderURL": "", "externalAccountBindingRequired": false } }
JSON
sudo systemd-run --unit pebble-dns --quiet /usr/local/bin/pebble-challtestsrv -defaultIPv4 127.0.0.1 -defaultIPv6 "" \
  -dns01 127.0.0.1:8053 -http01 "" -https01 "" -tlsalpn01 "" -doh "" -management 127.0.0.1:8055
sudo systemd-run --unit pebble --quiet --setenv=PEBBLE_VA_NOSLEEP=1 /usr/local/bin/pebble -config /etc/pebble/config.json -dnsserver 127.0.0.1:8053
for _ in $(seq 1 30); do curl -s --cacert /etc/pebble/ca.pem https://localhost:14000/dir >/dev/null && break; sleep 1; done
curl -fsS --cacert /etc/pebble/ca.pem https://localhost:14000/dir >/dev/null
curl -fsS --cacert /etc/pebble/ca.pem https://localhost:15000/roots/0 >"$WORK/pebble-root.pem"
echo "ok - pebble is up"

# A site configured by hand before OpenVPS: must be shown, never changed.
sudo tee /etc/nginx/sites-available/legacy.test >/dev/null <<'NGX'
server {
    listen 80;
    server_name legacy.test www.legacy.test;
    location / { return 200 "legacy site\n"; }
}
NGX
sudo ln -sf /etc/nginx/sites-available/legacy.test /etc/nginx/sites-enabled/legacy.test
sudo nginx -t -q && sudo systemctl reload nginx
LEGACY_SUM="$(sudo sha256sum /etc/nginx/sites-available/legacy.test)"

echo "== 2. point OpenVPS at the test CA and run provision"
sudo jq '.sites = {acmeServer: "https://localhost:14000/dir", acmeCaBundle: "/etc/pebble/ca.pem", dnsServers: ["127.0.0.1:8053"]}' \
  /etc/openvps/config.json | sudo tee "$WORK/config.json" >/dev/null
sudo install -m 0640 -o root -g openvps "$WORK/config.json" /etc/openvps/config.json
sudo timeout 180 script -qec "openvps provision" /dev/null | tee "$WORK/provision.log"
check "provision found nginx" "$(cat "$WORK/provision.log")" 'Nginx found'
check "provision found certbot" "$(cat "$WORK/provision.log")" 'Certbot found'
sudo systemctl restart openvps
for _ in $(seq 1 30); do curl -sk $B/api/health >/dev/null && break; sleep 1; done
fi

echo "== 3. sign in"
if [[ "$(curl -sk $B/api/setup/status)" == *'"needsSetup":true'* ]]; then
  TOKEN="$(sudo openvps setup-token)"
  api "${H[@]}" -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"$PASSWORD\"}" $B/api/setup >/dev/null
else
  api "${H[@]}" -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" $B/api/auth/login >/dev/null
fi

echo "== 4. overview"
SITES="$(api $B/api/sites)"
check "nginx detected" "$(echo "$SITES" | jq -c .nginx)" '"installed":true'
check "nginx config ok" "$(echo "$SITES" | jq -c .nginx)" '"configOk":true'
check "certbot detected" "$(echo "$SITES" | jq -c .nginx.certbot)" '"installed":true'
check "hand-made site listed read-only" "$(echo "$SITES" | jq -c .nginx.existing)" 'legacy.test'

echo "== 5. single-page app (React build) with HTTPS"
sudo install -d -m 0755 /srv/apps/admin/dist/assets
echo '<!doctype html><title>admin</title><div id="root">admin spa</div>' | sudo tee /srv/apps/admin/dist/index.html >/dev/null
echo 'console.log("app")' | sudo tee /srv/apps/admin/dist/assets/app.3f9a1c.js >/dev/null
SPEC='{"name":"admin","domains":["admin.openvps.test","www.admin.openvps.test"],"type":"spa","upstreamPort":null,"root":"/srv/apps/admin/dist","https":true,"forceHttps":true,"hsts":false,"maxBodyMb":25}'
R="$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":true}" $B/api/sites)"
echo "$R" | jq -c '{checks, certificateError, cert: .certificate.domains}'
check "pre-flight passed" "$(echo "$R" | jq -c '[.checks[].httpOk]')" '[true,true]'
check "certificate issued" "$(echo "$R" | jq -c .certificate.domains)" 'admin.openvps.test'
check "https active" "$(echo "$R" | jq -c .state)" '"httpsActive":true'
check "served over trusted https" "$(get admin.openvps.test / --cacert "$WORK/pebble-root.pem")" 'admin spa'
check "spa fallback for client routes" "$(get admin.openvps.test /users/42 --cacert "$WORK/pebble-root.pem")" 'admin spa'
check "www name in certificate" "$(get www.admin.openvps.test / --cacert "$WORK/pebble-root.pem")" 'admin spa'
check "assets cached" "$(get admin.openvps.test /assets/app.3f9a1c.js --cacert "$WORK/pebble-root.pem" -D - | tr '[:upper:]' '[:lower:]')" 'cache-control: public, max-age=2592000'
sudo ln -s /etc/passwd /srv/apps/admin/dist/leak.txt && sudo chown -h nobody /srv/apps/admin/dist/leak.txt
refute "planted symlink not followed" "$(get admin.openvps.test /leak.txt --cacert "$WORK/pebble-root.pem")" 'root:x:0'
sudo rm -f /srv/apps/admin/dist/leak.txt
check "missing asset is 404" "$(get admin.openvps.test /assets/nope.js --cacert "$WORK/pebble-root.pem" -o /dev/null -w '%{http_code}')" '404'
check "http redirects to https" "$(curl -s --resolve admin.openvps.test:80:127.0.0.1 -o /dev/null -w '%{http_code} %{redirect_url}' http://admin.openvps.test/x)" '301 https://admin.openvps.test/x'
sudo test -f /etc/letsencrypt/renewal/openvps-admin.conf && echo "ok - renewal config written"
check "renewal reloads nginx" "$(sudo cat /etc/letsencrypt/renewal/openvps-admin.conf)" 'reload nginx'

echo "== 6. app behind a domain (reverse proxy, HTTP only)"
python3 -c 'import http.server as h
class R(h.BaseHTTPRequestHandler):
    def do_GET(s):
        b=("app saw host=%s xfp=%s upgrade=%s" % (s.headers["Host"], s.headers["X-Forwarded-Proto"], s.headers.get("Upgrade"))).encode()
        s.send_response(200); s.end_headers(); s.wfile.write(b)
    def log_message(*a): pass
h.HTTPServer(("127.0.0.1",4300),R).serve_forever()' &
APP_PID=$!
SPEC='{"name":"shop","domains":["shop.openvps.test"],"type":"proxy","upstreamPort":4300,"root":null,"https":false,"forceHttps":true,"hsts":false,"maxBodyMb":10}'
check "proxy site created" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":false}" $B/api/sites)" '"enabled":true'
check "proxied with forwarding headers" "$(curl -s --resolve shop.openvps.test:80:127.0.0.1 http://shop.openvps.test/)" 'app saw host=shop.openvps.test xfp=http'
check "websocket upgrade forwarded" "$(curl -s --resolve shop.openvps.test:80:127.0.0.1 -H 'Upgrade: websocket' -H 'Connection: upgrade' http://shop.openvps.test/)" 'upgrade=websocket'
check "turn on https later" "$(api "${H[@]}" -X POST -d '{}' $B/api/sites/shop/certificate | jq -c .state)" '"httpsActive":true'
check "proxied over https" "$(get shop.openvps.test / --cacert "$WORK/pebble-root.pem")" 'xfp=https'
kill "$APP_PID"

echo "== 7. the panel on its own domain"
SPEC='{"name":"panel","domains":["panel.openvps.test"],"type":"panel","upstreamPort":null,"root":null,"https":true,"forceHttps":true,"hsts":false,"maxBodyMb":25}'
check "panel site with certificate" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":true}" $B/api/sites | jq -c .state)" '"httpsActive":true'
check "panel reachable through nginx" "$(get panel.openvps.test /api/health --cacert "$WORK/pebble-root.pem")" '"status":"ok"'
PJAR="$(mktemp)"
curl -s -c "$PJAR" --resolve panel.openvps.test:443:127.0.0.1 --cacert "$WORK/pebble-root.pem" "${H[@]}" \
  -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" https://panel.openvps.test/api/auth/login >/dev/null
check "login via domain sets a secure cookie" "$(awk '$6 ~ /^__Host-/ {print "secure=" $4}' "$PJAR")" 'secure=TRUE'
SPEC='{"name":"panel2","domains":["panel2.openvps.test"],"type":"panel","upstreamPort":null,"root":null,"https":false,"forceHttps":true,"hsts":false,"maxBodyMb":25}'
check "only one panel site" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":false}" $B/api/sites)" '"error"'

echo "== 8. refusals leave nginx untouched"
SPEC='{"name":"steal","domains":["www.legacy.test"],"type":"proxy","upstreamPort":4300,"root":null,"https":false,"forceHttps":true,"hsts":false,"maxBodyMb":10}'
check "conflict with hand-made site" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":false}" $B/api/sites)" 'already served by'
SPEC='{"name":"etc","domains":["etc.openvps.test"],"type":"static","upstreamPort":null,"root":"/etc","https":false,"forceHttps":true,"hsts":false,"maxBodyMb":10}'
check "static root outside allowed folders" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":false}" $B/api/sites)" '"error"'
SPEC='{"name":"bad","domains":["bad.openvps.test;include /etc/shadow"],"type":"proxy","upstreamPort":4300,"root":null,"https":false,"forceHttps":true,"hsts":false,"maxBodyMb":10}'
check "domain injection rejected" "$(api "${H[@]}" -d "{\"spec\":$SPEC,\"issueCertificate\":false}" $B/api/sites)" '"error"'
check "legacy site unchanged" "$(sudo sha256sum /etc/nginx/sites-available/legacy.test)" "$LEGACY_SUM"
check "legacy site still served" "$(curl -s --resolve legacy.test:80:127.0.0.1 http://legacy.test/)" 'legacy site'
sudo nginx -t -q && echo "ok - nginx -t passes"

echo "== 9. renewal by certbot's timer path (as root, outside OpenVPS)"
BEFORE="$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.openvps.test 2>/dev/null | openssl x509 -noout -serial)"
sudo env REQUESTS_CA_BUNDLE="${PEBBLE_CA:-/etc/pebble/ca.pem}" certbot renew --cert-name openvps-admin --force-renewal --non-interactive -q
sleep 2
AFTER="$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.openvps.test 2>/dev/null | openssl x509 -noout -serial)"
[[ -n "$AFTER" && "$BEFORE" != "$AFTER" ]] || { echo "renewed certificate not served ($BEFORE -> $AFTER)" >&2; exit 1; }
echo "ok - renewed certificate is served after the deploy hook reloaded nginx"

echo "== 10. certificates list and delete"
CERTS="$(api $B/api/certificates)"
check "certificates listed" "$(echo "$CERTS" | jq -c '[.certificates[].name]')" 'openvps-admin'
check "delete site and certificate" "$(api "${H[@]}" -X DELETE "$B/api/sites/shop?deleteCertificate=1")" '"ok":true'
sudo test ! -e /etc/nginx/sites-enabled/openvps-shop.conf && echo "ok - config removed"
sudo test ! -e /etc/letsencrypt/live/openvps-shop && echo "ok - certificate removed"
refute "shop gone" "$(curl -s --resolve shop.openvps.test:80:127.0.0.1 http://shop.openvps.test/)" 'app saw'
check "audit trail" "$(api "$B/api/audit?action=site.&limit=50")" 'site.delete'
sudo nginx -t -q && echo "ok - nginx -t passes"
refute "no nginx warnings" "$(sudo nginx -t 2>&1)" '[warn]'
echo "ALL SITE CHECKS PASSED"
