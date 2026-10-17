# Uninstalling

```bash
sudo openvps uninstall            # remove the program, keep config and data
sudo openvps uninstall --purge    # remove everything
```

| | `uninstall` | `uninstall --purge` |
|---|---|---|
| Service, `/usr/local/bin/openvps`, `/opt/openvps` (incl. private Node.js) | removed | removed |
| `/etc/openvps` (config, TLS) | **kept** | removed |
| `/var/lib/openvps` (database, snapshots) | **kept** | removed |
| `openvps` system user | kept | removed |
| Final archive of config and data in `/root/openvps-final-<timestamp>.tar.gz` | — | created (skip with `--no-backup`) |

Never touched: your applications, Nginx, PM2, system Node.js, firewall rules.
If you allowed the panel port in ufw, the script reminds you to remove that rule.

Reinstalling after a plain `uninstall` reuses the kept configuration and accounts.

If the `openvps` command is already gone, run the script from a release package:
`sudo bash scripts/uninstall.sh [--purge]`.
