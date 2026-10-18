# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain
breaking changes; they will always be called out here.

## [Unreleased]

## [0.2.1]

### Fixed
- `openvps provision` hung forever when run from a terminal (SSH) while looking for root's PM2:
  it started root's shell in interactive mode, which waits for the terminal. It now finds PM2
  from root's running PM2 daemon and standard install locations (npm, nvm, volta), without
  running any shell startup files.
- CI now runs `provision` inside a pseudo-terminal to catch this class of problem.

## [0.2.0] — Phase 2a: Applications

### Added
- **Applications page.** Lists PM2 processes with status, CPU, memory, uptime and restarts,
  with start/stop/restart/reload and live output/error logs.
- **Existing root PM2 apps** are detected (npm or nvm installs) and can be controlled and their
  logs read. OpenVPS never creates root processes or changes their configuration
  (`agent.manageRootPm2` makes them read-only).
- **New applications** run as the unprivileged `ovapps` user under OpenVPS's bundled PM2:
  npm script or entry file, choice of installed Node.js, arguments, cluster mode with instances,
  and a memory restart limit. Code lives under `/srv/apps`.
- **Encrypted environment variables** (AES-256-GCM, key separate from the database), write-only
  in the UI, never logged; `.env` paste import.
- **OpenVPS agent** (`openvps-agent.service`): the only root component. It accepts a fixed set of
  validated actions over a Unix socket that only the panel can reach. It refuses symlinked or
  foreign-owned log files, never spawns a PM2 daemon by accident, and serialises changes.
- `openvps-apps.service` keeps the apps PM2 running across reboots.
- `sudo openvps provision`: idempotent setup/repair of the above, run automatically by install
  and upgrade.
- Dashboard **Applications** card with running/stopped/errored counts.
- CI end-to-end test with real systemd and real PM2.

### Upgrading from 0.1
Run `sudo openvps upgrade`, then **once** `sudo openvps provision`. The 0.1 upgrader
doesn't know about the new services; later upgrades run it automatically.

### Fixed
- Installer: certificate creation on hosts with long hostnames; reuse of a leftover `openvps` group;
  failures now name the command that failed.

## [0.1.0] — Phase 1: Foundation

### Added
- Installer for Ubuntu 24.04 LTS with preflight checks (OS, architecture, systemd,
  required tools, port, disk, memory), checksum-verified downloads, a private Node.js
  runtime, a self-signed TLS certificate, a hardened systemd unit, and automatic
  rollback on failure.
- One-time setup token protecting first administrator creation.
- Administrator sign-in with scrypt hashing, server-side sessions (idle and absolute
  expiry), per-IP rate limiting, account lockout, CSRF protection and security headers.
- Session management and password change in the web UI.
- Live dashboard: CPU (total and per core), load average, memory and swap, disks,
  network throughput, uptime, OS details and systemd service status, with
  last-updated and stale indicators.
- Activity (audit) log with secret redaction and retention.
- `openvps` CLI: `status`, `setup-token`, `users`, `reset-password`, `unlock`,
  `revoke-sessions`, `migrate`, `check-config`, `audit`, `backup-db`, `upgrade`,
  `uninstall`.
- Upgrade script with database snapshot, atomic release switch, health check and
  automatic rollback; uninstall script that keeps data unless `--purge`.
- Versioned SQLite schema migrations.
- Documentation, CI workflow, release workflow and issue templates.

[Unreleased]: https://github.com/delowardhushor/openvps/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.1
[0.2.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.0
[0.1.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.1.0
