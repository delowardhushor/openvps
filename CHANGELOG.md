# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain
breaking changes; they will always be called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/delowardhushor/openvps/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.1.0
