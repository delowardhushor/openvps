# Configuration

OpenVPS reads `/etc/openvps/config.json` (owned by `root:openvps`, mode `0640`). Any key you
leave out uses its default. Unknown keys and invalid values are **rejected at startup** with
a clear message; the service will not start with a broken config.

After editing:

```bash
sudo openvps check-config && sudo systemctl restart openvps
```

A complete example is in `/opt/openvps/current/packaging/config.example.json`.

## Reference

| Key | Default | Description |
|---|---|---|
| `listen.host` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` for SSH-tunnel-only or reverse-proxy setups. |
| `listen.port` | `7443` | Panel port. |
| `tls.enabled` | `true` | Serve HTTPS directly. Disable only behind a TLS-terminating proxy on localhost. |
| `tls.certFile` | `/etc/openvps/tls/cert.pem` | PEM certificate (chain). |
| `tls.keyFile` | `/etc/openvps/tls/key.pem` | PEM private key, readable by group `openvps`. |
| `trustProxy` | `false` | Trust `X-Forwarded-For`/`-Proto`/`-Host`. Enable **only** when every request comes through your proxy. |
| `dataDir` | `/var/lib/openvps` | Database and runtime files. If you change it, update `ReadWritePaths` in the systemd unit. |
| `logLevel` | `info` | `debug`, `info`, `warn` or `error`. Logs go to the journal (`journalctl -u openvps`). |
| `session.idleMinutes` | `120` | Sign out after this much inactivity. |
| `session.absoluteHours` | `12` | Maximum session lifetime regardless of activity. |
| `auth.minPasswordLength` | `12` | Minimum password length. |
| `auth.maxFailedAttempts` | `5` | Failed sign-ins on one account before a temporary lockout. |
| `auth.lockoutMinutes` | `15` | Lockout duration. Clear it early with `sudo openvps unlock <user>`. |
| `auth.ipAttemptsPerWindow` | `20` | Sign-in requests allowed per client IP per window. |
| `auth.ipWindowMinutes` | `15` | Rate-limit window. |
| `metrics.intervalSeconds` | `5` | How often metrics are sampled. |
| `metrics.historyMinutes` | `60` | Length of the in-memory history used for charts. |
| `services` | `["nginx","ssh","cron","ufw"]` | systemd units shown on the dashboard (read-only status). |
| `audit.retentionDays` | `180` | Activity log entries older than this are deleted. |
| `agent.manageRootPm2` | `true` | Allow start/stop/restart/reload of root's existing PM2 apps. `false` = read-only. |
| `agent.rootPm2Bin` | `null` | Path to root's `pm2`. `null` = use what `openvps provision` detected (`/etc/openvps/agent.json`). |
| `agent.rootPm2Home` | `/root/.pm2` | Root's `PM2_HOME`. |
| `agent.socket` | `/run/openvps-agent/agent.sock` | Socket between panel and agent. |
| `apps.allowedRoots` | `["/srv/apps"]` | Directories application code may live in (system directories are refused). |
| `apps.runtimeCandidates` | `/usr/bin/node`, `/usr/local/bin/node`, `/opt/openvps/node/bin/node` | Node.js binaries offered as app runtimes (if runnable by `ovapps`). |
| `apps.user`, `apps.home`, `apps.pm2Bin`, `apps.pm2Node`, `apps.service`, `apps.specDir` | see example | Set by the installer; change only if you know why. |
| `sites.staticRoots` | `["/srv/apps","/var/www"]` | Folders static sites and SPAs may be served from (system directories are refused). |
| `sites.nginxBin`, `sites.nginxConf` | `/usr/sbin/nginx`, `/etc/nginx/nginx.conf` | Nginx binary and main config (used for `nginx -t`). |
| `sites.sitesAvailable`, `sites.sitesEnabled`, `sites.confD` | Ubuntu layout | Where site files are written (`conf.d` when `sites-enabled` isn't included). |
| `sites.certbotBin` | `null` | Path to `certbot`. `null` = first of `/usr/bin`, `/snap/bin`, `/usr/local/bin`. |
| `sites.letsencryptDir` | `/etc/letsencrypt` | Certbot's directory, read for the certificate list. |
| `sites.acmeRoot` | `/var/lib/openvps-agent/acme` | Folder served at `/.well-known/acme-challenge/`. |
| `sites.acmeServer`, `sites.acmeCaBundle` | `null` | A different ACME directory URL and CA bundle, e.g. Let's Encrypt staging or a test CA. |
| `sites.dnsServers` | `null` | DNS servers for the pre-flight check (`null` = the system resolver). |
| `backups.dir` | `/var/backups/openvps` | Where local backups are kept (root only). Put it on another disk if you can. |
| `backups.fileRoots` | `["/srv/apps","/var/www"]` | Folders that may be backed up and restored into (system and OpenVPS data directories are refused). |
| `backups.scheduler` | `true` | Start scheduled backups from the panel. `false` = plans only run when you click. |
| `backups.tarBin`, `backups.mongodumpBin`, `backups.mongorestoreBin` | `null` | Tool paths; `null` = look in `/usr/bin`, `/usr/local/bin` (and `/snap/bin`). |

The agent reads the same file. After changing `agent.*`, `apps.*`, `sites.*` or `backups.*`, run
`sudo systemctl restart openvps-agent openvps`.

## Environment variables

These override the file and are mostly for development and containers:

| Variable | Effect |
|---|---|
| `OPENVPS_CONFIG` | Path of the config file |
| `OPENVPS_DEV=1` | Development defaults: HTTP on `127.0.0.1:7800`, data in `./.data`, debug logs |
| `OPENVPS_HOST`, `OPENVPS_PORT` | Listen address |
| `OPENVPS_TLS` | `1`/`0` to force TLS on or off |
| `OPENVPS_DATA_DIR`, `OPENVPS_WEB_ROOT` | Paths |
| `OPENVPS_LOG_LEVEL` | Log level |

## Files

| Path | Owner / mode | Contents |
|---|---|---|
| `/etc/openvps/config.json` | `root:openvps 0640` | Configuration |
| `/etc/openvps/tls/key.pem` | `root:openvps 0640` | TLS private key |
| `/var/lib/openvps/openvps.db` | `openvps 0600` | SQLite database (accounts, sessions, settings, activity) |
| `/var/lib/openvps/backups/` | `openvps 0750` | Pre-upgrade database snapshots |
| `/var/lib/openvps/setup-token` | `openvps 0600` | Exists only until setup is completed |
| `/var/lib/openvps/secret.key` | `openvps 0600` | Key that encrypts app environment variables, storage keys and MongoDB connection strings. **Back it up with the database.** |
| `/var/backups/openvps/` | `root 0700` | Local backups made by the Backups page (see [backups](backups.md)) |
| `/etc/openvps/agent.json` | `root:openvps 0640` | Written by `openvps provision` (detected root PM2) |
| `/run/openvps-agent/agent.sock` | `root:openvps 0660` | Agent socket (directory `0750`) |
| `/var/lib/openvps-agent/apps/` | `root:ovapps 0750` | Generated PM2 definitions of your apps (contain env values) |
| `/var/lib/ovapps/.pm2/` | `ovapps` | PM2 home of the apps user: logs, process list |
| `/srv/apps/` | `ovapps` | Your application code |
