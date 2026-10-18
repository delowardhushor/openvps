# Upgrading

```bash
sudo openvps version          # current version
sudo openvps upgrade          # latest release
sudo openvps upgrade --version 0.2.0
sudo openvps upgrade --package ./openvps-0.2.0.tar.gz   # offline
```

Read the [changelog](../CHANGELOG.md) before upgrading across minor versions.

> **From 0.1.x to 0.2.x:** after `sudo openvps upgrade`, run `sudo openvps provision` once.
> It sets up the new application-management services. Later upgrades do this automatically.

## What happens

1. The new release is downloaded and its **SHA-256 checksum verified**.
2. It is unpacked next to the running release. Nothing changes yet.
3. A **database snapshot** is written to
   `/var/lib/openvps/backups/pre-upgrade-<from>-to-<to>-<timestamp>.db`.
4. The service stops (usually a few seconds of panel downtime; **your applications are
   not affected**), `/opt/openvps/current` is switched to the new release, and the
   systemd unit and CLI wrapper are refreshed.
5. The existing configuration is validated against the new version, then database migrations run.
6. The service starts and must report the **new version as healthy** within 30 seconds.
7. `openvps provision` from the new release updates the agent, the bundled PM2 and their services.
   If the bundled PM2 version changed, PM2 for `ovapps` restarts and resurrects your apps.
8. The three most recent releases are kept for rollback; older ones are deleted.

If step 5 or 6 fails, the script **automatically rolls back**: it re-activates the previous
release, restores the database snapshot, restarts and verifies the old version.

## Your data and configuration

- `/etc/openvps/config.json` and the TLS files are **never overwritten**. New options have
  defaults; see `packaging/config.example.json` in the new release.
- The database is migrated forward. Downgrading to a release older than the database schema
  is refused at startup. Restore the matching snapshot instead (see [recovery](recovery.md)).

## Manual rollback

```bash
ls /opt/openvps/releases/                  # available releases
ls /var/lib/openvps/backups/               # database snapshots
sudo systemctl stop openvps
sudo ln -sfn /opt/openvps/releases/<old-version> /opt/openvps/current
sudo install -m 600 -o openvps -g openvps /var/lib/openvps/backups/<snapshot>.db /var/lib/openvps/openvps.db
sudo rm -f /var/lib/openvps/openvps.db-wal /var/lib/openvps/openvps.db-shm
sudo systemctl start openvps
```
