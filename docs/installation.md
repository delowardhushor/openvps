# Installation

## Requirements

| | Supported | Notes |
|---|---|---|
| OS | **Ubuntu 24.04 LTS** | Other versions are refused unless you pass `--force-unsupported` |
| CPU | **x86-64** | arm64 works with `--force-unsupported` but is not yet tested |
| Memory | 512 MB+ | The panel itself uses about 50–70 MB |
| Disk | 400 MB free in `/opt` | Program files plus a private Node.js runtime |
| Access | root (sudo) | Only for installing; the panel runs unprivileged |
| Network | Outbound HTTPS to github.com and nodejs.org | Only during install/upgrade |

Tools the installer needs (all present on standard Ubuntu): `curl tar xz sha256sum openssl ss runuser`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/delowardhushor/openvps/main/scripts/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The installer:

1. **Checks the server** (OS, architecture, systemd, tools, free port, disk, memory) and
   refuses to continue if something is wrong. Nothing is changed until all checks pass.
2. **Shows exactly what it will change** and asks for confirmation.
3. Downloads the release and **verifies its SHA-256 checksum**.
4. Creates the `openvps` system user and these directories:
   - `/opt/openvps`: releases (`releases/<version>`, `current` symlink) and a private
     Node.js runtime (`node`). Your system Node.js is not touched.
   - `/etc/openvps`: `config.json` and `tls/` (self-signed certificate).
   - `/var/lib/openvps`: the database and backups.
5. Installs `openvps.service` (systemd, hardened sandbox) and `/usr/local/bin/openvps`.
6. Starts the service and **waits until it reports healthy**.
7. Prints the URL, the setup token and the certificate fingerprint.

If any step fails, everything this run created is **removed automatically**.

### Options

| Option | Meaning |
|---|---|
| `--repo USER/NAME` | GitHub repository to download releases from (default: `delowardhushor/openvps`; use this for forks) |
| `--version X` | Install a specific release (default: latest) |
| `--package FILE` | Install from a local `openvps-X.tar.gz` (offline installs) |
| `--port N` | Panel port (default 7443) |
| `--open-firewall` | If ufw is active, add an allow rule for the panel port |
| `--force-unsupported` | Continue on an untested OS version or architecture |
| `-y`, `--yes` | Don't ask for confirmation (automation) |

Offline install: copy `openvps-X.Y.Z.tar.gz` and its `.sha256` file to the server, then
`sudo bash install.sh --package ./openvps-X.Y.Z.tar.gz`. The private Node.js runtime still
needs nodejs.org unless `/opt/openvps/node` already holds Node 22.13 or newer.

## First login

1. Open `https://<server-ip>:7443`.
2. Your browser warns that the certificate is self-signed. **Compare the SHA-256 fingerprint**
   the browser shows with the one the installer printed. If they match, continue.
   (Show it again with `sudo openssl x509 -in /etc/openvps/tls/cert.pem -noout -fingerprint -sha256`.)
3. Enter the **setup token** (`sudo openvps setup-token` shows it again), choose a username
   and a password of 12 or more characters.

The token works once. After setup, the panel only accepts sign-ins.

## Restrict who can reach the panel

The panel is protected by authentication, rate limiting and lockout, but the best defence
is not exposing it at all:

- **Provider firewall:** allow port 7443 only from your own IP addresses.
- **ufw:** `sudo ufw allow from <your-ip> to any port 7443 proto tcp`
- **SSH tunnel (no open port):** set `"listen": { "host": "127.0.0.1" }` in
  `/etc/openvps/config.json`, restart, and connect with
  `ssh -L 7443:127.0.0.1:7443 user@server`, then open `https://localhost:7443`.

The installer never enables ufw or changes existing rules unless you pass `--open-firewall`.

## Using your own domain and certificate

Until certificate management arrives in Phase 3, you can:

- Point `tls.certFile`/`tls.keyFile` at an existing certificate (for example one issued by
  Certbot). The `openvps` group must be able to read the key. Then
  `sudo systemctl restart openvps`.
- Or put the panel behind your own Nginx reverse proxy: set `"tls": { "enabled": false }`,
  `"listen": { "host": "127.0.0.1" }` and `"trustProxy": true`, and have Nginx terminate HTTPS
  and send `X-Forwarded-For` and `X-Forwarded-Proto`. Only enable `trustProxy` when the panel
  is reachable **only** through that proxy.

## Verify the installation

```bash
sudo openvps status
sudo systemctl status openvps
curl -k https://127.0.0.1:7443/api/health
```
