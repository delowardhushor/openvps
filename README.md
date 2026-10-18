# OpenVPS

**A lightweight, open-source, self-hosted control panel for your VPS.**

OpenVPS gives you a secure web dashboard for the server it runs on, so you can stop
repeating the same SSH commands. It is built for developers, freelancers and small
teams running Node.js applications on Ubuntu.

> **Status: early development (v0.2).** Installation, secure sign-in, live server
> monitoring and **Node.js application management with PM2** work today. Git deployments
> come in v0.3; Nginx/SSL and backups are on the [roadmap](docs/roadmap.md).

## What works today

- **One-command install** on Ubuntu 24.04 LTS with preflight checks, a checksum-verified
  download, and automatic rollback if anything fails part-way.
- **Secure first-run setup.** Claiming the panel needs a one-time token that only
  someone with shell access to the server can read.
- **Sign-in and sessions.** scrypt password hashing, HttpOnly/SameSite=Strict
  session cookies, idle and absolute timeouts, per-IP rate limits, account lockout,
  CSRF protection, a strict Content-Security-Policy, and session management.
- **Live server dashboard.** CPU (per core), load, memory, swap, disks, network
  throughput, uptime, OS details and systemd service status, with "last updated"
  and stale-data indicators.
- **Applications (PM2).** See and control the apps root already runs with PM2 (start, stop,
  restart, reload, logs) without changing their configuration. Add new Node.js apps that run as an
  unprivileged user with their own PM2, encrypted write-only environment variables, cluster
  mode, memory limits and live logs.
- **Activity log.** Sign-ins and administrative actions, with secrets redacted.
- **Local recovery CLI.** `openvps reset-password`, `unlock`, `revoke-sessions`,
  `setup-token`, `backup-db` and more.
- **Safe upgrades.** `sudo openvps upgrade` snapshots the database, switches
  releases atomically, health-checks the new version and rolls back on failure.

## Design principles

- **Small attack surface.** The server has **zero runtime npm dependencies**: it
  uses only Node.js built-ins (`http`, `sqlite`, `crypto`). There is no
  "run any command" API; external programs come from a short allowlist, called
  without a shell.
- **Least privilege.** The panel runs as an unprivileged `openvps` user inside a
  hardened systemd sandbox. The only root component is a small agent that accepts a fixed
  list of validated actions over a local socket only the panel can reach. Apps you add run as
  the unprivileged `ovapps` user.
- **Doesn't fight your server.** OpenVPS uses its own private Node.js runtime and
  never modifies your system Node.js, Nginx, PM2 or firewall policy unless you ask.
- **Self-hosted, private by default.** No external account and no telemetry. Your
  data stays on your server.

## Install

Requirements: a fresh or existing **Ubuntu 24.04 LTS** server (x86-64), root access,
512 MB+ RAM, 400 MB free disk.

```bash
curl -fsSL https://raw.githubusercontent.com/delowardhushor/openvps/main/scripts/install.sh -o install.sh
less install.sh                      # it runs as root, so read it first
sudo bash install.sh
```

The installer prints the panel URL (`https://<server-ip>:7443`) and a **setup token**.
Open the URL, accept the self-signed certificate after checking that its fingerprint
matches the one printed, then create your administrator account.

See [docs/installation.md](docs/installation.md) for options, firewall advice and
how to put the panel behind a real domain.

## Everyday commands

```bash
sudo openvps status                 # version, config, accounts
sudo openvps setup-token            # show the first-run token again
sudo openvps reset-password admin   # forgot your password
sudo openvps upgrade                # update to the latest release
sudo openvps provision              # set up / repair application management
sudo openvps uninstall              # remove (keeps data unless --purge)
journalctl -u openvps -f            # logs
```

## Documentation

| Topic | |
|---|---|
| [Installation](docs/installation.md) | Requirements, options, first login, firewall |
| [Applications](docs/applications.md) | Managing Node.js apps with PM2 |
| [Configuration](docs/configuration.md) | Every setting in `/etc/openvps/config.json` |
| [Upgrading](docs/upgrading.md) | Upgrade procedure and automatic rollback |
| [Uninstalling](docs/uninstalling.md) | What is removed and what is kept |
| [Recovery](docs/recovery.md) | Lost password, broken upgrade, restoring the database |
| [Architecture](docs/architecture.md) | How the pieces fit and where future modules go |
| [Security model](docs/security.md) | Threat model and the controls in place |
| [Development](docs/development.md) | Running locally, tests, building releases |
| [Roadmap](docs/roadmap.md) | Phases 2–6 |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
