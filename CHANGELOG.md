# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain
breaking changes; they will always be called out here.

## [Unreleased]

## [0.4.0] — Phase 4: Backups

### Added
- **Backups page** (Phase 4). Backup plans copy app folders and MongoDB databases on a schedule
  (hourly, daily, weekly or on demand) to this server, to S3-compatible cloud storage, or both.
  - Folders are archived with `tar` (names like `node_modules` can be skipped); MongoDB uses
    `mongodump --archive --gzip`, with the connection string stored encrypted and passed through a
    private temporary file, never on the command line.
  - Cloud storage works with Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean
    Spaces, MinIO and similar (a built-in AWS Signature V4 client, no SDK; multipart upload for
    large backups). **Test connection** checks keys and bucket before you rely on them.
  - Retention: keep the newest N backups and optionally nothing older than N days; only a plan's
    own backups are ever deleted.
  - Integrity: each backup records SHA-256 checksums; **Check** and **Full check** verify local
    and cloud copies; restores verify before writing anything.
  - Guided restore: choose folders and databases, restore into a separate folder (default) or over
    the current one with an overwrite warning, optionally drop MongoDB collections first, and type
    the plan name to confirm. Backups in the bucket are listed and restorable on a new server.
  - Runs in the agent as low-priority background jobs, one at a time, with live progress; missed
    schedules run once when the panel is back; failures are recorded and shown (partly done when
    one destination failed).
- `backups.*` configuration (local directory, allowed folders, scheduler switch, tool paths).
- `openvps provision` creates `/var/backups/openvps` (root only) and reports whether `mongodump`
  is installed. Uninstall always leaves backups in place.
- Database migration 4 (backup plans, storage destinations, run history).
- CI: `scripts/ci/backups-e2e.sh`, an end-to-end test of backups against a real S3-compatible
  server, MongoDB with authentication and the MongoDB Database Tools, under the agent's systemd
  sandbox.

### Fixed
- The finished backup file is now always created readable by root only (`0600`); before, this
  relied on the agent service's `UMask`.

## [0.3.0] — Phase 3: Sites, domains and SSL

### Added
- **Sites & domains page.** Put a domain in front of:
  - an **app** on a local port (reverse proxy with forwarding and WebSocket headers),
  - a **single-page app** build such as a React/Vite admin panel (client-side routes fall back
    to `index.html`, which is never cached; fingerprinted assets are cached for 30 days),
  - a **static website** folder,
  - the **OpenVPS panel** itself, so it can be reached on a domain with a trusted certificate.
- **Free HTTPS with Let's Encrypt.** Before requesting a certificate, OpenVPS checks that every
  domain resolves and reaches this server on port 80 (avoiding Let's Encrypt's failed-validation
  limits), then issues it with Certbot, switches the site to HTTPS with an HTTP→HTTPS redirect,
  and leaves renewal to Certbot's timer. Optional HSTS and upload size limit.
- **SSL certificates page** listing every certificate on the server (OpenVPS's, Certbot's and
  any other used by Nginx) with days left, renewal status and which sites use it, plus the Let's
  Encrypt account email. The dashboard warns about certificates expiring within 21 days.
- **Existing Nginx sites** are listed read-only; OpenVPS never changes them and refuses to
  create a site for a domain they already serve.
- Every change is checked with `nginx -t` and restored exactly if Nginx rejects it. OpenVPS does
  nothing while the existing configuration is broken. On Nginx before 1.25.1, HTTP/2 is only
  enabled when other sites on port 443 use it (avoiding "protocol options redefined").
- `sites.*` configuration (static folders, Nginx/Certbot paths, alternative ACME server).
- CI: end-to-end test with real Nginx, Certbot and Pebble (Let's Encrypt's test CA), including
  renewal through Certbot's own path.

### Changed
- `openvps provision` prepares `/var/lib/openvps-agent/acme` and reports whether Nginx and
  Certbot are installed. It runs automatically on upgrade.
- The agent's systemd sandbox may now write `/etc/nginx` and `/etc/letsencrypt`.
- When requests come from Nginx on the same server, the panel uses `X-Real-IP` for the client
  address (rate limits, activity log) and honours `X-Forwarded-Proto` for secure cookies.
- `uninstall` keeps websites created in OpenVPS running and removes only the panel's own site.
- Git deployments move to v0.4.

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

[Unreleased]: https://github.com/delowardhushor/openvps/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.4.0
[0.2.1]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.1
[0.2.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.0
[0.1.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.1.0
