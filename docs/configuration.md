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
