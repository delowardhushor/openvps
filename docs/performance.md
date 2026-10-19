# Resource footprint

How much CPU, memory and disk OpenVPS uses on the server, and where the pressure comes from.
This matters most on small VPSes (512 MB to 2 GB RAM, 1 vCPU).

**How to read the numbers.** Each figure is marked:

- **Measured**: run on a development machine (macOS, Node 25, compiled `dist/` build, a fresh
  empty database) in October 2026, version 0.5.1. Linux numbers are usually 10-20 MB lower for
  the same Node process, so treat these as an upper bound for the panel and agent.
- **Estimated**: taken from the code and from typical behaviour of the tool involved. These have
  **not** been measured on a real Ubuntu host yet. Please replace them with real numbers (see
  [How to measure on your server](#how-to-measure-on-your-server)).

## Summary

| Component | Always running? | Memory (RSS) | CPU at idle | Source |
|---|---|---|---|---|
| Panel (`openvps.service`) | yes | **~63 MB** idle, ~75 MB after heavy use; capped at 200 MB soft / 400 MB hard | ~0.03% | measured |
| Agent (`openvps-agent.service`) | yes | **~60 MB** (about 1-2 MB less with the flags) | 0% (no timers) | measured |
| PM2 daemon for apps (`openvps-apps.service`) | yes | ~40-70 MB | low (PM2 samples each app about once a second) | estimated |
| Your apps | yes | whatever they use | whatever they use | not OpenVPS |
| Nginx, Certbot timer | not part of OpenVPS | Nginx ~5-15 MB | ~0 | estimated |
| MongoDB server (`mongod`) | **only if auto-installed** | **~150-300 MB, more under load** | low | estimated |

**Typical total for OpenVPS itself: about 120-130 MB** (panel + agent), or **about 165-195 MB** with
the PM2 daemon. That is the figure to plan around on a 1 GB server, before your own apps.

**The biggest single item is not OpenVPS code**: on servers with 2 GB of RAM or more, the
installer adds a MongoDB server (see
[MongoDB auto-install](#mongodb-auto-install-the-largest-cost)). Below that it only adds the
backup tools.

## Always-on processes

OpenVPS is three long-running Node.js processes. Each one carries the Node runtime baseline
(a bare `node` process measured 45 MB), so memory is dominated by the runtime, not by our code.

### Panel

- **Measured:** 64.6 MB RSS right after start, 65.2 MB after 40 s idle, 82.7 MB after 2,000
  HTTP requests (the rise is garbage the collector has not reclaimed yet; the service has
  `MemoryHigh=200M`, `MemoryMax=400M`, `TasksMax=64` as guard rails).
- **With the memory flags the units now use** (`--max-semi-space-size=1 --v8-pool-size=0
  --max-old-space-size=160`), measured the same way: 63.2 MB idle and 74.7 MB after 3,000
  requests (against 64.8 and 83.7 MB without them, three repeated runs), with the same CPU.
- **Measured CPU:** 0.01 s of CPU in 40 s idle (about 0.03%). Serving 2,000 requests cost about
  0.4 s of CPU in total, around **0.2 ms per request** (loopback, health endpoint). Real API calls
  that touch SQLite or the agent cost more, but stay in the low milliseconds.
- **Timers inside the panel** (all `unref`'d, no subprocesses):

  | Timer | Interval | Work |
  |---|---|---|
  | Metrics collector | 5 s (`metrics.intervalSeconds`, 1-300) | Reads 6 small `/proc` files, no subprocess |
  | Backup poll/scheduler | 2 s tick; schedule check every 30 s | Does a SQLite query for running jobs. Calls the agent only while a backup is running |
  | Maintenance | 1 h | Deletes expired sessions and audit rows older than `audit.retentionDays` (180) |
  | MongoDB connection pool | 60 s idle timeout per connection | Closes unused browser connections |

- **History buffer:** 60 minutes at 5 s = 720 points of 6 numbers, well under 1 MB.
  Lowering `metrics.historyMinutes` or raising `metrics.intervalSeconds` only saves a few KB and a
  few microseconds, so they are not useful tuning knobs for small servers.

### Agent

- **Measured:** 61.7 MB RSS, 0.00 s of CPU over 20 s idle. It has no polling loop; it only works
  when the panel sends a request on the Unix socket.
- Its cost appears when it does work: running `pm2`, `nginx -t`, `certbot`, `tar`,
  `mongodump` (see [Work done on demand](#work-done-on-demand)).

### PM2 daemon for apps

- **Estimated:** a PM2 daemon is a Node process of roughly 40-70 MB plus a small steady CPU cost,
  because it samples each managed process. It is started by `openvps-apps.service` and runs even
  with zero apps registered.
- If you already run PM2 as root, that daemon is a separate one and is only controlled, never
  replaced. Running both means two PM2 daemons.

## Work done on demand

These are the moments when the server actually feels OpenVPS.

### Listing applications spawns a Node process

`pm2 jlist` is run as a **new subprocess** (`server/src/agent/pm2.ts`, `rawList`) whenever the
agent needs the process list. Each run is a full Node + PM2 CLI start-up, and the root and apps
PM2 are separate runs.

- **Estimated cost per run (before the changes below):** 60-100 MB peak memory and 0.3-1.0 s of CPU
  on a 1 vCPU server. Not yet measured with PM2 itself.
- **What reduces it now (version after 0.5.1):**
  - The agent **caches a listing for 4 s**, makes concurrent callers **share one run**, and
    **drops the cache on every change** (start, stop, restart, reload, delete, save), so the result
    after an action is always fresh. Log viewing accepts a listing up to 30 s old, because log
    paths only change when a process restarts. Tests: `server/test/pm2-cache.test.ts`.
  - The panel asks for the root and apps lists **one after the other**, so two Node processes are
    never started at once (half the peak memory).
  - The PM2 CLI runs with `NODE_COMPILE_CACHE`, so repeated starts reuse compiled code. Measured
    on a stand-in (loading the 9 MB TypeScript module): 0.11 s CPU and 114 MB peak without the
    cache, 0.06 s and 101 MB with it. Real PM2 not measured; needs Node 22.1 or newer, older Nodes
    ignore it.
  - The web UI polls less (below). Browsers pause polling in hidden tabs.

  | Page | Poll interval now (before) |
  |---|---|
  | Applications list and app detail | every 10 s (5 s), only while the tab is visible |
  | Dashboard "processes" card | every 30 s (15 s), only while the tab is visible |
  | Dashboard overview | every 30 s |
  | Dashboard metrics | every `metrics.intervalSeconds` (5 s; no subprocess) |
  | Log viewer ("follow") | every 3 s; now mostly a file read, because log paths are cached |

  Net effect with the Applications page open: at most one PM2 CLI start per owner every 10 s
  (was every 5 s per owner, run in parallel), each using the compile cache. With nobody on the
  page, there is no cost.
- The panel's `GET /api/system/overview` also calls `systemctl show` for the service list, but
  the result is cached for 15 s, and `systemctl` is a very small process.
- Still open: reading process state without starting a Node process at all (for example by talking
  to the PM2 daemon directly) would remove the remaining cost.

### Nginx and Certbot

- Every site change runs `nginx -t` twice and a reload. This is short (tens of milliseconds to
  about a second) and rare. The agent waits about 400 ms after a reload.
- Certificate issuing runs `certbot` (a Python process, ~50-100 MB while it runs, estimated) for
  a few seconds. Renewal is done by Certbot's own timer, not by OpenVPS.

### Backups

- **One job at a time** in the agent; a second request gets `busy`, so peak use does not stack.
- CPU- and disk-heavy tools (`tar -czf` for folders, `mongodump --gzip`) run under `nice -n 10`
  and `ionice -c2 -n7` (best effort, lowest priority) when they exist, so apps win both CPU and
  disk contention. `ionice` is probed once and skipped where the kernel refuses it.
- Uploads to S3 **stream from the file**, in 64 MiB parts, and are not held in memory. Each part
  is read twice from disk (once to hash, once to send), so large uploads cost disk read and some
  CPU, but little memory.
- **Estimated:** `tar` + gzip of a folder uses little memory but keeps one core near 100% for the
  length of the job, and competes with your apps for disk. `mongodump --gzip` adds memory use on
  the MongoDB side, not in OpenVPS.
- Scheduled backups run when due. Schedule them for quiet hours on small servers.

### File manager

- Nothing runs while the Files page is closed. Each file operation starts one helper process (about
  45 MB, a few hundredths of a second of CPU, started with `--max-old-space-size=64`) that exits when
  done; at most three run at once, so peak extra memory is about 150 MB during a burst of uploads.
  Estimated, not yet measured on a real host.
- Uploads and downloads are streamed in chunks through the panel, the agent and the helper; no file
  is held in memory. Cost is mostly one extra copy per hop (CPU) and the disk write.
- The web UI uploads two files at a time.

### MongoDB browser

- Runs inside the panel and is read-only. Pages are limited to 100 documents, each string or
  binary value is cut at 64 KB, queries time out after 15 s (counts after 5 s), and a single
  wire message may be up to 64 MB. A page of large documents can briefly add tens of MB.
- Idle connections are closed after 60 s.

## MongoDB auto-install (the largest cost)

`scripts/provision.sh` (run by install and by every upgrade) can install `mongodb-org` from
repo.mongodb.org **and enable and start `mongod`**, so MongoDB backups work out of the box.

- **Now gated on RAM:** the server is installed only when the machine has about 2 GB of RAM or
  more (`MemTotal` of at least 1,800,000 kB). Below that, only `mongodb-database-tools` (about
  100 MB of disk, no running server) is installed; that is all backups need. Set
  `OPENVPS_MONGODB_SERVER=1` to install the server anyway. The tools-only path was already used
  when a server exists or the CPU has no AVX.
- **Estimated:** an idle `mongod` is roughly 150-300 MB RSS. Its WiredTiger cache defaults to the
  larger of 256 MB and half of (RAM minus 1 GB), and it grows as data is read. On a 1 GB VPS that
  would have been about double the rest of OpenVPS.
- **Existing servers are left alone.** If an earlier OpenVPS already installed `mongod` on a small
  machine, provision does not remove it; it prints a hint. If you do not need it:
  `sudo systemctl disable --now mongod`.
- Skip everything MongoDB-related with `OPENVPS_SKIP_MONGODB=1` in the environment of the
  installer or upgrader (`install.sh` and `upgrade.sh` call `provision.sh` without arguments; only
  `sudo openvps provision --no-mongodb` takes the flag). Or install the Database Tools yourself
  first (`apt install mongodb-database-tools`).

## Disk

| Item | Size | Source |
|---|---|---|
| OpenVPS release (`/opt/openvps/releases/<ver>`): server `dist` + web `dist` | about 1 MB | measured (`server/dist` 496 KB, `web/dist` 424 KB) |
| Bundled PM2 and its dependencies (`/opt/openvps/pm2`) | tens of MB | estimated |
| Private Node runtime (`/opt/openvps/node`) | about 100-200 MB unpacked | estimated |
| Panel database (`/var/lib/openvps`) | starts at tens of KB; grows with the activity log (180 days by default) | estimated; small |
| Database snapshot per upgrade | the size of the database | by design |
| Old releases | a few MB each | `upgrade.sh` keeps the newest 3 (`KEEP_RELEASES=3`) |
| PM2 app logs (`/var/lib/ovapps/.pm2/logs`) | **unbounded**: OpenVPS does not configure log rotation | from code; the main disk risk |
| Local backups (`/var/backups/openvps`) | whatever your plans produce | depends on your data and retention |
| MongoDB (if auto-installed) | ~500 MB of packages plus data | estimated |

Two growth risks are worth watching on small disks: **app logs** (no rotation configured; install
`pm2-logrotate` for the `ovapps` user or set up `logrotate`) and **local backups** (keep
`retention` low or use S3 and keep few local copies).

## Network

The panel itself makes no outbound requests at idle. Outbound traffic happens only for S3
uploads (backups), `certbot` (Let's Encrypt), the installer and upgrader, and any MongoDB
connection you save.

## Recommendations for small servers

| Server | What to do |
|---|---|
| **512 MB** | The installer now skips the MongoDB server by itself. Expect about 165-195 MB used by OpenVPS with its PM2 daemon, leaving little for apps. Add swap, keep the Applications page closed when not needed, and consider whether a panel is worth it at this size. |
| **1 GB** | Fine for the panel, agent and PM2 (about 165-195 MB); no MongoDB server is installed automatically. Set `maxMemoryMb` on each app so PM2 restarts a leaking app before the OOM killer picks something else. |
| **2 GB and up** | Comfortable, including a local MongoDB for small datasets. |
| **Any size** | Schedule backups for quiet hours; set up log rotation for app logs; do not leave the Applications page open in a background tab on a 1 vCPU box (the browser pauses polling while the tab is hidden, so this mainly applies to a visible tab). |

## Done and still open

Done (see the CHANGELOG): RAM-gated MongoDB server install, cached and shared `pm2 jlist` results
with change-based invalidation, sequential root/apps listing, compile cache for the PM2 CLI,
slower UI polling, Node memory flags and heap caps on the panel and agent, `ionice` for backups.

Still open, in order of expected effect:

1. **Read PM2 state without starting a Node process** (talk to the PM2 daemon directly). This
   would remove the last recurring spawn.
2. **Add log rotation** for the `ovapps` PM2 (a bundled `pm2-logrotate`, or a logrotate rule).
   This is disk, not CPU or RAM.
3. **Warn on the dashboard** when free memory is low or the server has little RAM.
4. **Measure on a real 1 vCPU / 1 GB Ubuntu host** and replace the estimated rows above.

## How to measure on your server

Run these on the VPS (as root) and send the output so the **estimated** rows can be replaced
with measured ones.

```bash
# Memory and CPU of each OpenVPS service (RSS in KB, cumulative CPU time)
systemctl status openvps openvps-agent openvps-apps --no-pager | grep -E "Memory|CPU|Active"
ps -o pid,rss,%cpu,etime,cmd -C node

# Overall memory, swap and OOM kills
free -m
journalctl -k --since "7 days ago" | grep -i "out of memory" | tail

# Cost of listing apps (what the Applications page triggers every 10 s)
sudo -u ovapps env PM2_HOME=/var/lib/ovapps/.pm2 /usr/bin/time -v \
  /opt/openvps/node/bin/node /opt/openvps/pm2/node_modules/pm2/bin/pm2 jlist >/dev/null

# Idle cost of a local MongoDB, if installed
systemctl status mongod --no-pager | grep -E "Memory|CPU"

# Disk used by OpenVPS data and app logs
du -sh /opt/openvps /var/lib/openvps /var/lib/openvps-agent /var/backups/openvps /var/lib/ovapps/.pm2/logs
```

To record the numbers, repeat the first command with the Applications page open for a minute and
compare `CPU` time and peak memory before and after.
