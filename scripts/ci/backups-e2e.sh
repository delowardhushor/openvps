#!/usr/bin/env bash
# CI end-to-end test of backups with real systemd (the agent's sandbox: ProtectSystem=full,
# UMask=0077), real tar, a real S3-compatible server (SeaweedFS), a real MongoDB with
# authentication and the real MongoDB Database Tools. Runs on a GitHub Ubuntu runner after
# OpenVPS is installed from the package; everything is driven through the panel API.
#
# SeaweedFS stands in for MinIO: MinIO stopped publishing binaries and container images in
# 2025, and a pinned, checksummed single binary keeps this test reproducible. Any S3-compatible
# server exercises the same signing, multipart, listing and deletion code.
#
# Local dry run (no root, no systemd): start the S3 server, mongod (with a user), the panel and
# the agent yourself, then set SKIP_SETUP=1 and the variables below.
#   S3_ENDPOINT S3_KEY S3_SECRET  APPS_DIR BACKUP_DIR PANEL_DATA_DIR  MONGO_PORT MONGOSH MONGORESTORE
#   OPENVPS_URL SETUP_TOKEN
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

SEAWEED_VERSION=4.48
SEAWEED_SHA256=4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124

B="${OPENVPS_URL:-https://127.0.0.1:7443}"
PASSWORD="${OPENVPS_PASSWORD:-correct horse battery staple}"
LOCAL="${SKIP_SETUP:-}"
APPS="${APPS_DIR:-/srv/apps}"
BKDIR="${BACKUP_DIR:-/var/backups/openvps}"
PANEL_DATA="${PANEL_DATA_DIR:-/var/lib/openvps}"
S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:8333}"
S3_KEY="${S3_KEY:-ovpsci}"
S3_SECRET="${S3_SECRET:-ovpsci-secret-key-1}"
S3_ADMIN_KEY="${S3_ADMIN_KEY:-ovpsadmin}"
S3_ADMIN_SECRET="${S3_ADMIN_SECRET:-ovpsadmin-secret-key-1}"
BUCKET=openvps-ci-backups
PREFIX=ci/
MONGO_PORT="${MONGO_PORT:-27017}"
MONGO_USER=ovbackup
MONGO_PASS='Pa55-ci:w0rd'
MONGO_PASS_ENC='Pa55-ci%3Aw0rd'
MONGO_URI="mongodb://$MONGO_USER:$MONGO_PASS_ENC@127.0.0.1:$MONGO_PORT/?authSource=admin"
MONGOSH="${MONGOSH:-mongosh}"
MONGORESTORE="${MONGORESTORE:-mongorestore}"
JAR="$(mktemp)"
WORK="$(mktemp -d)"
H=(-H 'content-type: application/json' -H 'x-openvps-request: 1')

# Everything here is on loopback: never send it to an HTTP proxy.
curl() { command curl --noproxy '*' "$@"; }
api() { curl -sk -b "$JAR" -c "$JAR" "$@"; }
check() { if [[ "$2" != *"$3"* ]]; then echo "CHECK FAILED: $1: expected '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
refute() { if [[ "$2" == *"$3"* ]]; then echo "CHECK FAILED: $1: did not expect '$3' in: $2" >&2; exit 1; fi; echo "ok - $1"; }
eq() { if [[ "$2" != "$3" ]]; then echo "CHECK FAILED: $1: expected '$3', got '$2'" >&2; exit 1; fi; echo "ok - $1"; }
root() { if [[ $EUID -eq 0 || -n "$LOCAL" ]]; then "$@"; else sudo "$@"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
fmode() { root stat -c '%a' "$1" 2>/dev/null || root stat -f '%Lp' "$1"; }
fsize() { root stat -c '%s' "$1" 2>/dev/null || root stat -f '%z' "$1"; }
chown_apps() { if [[ -z "$LOCAL" ]]; then root chown -R ovapps:ovapps "$@"; fi; }

# Talk to the S3 server directly (signed by curl, independent of OpenVPS's own client). The
# "ci" key can only use the one bucket, like the key the docs tell people to create.
s3curl() { curl -s --user "$S3_KEY:$S3_SECRET" --aws-sigv4 "aws:amz:us-east-1:s3" "$@"; }
s3keys() { s3curl "$S3_ENDPOINT/$BUCKET?list-type=2&prefix=$1" | { grep -o '<Key>[^<]*</Key>' || true; } | sed 's/<[^>]*>//g' | sort; }
s3size() { s3curl -I "$S3_ENDPOINT/$BUCKET/$1" | tr -d '\r' | awk 'tolower($1) == "content-length:" {print $2}'; }
s3admin() { curl -s --user "$S3_ADMIN_KEY:$S3_ADMIN_SECRET" --aws-sigv4 "aws:amz:us-east-1:s3" "$@"; }
s3put() { s3curl -X PUT --data-binary "@$2" -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/$BUCKET/$1"; }

mq() { "$MONGOSH" --quiet "$MONGO_URI" --eval "$1"; }
mongo_state() {
  mq 'const o = [];
      for (const [d, c] of [["appdb", "users"], ["appdb", "orders"], ["logsdb", "events"]]) {
        const col = db.getSiblingDB(d).getCollection(c);
        let idx = null;
        try { idx = col.getIndexes().map((i) => i.name).sort(); } catch (e) { idx = null; }
        o.push([d, c, col.find().sort({_id: 1}).toArray(), idx]);
      }
      print(JSON.stringify(o))'
}

cat >"$WORK/treesig.py" <<'PY'
# Prints one line per file, folder and link below a directory: type, mode, owner, path and a
# content hash or link target. Names given as extra arguments (shell patterns) are skipped.
import fnmatch, hashlib, os, stat, sys

skip = sys.argv[2:]
out = []

def rec(path, rel):
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        kind, extra = 'l', os.readlink(path)
    elif stat.S_ISDIR(st.st_mode):
        kind, extra = 'd', ''
    else:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        kind, extra = 'f', h.hexdigest()
    out.append('%s %o %d:%d %s %s' % (kind, stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid, rel, extra))
    if kind == 'd':
        for name in sorted(os.listdir(path)):
            if not any(fnmatch.fnmatch(name, p) for p in skip):
                rec(os.path.join(path, name), rel + '/' + name)

rec(sys.argv[1], '.')
print('\n'.join(out))
PY
tree_sig() { root python3 -I "$WORK/treesig.py" "$@" | sha256; }
tree_dump() { root python3 -I "$WORK/treesig.py" "$@"; }
# What a restore may legitimately leave different: things the plan excludes, and files made later.
SKIP=(node_modules '*.log' new-after-backup.txt)

# Wait for a run (backup, check or restore) to end and print it as JSON.
run_wait() {
  local id="$1" out="" st="" _
  for _ in $(seq 1 "${2:-300}"); do
    out="$(api "$B/api/backups/runs/$id")"
    st="$(echo "$out" | jq -r '.run.status // "unknown"')"
    if [[ "$st" != running ]]; then echo "$out" | jq -c .run; return 0; fi
    sleep 1
  done
  echo "timed out waiting for run $id: $out" >&2
  return 1
}
# do_task URL [JSON]: start a task, wait for it and print the finished run.
do_task() {
  local resp id
  if [[ -n "${2-}" ]]; then resp="$(api "${H[@]}" -X POST -d "$2" "$B$1")"; else resp="$(api "${H[@]}" -X POST "$B$1")"; fi
  id="$(echo "$resp" | jq -er '.run.id')" || { echo "could not start the task: $resp" >&2; return 1; }
  run_wait "$id"
}
plan_body() { # NAME SOURCES KEEP_LOCAL DESTINATION RETENTION [MONGO_URI]
  jq -nc --arg name "$1" --argjson sources "$2" --argjson keepLocal "$3" --arg dest "$4" --argjson ret "$5" --arg uri "${6-}" \
    '{name: $name, sources: $sources, schedule: {kind: "manual"}, retention: $ret, keepLocal: $keepLocal,
      destination: (if $dest == "" then null else $dest end), enabled: true}
     + (if $uri == "" then {} else {mongoUris: {main: $uri}} end)'
}
restore_body() { # ARTIFACT DROP ITEM...  (confirm is always the plan name "nightly")
  local art="$1" drop="$2" where="$3"
  shift 3
  jq -nc --arg a "$art" --argjson drop "$drop" --arg where "$where" '$ARGS.positional | map(fromjson) | {where: $where, artifact: $a, confirm: "nightly", drop: $drop, items: .}' --args "$@"
}
FILE_ITEM_ORIG='{"file":"files-shop.tar.gz","target":"original"}'
FILE_ITEM_ALT='{"file":"files-shop.tar.gz","target":"alternate"}'
MONGO_ITEMS=('{"file":"mongodb-main--appdb.archive.gz","target":"original"}' '{"file":"mongodb-main--logsdb.archive.gz","target":"original"}')

if [[ -z "$LOCAL" ]]; then
  echo "== 1. S3-compatible storage (SeaweedFS), MongoDB and the MongoDB Database Tools"
  mkdir "$WORK/weed-dl"
  curl -fsSL -o "$WORK/weed-dl/weed.tar.gz" "https://github.com/seaweedfs/seaweedfs/releases/download/$SEAWEED_VERSION/linux_amd64.tar.gz"
  echo "$SEAWEED_SHA256  $WORK/weed-dl/weed.tar.gz" | sha256sum -c - >/dev/null
  tar -xzf "$WORK/weed-dl/weed.tar.gz" -C "$WORK/weed-dl"
  sudo install -m 0755 "$WORK/weed-dl/weed" /usr/local/bin/weed
  sudo install -d -m 0700 /var/lib/ovps-ci-s3
  # One key may only use the test bucket (what the docs advise); the other creates it.
  printf '{"identities":[{"name":"ci","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read:%s","Write:%s","List:%s","Tagging:%s"]},{"name":"admin","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin"]}]}\n' \
    "$S3_KEY" "$S3_SECRET" "$BUCKET" "$BUCKET" "$BUCKET" "$BUCKET" "$S3_ADMIN_KEY" "$S3_ADMIN_SECRET" >"$WORK/s3.json"
  sudo systemd-run --unit ovps-ci-s3 --quiet /usr/local/bin/weed server -ip=127.0.0.1 -dir=/var/lib/ovps-ci-s3 \
    -s3 -s3.port=8333 "-s3.config=$WORK/s3.json" -master.volumeSizeLimitMB=256 -volume.max=20

  curl -fsSL https://pgp.mongodb.com/server-8.0.asc | sudo gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" |
    sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mongodb-org-server mongodb-mongosh mongodb-database-tools >/dev/null
  sudo systemctl start mongod
  for _ in $(seq 1 60); do mongosh --quiet --eval 'db.runCommand({ping: 1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
  mongosh --quiet --eval "db.getSiblingDB('admin').createUser({user: '$MONGO_USER', pwd: '$MONGO_PASS', roles: ['root']})" >/dev/null
  printf '\nsecurity:\n  authorization: enabled\n' | sudo tee -a /etc/mongod.conf >/dev/null
  sudo systemctl restart mongod
  for _ in $(seq 1 60); do mq 'db.runCommand({ping: 1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done

  for _ in $(seq 1 60); do [[ "$(curl -s -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/")" == 403 ]] && break; sleep 1; done
  echo "ok - storage and database are up"

  echo "== 2. run provision so the agent sees the new tools"
  sudo timeout 180 script -qec "openvps provision" /dev/null | tee "$WORK/provision.log"
  check "provision found mongodump" "$(cat "$WORK/provision.log")" 'mongodump found'
  for _ in $(seq 1 30); do curl -sk "$B/api/health" >/dev/null && break; sleep 1; done
fi
for _ in $(seq 1 30); do
  [[ "$(s3admin -X PUT -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/$BUCKET")" == 200 ]] && break
  sleep 1
done
check "bucket is private" "$(curl -s -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/$BUCKET?list-type=2")" '403'
check "database requires a login" "$("$MONGOSH" --quiet "mongodb://127.0.0.1:$MONGO_PORT/appdb" --eval 'try { db.users.countDocuments(); print("open") } catch (e) { print("denied") }' 2>&1 | tail -1)" 'denied'

echo "== 3. sign in"
if [[ "$(curl -sk "$B/api/setup/status")" == *'"needsSetup":true'* ]]; then
  TOKEN="${SETUP_TOKEN:-$(root openvps setup-token)}"
  api "${H[@]}" -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"$PASSWORD\"}" "$B/api/setup" >/dev/null
else
  api "${H[@]}" -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" "$B/api/auth/login" >/dev/null
fi

echo "== 4. agent, tools and the systemd sandbox"
OV="$(api "$B/api/backups")"
check "agent available" "$(echo "$OV" | jq -c .agent)" '"available":true'
check "tar found" "$(echo "$OV" | jq -c .status.tar)" 'true'
check "mongodump found with a version" "$(echo "$OV" | jq -r .status.mongodump.version)" 'version'
check "mongorestore found with a version" "$(echo "$OV" | jq -r .status.mongorestore.version)" 'version'
check "file roots include the apps folder" "$(echo "$OV" | jq -c .status.fileRoots)" "$APPS"
eq "backup folder is root-only" "$(fmode "$BKDIR")" '700'
if [[ -z "$LOCAL" ]]; then
  UNIT="$(systemctl show openvps-agent -p ProtectSystem -p UMask | tr '\n' ' ')"
  check "unit has ProtectSystem=full" "$UNIT" 'ProtectSystem=full'
  check "unit has UMask=0077" "$UNIT" 'UMask=0077'
  PID="$(systemctl show -p MainPID --value openvps-agent)"
  eq "agent process runs with umask 0077" "$(root awk '/^Umask:/ {print $2}' "/proc/$PID/status")" '0077'
  check "agent sees /etc read-only" "$(root awk '$5 == "/etc" {print "etc:" $6}' "/proc/$PID/mountinfo")" 'etc:ro'
  check "agent sees /usr read-only" "$(root awk '$5 == "/usr" {print "usr:" $6}' "/proc/$PID/mountinfo")" 'usr:ro'
  if sudo -u nobody ls "$BKDIR" >/dev/null 2>&1; then echo "backup folder readable by other users" >&2; exit 1; fi
  echo "ok - other users cannot read the backup folder"
fi

echo "== 5. cloud storage settings"
TARGET="$(jq -nc --arg e "$S3_ENDPOINT" --arg b "$BUCKET" --arg p "$PREFIX" '{endpoint: $e, region: "us-east-1", bucket: $b, prefix: $p, pathStyle: true}')"
dest_body() { jq -nc --argjson t "$1" --arg k "$2" --arg s "$3" --arg n "${4-}" '{target: $t, secrets: {accessKeyId: $k, secretAccessKey: $s}} + (if $n == "" then {} else {name: $n} end)'; }
R="$(api "${H[@]}" -d "$(dest_body "$TARGET" "$S3_KEY" 'not-the-secret-value')" "$B/api/backups/destinations/test")"
check "wrong secret is rejected" "$R" '"error"'
refute "wrong secret is not echoed" "$R" 'not-the-secret-value'
R="$(api "${H[@]}" -d "$(dest_body "$(echo "$TARGET" | jq -c '.bucket = "no-such-bucket-here"')" "$S3_KEY" "$S3_SECRET")" "$B/api/backups/destinations/test")"
check "missing bucket is rejected" "$R" '"error"'
refute "real secret is not echoed" "$R" "$S3_SECRET"
R="$(api "${H[@]}" -d "$(dest_body "$TARGET" "$S3_KEY" "$S3_SECRET")" "$B/api/backups/destinations/test")"
check "connection test passes against the real server" "$R" '"ok":true'
R="$(api "${H[@]}" -d "$(dest_body "$TARGET" "$S3_KEY" "$S3_SECRET" ci-bucket)" "$B/api/backups/destinations")"
check "destination saved" "$R" '"name":"ci-bucket"'
refute "secret never returned" "$R" "$S3_SECRET"
check "test leaves no objects behind" "$(s3keys "$PREFIX" | wc -l | tr -d ' ')" '0'
R="$(api "${H[@]}" -d "$(dest_body "$TARGET" nokeyatall 'wrong-secret-value' ci-bad)" "$B/api/backups/destinations")"
check "second (broken) destination saved" "$R" '"name":"ci-bad"'

echo "== 6. data to protect: a folder owned by the apps user and a MongoDB with authentication"
root rm -rf "$APPS/shop"
root install -d -m 0755 "$APPS/shop/data/uploads" "$APPS/shop/data/empty" "$APPS/shop/node_modules/lib" "$APPS/shop/bin"
echo 'console.log("v1")' | root tee "$APPS/shop/index.js" >/dev/null
echo 'SECRET=hunter2' | root tee "$APPS/shop/.env" >/dev/null
root chmod 0600 "$APPS/shop/.env"
printf '#!/bin/sh\necho run\n' | root tee "$APPS/shop/bin/run.sh" >/dev/null
root chmod 0755 "$APPS/shop/bin/run.sh"
echo 'first upload' | root tee "$APPS/shop/data/uploads/a.txt" >/dev/null
# A non-ASCII name (macOS rewrites those on extraction, so only the real run uses one).
UNI_NAME='café menu.txt'
[[ -z "$LOCAL" ]] || UNI_NAME='cafe menu.txt'
echo 'menu' | root tee "$APPS/shop/data/uploads/$UNI_NAME" >/dev/null
head -c 1048576 /dev/urandom | root tee "$APPS/shop/data/uploads/photo.bin" >/dev/null
root ln -s index.js "$APPS/shop/latest.js"
echo 'cached' | root tee "$APPS/shop/node_modules/lib/skip.txt" >/dev/null
echo 'noise' | root tee "$APPS/shop/debug.log" >/dev/null
echo 'noise' | root tee "$APPS/shop/data/app.log" >/dev/null
chown_apps "$APPS/shop"
SIG0="$(tree_sig "$APPS/shop" "${SKIP[@]}")"
mq 'const a = db.getSiblingDB("appdb");
    a.users.drop(); a.orders.drop(); db.getSiblingDB("logsdb").events.drop(); db.getSiblingDB("otherdb").secret.drop();
    a.users.insertMany(Array.from({length: 100}, (_, i) => ({_id: i, name: "user-" + i, pad: "x".repeat(200)})));
    a.users.createIndex({name: 1});
    a.orders.insertMany(Array.from({length: 50}, (_, i) => ({_id: i, total: i * 10})));
    db.getSiblingDB("logsdb").events.insertMany(Array.from({length: 10}, (_, i) => ({_id: i, msg: "event " + i})));
    db.getSiblingDB("otherdb").secret.insertOne({_id: 1, v: "not in the plan"})' >/dev/null
STATE0="$(mongo_state)"
check "seeded 100 users" "$STATE0" '"user-99"'

echo "== 7. plan and first backup (folder + two databases, local + bucket)"
SOURCES="$(jq -nc --arg p "$APPS/shop" '[{type: "files", name: "shop", path: $p, exclude: ["node_modules", "*.log"]}, {type: "mongodb", name: "main", databases: ["appdb", "logsdb"]}]')"
RETENTION_WIDE='{"keepLast":10,"maxAgeDays":30}'
R="$(api "${H[@]}" -d "$(plan_body nightly "$SOURCES" true ci-bucket "$RETENTION_WIDE" "$MONGO_URI")" "$B/api/backups/plans")"
check "plan created" "$R" '"name":"nightly"'
refute "plan response has no password" "$R" 'w0rd'
check "database file does not hold the S3 secret" "$(root sh -c 'cat "$1"/openvps.db* | grep -cF -- "$2" || true' _ "$PANEL_DATA" "$S3_SECRET")" '0'
check "database file does not hold the MongoDB password" "$(root sh -c 'cat "$1"/openvps.db* | grep -cF -- "$2" || true' _ "$PANEL_DATA" "$MONGO_PASS_ENC" )" '0'
refute "listing has no password" "$(api "$B/api/backups")" 'w0rd'

: >"$WORK/argv.log"
( while :; do ps -axo args= 2>/dev/null | grep '[m]ongodump' >>"$WORK/argv.log" || true; sleep 0.05; done ) &
SAMPLER=$!
RUN="$(do_task /api/backups/plans/nightly/run)"
kill "$SAMPLER" 2>/dev/null || true
wait "$SAMPLER" 2>/dev/null || true
echo "$RUN" | jq -c '{status, artifact, sizeBytes, message, destinations: .result.destinations, pruned: .result.pruned}'
check "backup succeeded" "$(echo "$RUN" | jq -c .status)" '"succeeded"'
ART1="$(echo "$RUN" | jq -r .artifact)"
[[ "$ART1" =~ ^nightly-[0-9]{8}-[0-9]{6}\.ovbk\.tar$ ]] || { echo "unexpected artifact name: $ART1" >&2; exit 1; }
echo "ok - artifact named $ART1"
check "stored in both places" "$(echo "$RUN" | jq -c .result.destinations)" '{"local":{"ok":true},"s3":{"ok":true}}'
eq "no warnings" "$(echo "$RUN" | jq -r '.message // ""')" ''
SAMPLED="$(wc -l <"$WORK/argv.log" | tr -d ' ')"
if [[ "$SAMPLED" -gt 0 ]]; then
  refute "mongodump password is not on the command line" "$(cat "$WORK/argv.log")" 'w0rd'
  check "mongodump reads its connection from a config file" "$(cat "$WORK/argv.log")" '--config'
  echo "ok - sampled mongodump's command line $SAMPLED time(s)"
else
  echo "note - mongodump finished before its command line could be sampled"
fi

SIZE1="$(echo "$RUN" | jq -r .sizeBytes)"
eq "local file size" "$(fsize "$BKDIR/nightly/$ART1")" "$SIZE1"
check "local sidecar exists" "$(root ls "$BKDIR/nightly")" "$ART1.json"
eq "local backup folder is root-only" "$(fmode "$BKDIR/nightly")" '700'
eq "local backup file is root-only" "$(fmode "$BKDIR/nightly/$ART1")" '600'
eq "bucket holds the backup and its description" "$(s3keys "${PREFIX}nightly/")" "$(printf '%s\n%s' "${PREFIX}nightly/$ART1" "${PREFIX}nightly/$ART1.json")"
eq "object size in the bucket matches" "$(s3size "${PREFIX}nightly/$ART1")" "$SIZE1"
eq "anonymous download is refused" "$(curl -s -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/$BUCKET/${PREFIX}nightly/$ART1")" '403'
SHA1="$(echo "$RUN" | jq -r .result.sha256)"
SIDECAR="$(root cat "$BKDIR/nightly/$ART1.json")"
eq "sidecar records the checksum" "$(echo "$SIDECAR" | jq -r .artifactSha256)" "$SHA1"
eq "members: folder + two databases" "$(echo "$SIDECAR" | jq -r '[.members[].file] | sort | join(" ")')" 'files-shop.tar.gz mongodb-main--appdb.archive.gz mongodb-main--logsdb.archive.gz'

echo "== 8. the documented by-hand restore works without OpenVPS"
s3curl -o "$WORK/from-bucket.tar" "$S3_ENDPOINT/$BUCKET/${PREFIX}nightly/$ART1"
eq "downloaded copy has the recorded checksum" "$(sha256 <"$WORK/from-bucket.tar")" "$SHA1"
eq "downloaded copy equals the local copy" "$(root cat "$BKDIR/nightly/$ART1" | sha256)" "$SHA1"
mkdir -p "$WORK/hand/shop"
tar -xf "$WORK/from-bucket.tar" -C "$WORK/hand"
tar -xzf "$WORK/hand/files-shop.tar.gz" -C "$WORK/hand/shop"
check "hand restore: env file present" "$(cat "$WORK/hand/shop/.env")" 'SECRET=hunter2'
check "hand restore: unicode file name" "$(ls "$WORK/hand/shop/data/uploads")" ' menu.txt'
if [[ -e "$WORK/hand/shop/node_modules" || -e "$WORK/hand/shop/debug.log" || -e "$WORK/hand/shop/data/app.log" ]]; then echo "excluded files were archived" >&2; exit 1; fi
echo "ok - node_modules and *.log were left out"
"$MONGORESTORE" --quiet --gzip --archive="$WORK/hand/mongodb-main--appdb.archive.gz" --uri "$MONGO_URI" --nsFrom 'appdb.*' --nsTo 'handcheck.*'
eq "hand restore: mongorestore reads the archive" "$(mq 'print(db.getSiblingDB("handcheck").users.countDocuments())')" '100'
mq 'db.getSiblingDB("handcheck").dropDatabase()' >/dev/null
check "databases outside the plan are not in the backup" "$(echo "$SIDECAR" | jq -c '[.members[].file]')" 'main--appdb'
refute "otherdb is not in the backup" "$(echo "$SIDECAR" | jq -c '[.members[].file]')" 'otherdb'

echo "== 9. backup lists, inspect, quick check and Full check"
R="$(api "$B/api/backups/plans/nightly/artifacts")"
eq "listed on this server and in the bucket" "$(echo "$R" | jq -c "[.local[0].name, .remote[0].name, .local[0].complete, .remote[0].complete]")" "[\"$ART1\",\"$ART1\",true,true]"
R="$(api "$B/api/backups/plans/nightly/inspect?where=remote&artifact=$ART1")"
eq "inspect reads the description from the bucket" "$(echo "$R" | jq -r '.manifest.artifact')" "$ART1"
check "inspect names the mongodb source" "$(echo "$R" | jq -c .mongoSources)" '"main"'
eq "inspect sees the folder exists today" "$(echo "$R" | jq -c '.members[] | select(.kind == "files") | .current | [.exists, .allowed]')" '[true,true]'
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "remote", artifact: $a, deep: false}')")"
check "quick check passes" "$(echo "$V" | jq -c .status)" '"succeeded"'
check "quick check uses the checksum stored with the object" "$(echo "$V" | jq -c '[.result.checks[].name]')" 'Checksum recorded at upload'
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "remote", artifact: $a, deep: true}')")"
check "Full check passes" "$(echo "$V" | jq -c .status)" '"succeeded"'
eq "Full check downloaded and verified every byte" "$(echo "$V" | jq -c '[.result.deep, (.result.checks | map(.ok) | all)]')" '[true,true]'
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "local", artifact: $a, deep: true}')")"
check "check of the local copy passes" "$(echo "$V" | jq -c .status)" '"succeeded"'

echo "== 10. a damaged copy in the bucket is caught and never restored"
cp "$WORK/from-bucket.tar" "$WORK/damaged.tar"
printf 'X' | dd of="$WORK/damaged.tar" bs=1 seek=2048 conv=notrunc 2>/dev/null
eq "damaged copy has the same size" "$(wc -c <"$WORK/damaged.tar" | tr -d ' ')" "$SIZE1"
eq "damaged copy uploaded" "$(s3put "${PREFIX}nightly/$ART1" "$WORK/damaged.tar")" '200'
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "remote", artifact: $a, deep: true}')")"
check "Full check fails" "$(echo "$V" | jq -c .status)" '"failed"'
check "Full check says the checksum differs" "$(echo "$V" | jq -r .message)" 'does not match'
echo 'console.log("v1-edited")' | root tee "$APPS/shop/index.js" >/dev/null
SIG_BEFORE="$(tree_sig "$APPS/shop" "${SKIP[@]}")"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false remote "$FILE_ITEM_ORIG")")"
check "restore from the damaged copy is refused" "$(echo "$RS" | jq -c .status)" '"failed"'
check "restore says nothing was restored" "$(echo "$RS" | jq -r .message)" 'nothing was restored'
eq "folder untouched by the refused restore" "$(tree_sig "$APPS/shop" "${SKIP[@]}")" "$SIG_BEFORE"
eq "good copy uploaded again" "$(s3put "${PREFIX}nightly/$ART1" "$WORK/from-bucket.tar")" '200'
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "remote", artifact: $a, deep: true}')")"
check "Full check passes again" "$(echo "$V" | jq -c .status)" '"succeeded"'
echo 'console.log("v1")' | root tee "$APPS/shop/index.js" >/dev/null

echo "== 11. change the data, then restore it"
root rm -f "$APPS/shop/data/uploads/a.txt" "$APPS/shop/latest.js"
echo 'console.log("v2")' | root tee "$APPS/shop/index.js" >/dev/null
root chmod 0600 "$APPS/shop/bin/run.sh"
echo 'made after the backup' | root tee "$APPS/shop/new-after-backup.txt" >/dev/null
chown_apps "$APPS/shop"
mq 'const a = db.getSiblingDB("appdb");
    a.users.deleteMany({_id: {$gte: 50}}); a.users.updateMany({_id: {$lt: 50}}, {$set: {name: "changed"}}); a.users.insertOne({_id: 9999, name: "ghost"});
    a.orders.drop(); db.getSiblingDB("logsdb").events.insertOne({_id: 99, msg: "after backup"});
    db.getSiblingDB("otherdb").secret.updateOne({_id: 1}, {$set: {v: "changed after backup"}})' >/dev/null
STATE_CHANGED="$(mongo_state)"
[[ "$STATE_CHANGED" != "$STATE0" ]] || { echo "the data did not change" >&2; exit 1; }
SIG_CHANGED="$(tree_sig "$APPS/shop" "${SKIP[@]}")"
[[ "$SIG_CHANGED" != "$SIG0" ]] || { echo "the folder did not change" >&2; exit 1; }

R="$(api "${H[@]}" -d "$(restore_body "$ART1" false local "$FILE_ITEM_ORIG" | jq -c 'del(.confirm)')" "$B/api/backups/plans/nightly/restore")"
check "restore needs the plan name typed" "$R" 'confirmation_required'
eq "nothing changed without confirmation" "$(tree_sig "$APPS/shop" "${SKIP[@]}")" "$SIG_CHANGED"

echo "-- 11a. folder into a separate directory leaves the live folder alone"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false local "$FILE_ITEM_ALT")")"
check "restore into a separate folder ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
ALT="$(echo "$RS" | jq -r '.result.restored[0].target')"
check "separate folder is under the restores directory" "$ALT" "$BKDIR/.restores/nightly-"
eq "separate folder equals the original" "$(tree_sig "$ALT" "${SKIP[@]}")" "$SIG0"
eq "live folder untouched" "$(tree_sig "$APPS/shop" "${SKIP[@]}")" "$SIG_CHANGED"

echo "-- 11b. MongoDB without drop only fills in what is missing"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false local "${MONGO_ITEMS[@]}")")"
echo "$RS" | jq -c '{status, message}'
check "restore without drop ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
eq "deleted users are back, the extra one stays" "$(mq 'print(db.getSiblingDB("appdb").users.countDocuments())')" '101'
eq "documents that exist are skipped (edits stay)" "$(mq 'print(db.getSiblingDB("appdb").users.findOne({_id: 0}).name)')" 'changed'
eq "dropped collection is back" "$(mq 'print(db.getSiblingDB("appdb").orders.countDocuments())')" '50'

echo "-- 11c. MongoDB with drop returns to the backed-up state"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" true local "${MONGO_ITEMS[@]}")")"
check "restore with drop ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
eq "databases match the backup exactly (documents and indexes)" "$(mongo_state)" "$STATE0"
eq "database outside the plan was not touched" "$(mq 'print(db.getSiblingDB("otherdb").secret.findOne({_id: 1}).v)')" 'changed after backup'

echo "-- 11d. folder over the current one (inside the agent's sandbox)"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false local "$FILE_ITEM_ORIG")")"
check "restore over the folder ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
eq "files, modes, owners and links are back" "$(tree_sig "$APPS/shop" "${SKIP[@]}")" "$SIG0"
check "files made later are kept" "$(cat "$APPS/shop/new-after-backup.txt" 2>/dev/null || root cat "$APPS/shop/new-after-backup.txt")" 'made after the backup'
check "excluded files are untouched" "$(root cat "$APPS/shop/node_modules/lib/skip.txt")" 'cached'

echo "-- 11e. folder deleted completely, restored from the bucket"
root rm -rf "$APPS/shop"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false remote "$FILE_ITEM_ORIG")")"
check "restore from the bucket ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
eq "folder recreated exactly (owner, modes, content)" "$(tree_sig "$APPS/shop" "${SKIP[@]}")" "$SIG0"
if [[ -z "$LOCAL" ]]; then
  eq "restored folder belongs to the apps user" "$(root stat -c '%U:%a' "$APPS/shop")" 'ovapps:755'
  eq "restored secret file keeps its owner and mode" "$(root stat -c '%U:%a' "$APPS/shop/.env")" 'ovapps:600'
fi

echo "-- 11f. a backup that claims another path cannot write outside the allowed folders"
root cp -p "$BKDIR/nightly/$ART1.json" "$WORK/sidecar.orig"
claim_path() { root cat "$WORK/sidecar.orig" | jq --arg p "$1" '(.members[] | select(.kind == "files") | .path) = $p' | root tee "$BKDIR/nightly/$ART1.json.new" >/dev/null && root mv "$BKDIR/nightly/$ART1.json.new" "$BKDIR/nightly/$ART1.json"; }
claim_path /etc/ovps-evil
R="$(api "$B/api/backups/plans/nightly/inspect?where=local&artifact=$ART1")"
eq "inspect marks the folder as not allowed" "$(echo "$R" | jq -c '.members[] | select(.kind == "files") | .current.allowed')" 'false'
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false local "$FILE_ITEM_ORIG")")"
check "restore to /etc is refused" "$(echo "$RS" | jq -r .message)" 'outside the folders'
[[ ! -e /etc/ovps-evil ]] || { echo "/etc/ovps-evil was created" >&2; exit 1; }
root ln -sfn /etc "$APPS/escape"
claim_path "$APPS/escape/ovps-evil2"
RS="$(do_task "/api/backups/plans/nightly/restore" "$(restore_body "$ART1" false local "$FILE_ITEM_ORIG")")"
check "restore through a symlink out of the folders is refused" "$(echo "$RS" | jq -r .message)" 'outside the folders'
[[ ! -e /etc/ovps-evil2 ]] || { echo "/etc/ovps-evil2 was created" >&2; exit 1; }
root rm -f "$APPS/escape"
root cp -p "$WORK/sidecar.orig" "$BKDIR/nightly/$ART1.json"
V="$(do_task /api/backups/plans/nightly/verify "$(jq -nc --arg a "$ART1" '{where: "local", artifact: $a, deep: true}')")"
check "original description put back, backup still good" "$(echo "$V" | jq -c .status)" '"succeeded"'

echo "== 12. a large backup straight to the bucket (multipart upload) and a second task being refused"
root rm -rf "$APPS/media"
root install -d -m 0755 "$APPS/media"
head -c 73400320 /dev/urandom | root tee "$APPS/media/video.bin" >/dev/null
echo 'readme' | root tee "$APPS/media/readme.txt" >/dev/null
chown_apps "$APPS/media"
SIGM="$(tree_sig "$APPS/media")"
MSRC="$(jq -nc --arg p "$APPS/media" '[{type: "files", name: "media", path: $p, exclude: []}]')"
R="$(api "${H[@]}" -d "$(plan_body media "$MSRC" false ci-bucket '{"keepLast":2,"maxAgeDays":null}')" "$B/api/backups/plans")"
check "bucket-only plan created" "$R" '"name":"media"'
MID="$(api "${H[@]}" -X POST "$B/api/backups/plans/media/run" | jq -er '.run.id')"
R="$(api "${H[@]}" -X POST "$B/api/backups/plans/nightly/run")"
check "second task refused while one runs" "$R" 'already running'
RUN="$(run_wait "$MID")"
check "large backup succeeded" "$(echo "$RUN" | jq -c .status)" '"succeeded"'
MART="$(echo "$RUN" | jq -r .artifact)"
MSIZE="$(echo "$RUN" | jq -r .sizeBytes)"
[[ "$MSIZE" -gt 67108864 ]] || { echo "backup is only $MSIZE bytes: multipart upload not exercised" >&2; exit 1; }
echo "ok - $MSIZE bytes, larger than one 64 MiB part"
eq "only the bucket was used" "$(echo "$RUN" | jq -c '.result.destinations | keys')" '["s3"]'
eq "nothing kept on this server" "$(root ls -A "$BKDIR" | grep -c '^media$' || true)" '0'
eq "object size in the bucket matches" "$(s3size "${PREFIX}media/$MART")" "$MSIZE"
V="$(do_task /api/backups/plans/media/verify "$(jq -nc --arg a "$MART" '{where: "remote", artifact: $a, deep: true}')")"
check "Full check of the large backup passes" "$(echo "$V" | jq -c .status)" '"succeeded"'
root rm -rf "$APPS/media"
MITEM='{"file":"files-media.tar.gz","target":"original"}'
RS="$(do_task "/api/backups/plans/media/restore" "$(restore_body "$MART" false remote "$MITEM" | jq -c '.confirm = "media"')")"
check "large restore from the bucket ran" "$(echo "$RS" | jq -c .status)" '"succeeded"'
eq "large folder restored byte for byte" "$(tree_sig "$APPS/media")" "$SIGM"
root rm -rf "$APPS/media"

echo "== 13. failures are reported without leaking secrets"
PSRC="$(jq -nc --arg p "$APPS/shop" '[{type: "files", name: "shop", path: $p, exclude: []}]')"
check "plan with a broken destination created" "$(api "${H[@]}" -d "$(plan_body partial "$PSRC" true ci-bad '{"keepLast":3,"maxAgeDays":null}')" "$B/api/backups/plans")" '"name":"partial"'
RUN="$(do_task /api/backups/plans/partial/run)"
check "unreachable destination makes the run partial" "$(echo "$RUN" | jq -c .status)" '"partial"'
check "the reason is shown" "$(echo "$RUN" | jq -r .message)" 'Upload failed'
refute "the storage secret is not shown" "$RUN" 'wrong-secret-value'
eq "the local copy still worked" "$(echo "$RUN" | jq -c '.result.destinations.local.ok')" 'true'
BADURI="mongodb://$MONGO_USER:wrong-Pa55@127.0.0.1:$MONGO_PORT/?authSource=admin"
BSRC='[{"type":"mongodb","name":"main","databases":["appdb"]}]'
check "plan with a wrong database password created" "$(api "${H[@]}" -d "$(plan_body badmongo "$BSRC" true '' '{"keepLast":3,"maxAgeDays":null}' "$BADURI")" "$B/api/backups/plans")" '"name":"badmongo"'
RUN="$(do_task /api/backups/plans/badmongo/run)"
check "wrong database password fails the run" "$(echo "$RUN" | jq -c .status)" '"failed"'
check "the failure is explained" "$(echo "$RUN" | jq -r .message)" 'MongoDB dump of "main" failed'
refute "wrong password is not shown" "$RUN" 'wrong-Pa55'
refute "real password is not shown" "$RUN" 'w0rd'
eq "a failed backup leaves nothing behind" "$({ root ls -A "$BKDIR/badmongo" 2>/dev/null || true; } | wc -l | tr -d ' ')" '0'

echo "== 14. retention (age, then count) only touches this plan's own backups"
OLD_A="nightly-20200101-000000.ovbk.tar"
OLD_B="nightly-20200202-000000.ovbk.tar"
DECOY="other-20200101-000000.ovbk.tar"
echo 'x' >"$WORK/small"
for k in "$OLD_A" "$OLD_A.json" "$OLD_B" "$DECOY" notes.txt; do eq "planted $k in the bucket" "$(s3put "${PREFIX}nightly/$k" "$WORK/small")" '200'; done
for k in "$OLD_A" "$OLD_A.json" "$OLD_B" "$DECOY" notes.txt; do root tee "$BKDIR/nightly/$k" <"$WORK/small" >/dev/null; done
R="$(api "$B/api/backups/plans/nightly/artifacts")"
eq "a backup without its description is shown as incomplete" "$(echo "$R" | jq -c "[.remote[] | select(.name == \"$OLD_B\") | .complete][0]")" 'false'
sleep 1
RUN="$(do_task /api/backups/plans/nightly/run)"
ART2="$(echo "$RUN" | jq -r .artifact)"
check "backup with the age rule succeeded" "$(echo "$RUN" | jq -c .status)" '"succeeded"'
eq "old backups deleted here and in the bucket" "$(echo "$RUN" | jq -c '.result.pruned')" '{"local":2,"s3":2}'
eq "bucket now holds two backups and the foreign files" "$(s3keys "${PREFIX}nightly/" | grep -v "$DECOY\|notes.txt" | tr '\n' ' ')" "${PREFIX}nightly/$ART1 ${PREFIX}nightly/$ART1.json ${PREFIX}nightly/$ART2 ${PREFIX}nightly/$ART2.json "
check "foreign files in the bucket untouched" "$(s3keys "${PREFIX}nightly/")" "${PREFIX}nightly/$DECOY"
check "notes in the bucket untouched" "$(s3keys "${PREFIX}nightly/")" "${PREFIX}nightly/notes.txt"
check "foreign files here untouched" "$(root ls -A "$BKDIR/nightly")" "$DECOY"
check "notes here untouched" "$(root ls -A "$BKDIR/nightly")" 'notes.txt'
refute "old backup gone here" "$(root ls -A "$BKDIR/nightly")" "$OLD_A"

R="$(api "${H[@]}" -X PUT -d "$(plan_body nightly "$SOURCES" true ci-bucket '{"keepLast":3,"maxAgeDays":null}')" "$B/api/backups/plans/nightly")"
check "retention changed to keep 3" "$R" '"keepLast":3'
NAMES=("$ART2")
for n in 3 4 5; do
  sleep 1
  RUN="$(do_task /api/backups/plans/nightly/run)"
  check "backup $n succeeded" "$(echo "$RUN" | jq -c .status)" '"succeeded"'
  NAMES+=("$(echo "$RUN" | jq -r .artifact)")
done
KEEP=("${NAMES[@]:1}")
echo "$RUN" | jq -c '.result.pruned'
EXPECT_REMOTE="$(for n in "${KEEP[@]}"; do printf '%s\n%s\n' "${PREFIX}nightly/$n" "${PREFIX}nightly/$n.json"; done; printf '%s\n%s\n' "${PREFIX}nightly/$DECOY" "${PREFIX}nightly/notes.txt")"
eq "bucket keeps the newest three (and the foreign files)" "$(s3keys "${PREFIX}nightly/")" "$(echo "$EXPECT_REMOTE" | sort)"
EXPECT_LOCAL="$(for n in "${KEEP[@]}"; do printf '%s\n%s\n' "$n" "$n.json"; done; printf '%s\n%s\n' "$DECOY" notes.txt)"
eq "this server keeps the newest three (and the foreign files)" "$(root ls -A "$BKDIR/nightly" | sort)" "$(echo "$EXPECT_LOCAL" | sort)"
eq "the very first backup was pruned" "$(root ls -A "$BKDIR/nightly" | grep -c "$ART1" || true)" '0'

echo "== 15. delete one backup from the list"
DEL="${KEEP[0]}"
R="$(api "${H[@]}" -X DELETE "$B/api/backups/plans/nightly/artifacts?where=remote&artifact=$DEL")"
check "deleted from the bucket" "$R" '"ok":true'
refute "gone from the bucket (with its description)" "$(s3keys "${PREFIX}nightly/")" "$DEL"
R="$(api "${H[@]}" -X DELETE "$B/api/backups/plans/nightly/artifacts?where=local&artifact=$DEL")"
check "deleted from this server" "$R" '"ok":true'
refute "gone from this server" "$(root ls -A "$BKDIR/nightly")" "$DEL"
R="$(api "${H[@]}" -X DELETE "$B/api/backups/plans/nightly/artifacts?where=local&artifact=$DEL")"
check "deleting twice is a clear error" "$R" 'not_found'

echo "== 16. the panel's scheduler starts a plan by itself"
MIN=$(( (10#$(date +%M) + 1 + (10#$(date +%S) > 50 ? 1 : 0)) % 60 ))
SCHED="$(jq -nc --arg p "$APPS/shop" --argjson m "$MIN" '{name: "sched", sources: [{type: "files", name: "shop", path: $p, exclude: []}], schedule: {kind: "hourly", minute: $m}, retention: {keepLast: 2, maxAgeDays: null}, keepLocal: true, destination: null, enabled: true}')"
R="$(api "${H[@]}" -d "$SCHED" "$B/api/backups/plans")"
check "scheduled plan created with a next run" "$R" '"nextRunAt":'
SRUN=""
for _ in $(seq 1 200); do
  SRUN="$(api "$B/api/backups" | jq -c '[.runs[] | select(.plan == "sched" and .trigger == "schedule" and .status != "running")][0] // empty')"
  [[ -n "$SRUN" ]] && break
  sleep 1
done
[[ -n "$SRUN" ]] || { echo "the scheduled backup never ran" >&2; exit 1; }
check "scheduled backup succeeded" "$(echo "$SRUN" | jq -c .status)" '"succeeded"'
check "started by the scheduler" "$(echo "$SRUN" | jq -c .actor)" '"scheduler"'
NEXT="$(api "$B/api/backups" | jq -r '.plans[] | select(.name == "sched") | .nextRunAt')"
[[ "$NEXT" -gt "$(( $(date +%s) * 1000 ))" ]] || { echo "next run not moved forward: $NEXT" >&2; exit 1; }
echo "ok - next run moved into the future"

echo "== 17. nothing leaked, nothing left over"
eq "no staging leftovers" "$(root ls -A "$BKDIR/.staging" | wc -l | tr -d ' ')" '0'
AUDIT="$(api "$B/api/audit?action=backup.&limit=200")"
for a in backup.destination_create backup.plan_create backup.run backup.verify backup.restore backup.delete backup.finished; do check "audit has $a" "$AUDIT" "$a"; done
for s in "$S3_SECRET" 'w0rd' 'wrong-Pa55' 'wrong-secret-value' 'hunter2'; do refute "audit does not contain '$s'" "$AUDIT" "$s"; done
if [[ -z "$LOCAL" ]]; then
  LOGS="$(sudo journalctl -u openvps -u openvps-agent --no-pager 2>&1)"
  for s in "$S3_SECRET" 'w0rd' 'wrong-Pa55' 'wrong-secret-value'; do refute "service logs do not contain '$s'" "$LOGS" "$s"; done
  check "agent logged the backup work" "$LOGS" 'backup job finished'
fi

echo "== 18. the MongoDB browser against the real, authenticated MongoDB (SCRAM, types, paging)"
mq 'const b = db.getSiblingDB("browsedb");
    b.dropDatabase();
    b.items.insertMany(Array.from({length: 25}, (_, i) => ({
      _id: i, name: "item-" + i, qty: NumberInt(i), big: NumberLong("9007199254740993"), price: i * 1.5, cost: NumberDecimal("1.10"),
      at: ISODate("2024-01-01T00:00:00Z"), ref: ObjectId("507f1f77bcf86cd799439011"), uid: UUID("01234567-89ab-cdef-0123-456789abcdef"),
      bin: BinData(0, "aGVsbG8="), tags: ["a", "b"], nested: {x: {y: 1}}, big_text: "z".repeat(100000) })));
    b.items.createIndex({name: 1}, {unique: true});
    b.createView("item_names", "items", [{$project: {name: 1}}]);
    db.getSiblingDB("admin").createUser({user: "legacy", pwd: "Pa55-legacy", roles: [{role: "read", db: "browsedb"}], mechanisms: ["SCRAM-SHA-1"]})' >/dev/null
R="$(api "${H[@]}" -d "{\"uri\":\"$MONGO_URI\"}" "$B/api/mongo/test")"
check "test connection works over SCRAM" "$R" '"authenticated":true'
check "test reports the server version" "$R" '"version":"'
check "test reports it can list databases" "$R" '"canListDatabases":true'
R="$(api "${H[@]}" -d "{\"uri\":\"${MONGO_URI/$MONGO_PASS_ENC/wrong-Pa55}\"}" "$B/api/mongo/test")"
check "wrong password is an auth error" "$R" 'mongo_auth'
refute "wrong password is not echoed" "$R" 'wrong-Pa55'
R="$(api "${H[@]}" -d '{"uri":"mongodb://127.0.0.1:1/?connectTimeoutMS=1000"}' "$B/api/mongo/test")"
check "unreachable server is reported" "$R" 'mongo_unreachable'
R="$(api "${H[@]}" -d "{\"name\":\"ci mongo\",\"uri\":\"$MONGO_URI\"}" "$B/api/mongo/connections")"
MID="$(echo "$R" | jq -r .connection.id)"
refute "saved connection does not return the password" "$R" 'w0rd'
R="$(api "$B/api/mongo/connections/$MID/databases")"
check "databases include browsedb" "$R" '"browsedb"'
check "databases include appdb" "$R" '"appdb"'
R="$(api "$B/api/mongo/connections/$MID/databases/browsedb/collections")"
check "collections: items" "$R" '"name":"items"'
check "collections: the view" "$R" '"type":"view"'
R="$(api "$B/api/mongo/connections/$MID/databases/browsedb/collections/items/stats")"
eq "stats count" "$(echo "$R" | jq -r .stats.count)" 25
eq "two indexes" "$(echo "$R" | jq -r '.indexes | length')" 2
eq "unique index flagged" "$(echo "$R" | jq -r '.indexes[] | select(.name=="name_1") | .unique')" true
R="$(api "$B/api/mongo/connections/$MID/databases/browsedb/collections/item_names/stats")"
check "a view has no storage statistics but does not fail" "$R" '"indexes"'
Q() { api "${H[@]}" -d "$1" "$B/api/mongo/connections/$MID/query"; }
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ qty: { $gte: 20 } }","sort":"{ _id: -1 }","limit":3,"skip":1}')"
eq "filter total" "$(echo "$R" | jq -r .total)" 5
eq "sorted, skipped, limited" "$(echo "$R" | jq -rc '[.documents[]._id."$numberInt"]')" '["23","22","21"]'
D="$(Q '{"db":"browsedb","collection":"items","filter":"{ _id: 1 }","limit":1}' | jq -c '.documents[0]')"
eq "Int32 type kept" "$(echo "$D" | jq -r '.qty."$numberInt"')" 1
eq "Int64 keeps full precision" "$(echo "$D" | jq -r '.big."$numberLong"')" 9007199254740993
eq "Double type kept" "$(echo "$D" | jq -r '.price."$numberDouble"')" 1.5
eq "Decimal128 type kept" "$(echo "$D" | jq -r '.cost."$numberDecimal"')" 1.10
eq "Date type kept" "$(echo "$D" | jq -r '.at."$date"')" 2024-01-01T00:00:00.000Z
eq "ObjectId type kept" "$(echo "$D" | jq -r '.ref."$oid"')" 507f1f77bcf86cd799439011
eq "UUID shown as UUID" "$(echo "$D" | jq -r '.uid."$uuid"')" 01234567-89ab-cdef-0123-456789abcdef
eq "Binary base64" "$(echo "$D" | jq -r '.bin."$binary".base64')" aGVsbG8=
eq "huge strings are cut" "$(echo "$D" | jq -r '.big_text."$truncated".length')" 100000
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ ref: ObjectId(\"507f1f77bcf86cd799439011\"), at: { $gte: ISODate(\"2024-01-01\") }, name: /^item-1/ }","limit":100}')"
eq "ObjectId + ISODate + regex filter" "$(echo "$R" | jq -r .total)" 11
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ uid: UUID(\"01234567-89ab-cdef-0123-456789abcdef\") }","limit":1}')"
eq "UUID filter" "$(echo "$R" | jq -r .total)" 25
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ _id: 3 }","projection":"{ name: 1 }"}')"
eq "projection" "$(echo "$R" | jq -rc '.documents[0] | keys')" '["_id","name"]'
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ $where: \"sleep(100)\" }"}')"
check "server-side JavaScript is refused" "$R" 'JavaScript'
R="$(Q '{"db":"browsedb","collection":"items","filter":"{ qty: "}')"
check "a bad filter is a field error" "$R" '"field":"filter"'
R="$(Q '{"db":"browsedb","collection":"item_names","limit":2}')"
check "a view can be browsed" "$R" '"name":"item-0"'
R="$(api "${H[@]}" -d "{\"uri\":\"mongodb://legacy:Pa55-legacy@127.0.0.1:$MONGO_PORT/browsedb?authSource=admin\"}" "$B/api/mongo/test")"
check "SCRAM-SHA-1 only user can sign in" "$R" '"authenticated":true'
R="$(api "${H[@]}" -d "{\"name\":\"ci legacy\",\"uri\":\"mongodb://legacy:Pa55-legacy@127.0.0.1:$MONGO_PORT/browsedb?authSource=admin\"}" "$B/api/mongo/connections")"
LID="$(echo "$R" | jq -r .connection.id)"
R="$(api "$B/api/mongo/connections/$LID/databases")"
check "a read-only user sees the permitted database" "$R" '"browsedb"'
R="$(api "${H[@]}" -d '{"db":"appdb","collection":"users","limit":1}' "$B/api/mongo/connections/$LID/query")"
check "and is refused elsewhere" "$R" 'not allowed'
AUDIT="$(api "$B/api/audit?action=mongo.&limit=50")"
check "audit has mongo.connection_create" "$AUDIT" 'mongo.connection_create'
refute "audit does not contain the password" "$AUDIT" 'w0rd'
for i in "$MID" "$LID"; do check "connection $i deleted" "$(api "${H[@]}" -X DELETE "$B/api/mongo/connections/$i")" '"ok":true'; done
mq 'db.getSiblingDB("browsedb").dropDatabase(); db.getSiblingDB("admin").dropUser("legacy")' >/dev/null

echo "== 19. delete plans and storage"
R="$(api "${H[@]}" -X DELETE "$B/api/backups/destinations/ci-bucket")"
check "storage in use cannot be deleted" "$R" 'Still used by'
for p in nightly media partial badmongo sched; do check "plan $p deleted" "$(api "${H[@]}" -X DELETE "$B/api/backups/plans/$p")" '"ok":true'; done
check "storage deleted" "$(api "${H[@]}" -X DELETE "$B/api/backups/destinations/ci-bucket")" '"ok":true'
check "second storage deleted" "$(api "${H[@]}" -X DELETE "$B/api/backups/destinations/ci-bad")" '"ok":true'
root rm -rf "$APPS/shop" "$APPS/media" "$BKDIR/nightly" "$BKDIR/media" "$BKDIR/partial" "$BKDIR/badmongo" "$BKDIR/sched" "$BKDIR/.restores"
if [[ -z "$LOCAL" ]]; then
  sudo systemctl stop ovps-ci-s3 || true
fi
echo "ALL BACKUP CHECKS PASSED"
