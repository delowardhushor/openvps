# Uninstalling

```bash
sudo openvps uninstall            # remove the program, keep config and data
sudo openvps uninstall --purge    # remove everything
```

| | `uninstall` | `uninstall --purge` |
|---|---|---|
| Services (`openvps`, `openvps-agent`, `openvps-apps`), `/usr/local/bin/openvps`, `/opt/openvps` (incl. private Node.js and PM2) | removed | removed |
| Apps you added in OpenVPS | **stopped** (code in `/srv/apps` kept) | stopped (code kept) |
| `/etc/openvps` (config, TLS) | **kept** | removed |
| `/var/lib/openvps` (database, snapshots) | **kept** | removed |
| `openvps` and `ovapps` users, `/var/lib/ovapps`, `/var/lib/openvps-agent` | kept | removed |
| `/srv/apps` (your code) | kept | **kept** |
| `/var/backups/openvps` (local backups) | kept | **kept** |
| Final archive of config and data in `/root/openvps-final-<timestamp>.tar.gz` | — | created (skip with `--no-backup`) |

Never touched: root's PM2 and its apps, your code in `/srv/apps`, system Node.js, firewall rules.

**Sites keep working.** Nginx sites created in OpenVPS (`/etc/nginx/sites-*/openvps-*.conf`) and
their certificates stay, and Certbot keeps renewing them (the challenge folder
`/var/lib/openvps-agent/acme` is kept for that, even with `--purge`). Only the panel's own domain
site is removed, since it would point at nothing. To remove the rest by hand:
`sudo rm /etc/nginx/sites-enabled/openvps-* /etc/nginx/sites-available/openvps-* && sudo systemctl reload nginx`.
If you allowed the panel port in ufw, the script reminds you to remove that rule.

Reinstalling after a plain `uninstall` reuses the kept configuration and accounts.

If the `openvps` command is already gone, run the script from a release package:
`sudo bash scripts/uninstall.sh [--purge]`.
