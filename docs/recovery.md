# Recovery

All recovery runs over SSH on the server. Shell access is the trust boundary: anyone who can
run `sudo` on the server can recover the panel.

## I forgot my password

```bash
sudo openvps users                   # list accounts
sudo openvps reset-password admin    # prompts for a new password, signs out all sessions
```

For scripts: `printf '%s' "$NEW_PW" | sudo openvps reset-password admin --password-stdin`.

## My account is locked

After repeated failed sign-ins, an account is locked for `auth.lockoutMinutes` (default 15).
Wait, or:

```bash
sudo openvps unlock admin
```

Check `sudo openvps audit` for the source IPs of the failed attempts. Persistent failures from
unknown IPs mean you should restrict the panel port (see [installation](installation.md#restrict-who-can-reach-the-panel)).

## I think someone else is signed in

```bash
sudo openvps revoke-sessions         # signs out everyone
sudo openvps reset-password admin
sudo openvps audit --limit 100
```

## I lost the setup token

```bash
sudo openvps setup-token             # shows it, or creates one
sudo openvps setup-token --new       # invalidates the old one and issues a new one
```

## The panel does not start

```bash
sudo systemctl status openvps
journalctl -u openvps -n 100 --no-pager
sudo openvps check-config
```

Common causes:

| Symptom in the log | Fix |
|---|---|
| `Configuration error: ...` | Fix `/etc/openvps/config.json` as described; `check-config` must pass |
| `EADDRINUSE` | Another program uses the port; change `listen.port` |
| `ENOENT ... cert.pem` | Restore the certificate or set `tls.certFile`/`keyFile` |
| `Database schema version N is newer...` | You downgraded; restore a matching snapshot or upgrade again |

To regenerate the self-signed certificate:

```bash
sudo rm /etc/openvps/tls/cert.pem /etc/openvps/tls/key.pem
sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 825 \
  -subj "/CN=$(hostname)" -addext "subjectAltName=DNS:$(hostname),IP:127.0.0.1" \
  -keyout /etc/openvps/tls/key.pem -out /etc/openvps/tls/cert.pem
sudo chown root:openvps /etc/openvps/tls/*.pem && sudo chmod 640 /etc/openvps/tls/key.pem
sudo systemctl restart openvps
```

## An upgrade failed

`openvps upgrade` rolls back automatically. If the server was interrupted mid-upgrade
(power loss, for example), follow the manual rollback in [upgrading](upgrading.md#manual-rollback).

## Back up and restore the database

The database holds accounts, sessions, settings and the activity log.

```bash
# back up (safe while running)
sudo openvps backup-db /var/lib/openvps/backups/manual-$(date +%F).db

# restore
sudo systemctl stop openvps
sudo install -m 600 -o openvps -g openvps /path/to/backup.db /var/lib/openvps/openvps.db
sudo rm -f /var/lib/openvps/openvps.db-wal /var/lib/openvps/openvps.db-shm
sudo systemctl start openvps
```

Copy backups off the server too. Backups on the same disk do not survive a disk failure.

## Start completely fresh

```bash
sudo openvps uninstall --purge
sudo bash install.sh
```
