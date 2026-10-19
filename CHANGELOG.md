# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain
breaking changes; they will always be called out here.

## [Unreleased]

## [0.6.0] — Files page and lower CPU and memory use

### Added
- **Files page: a file manager with drag-and-drop upload.** Browse `/srv/apps` and `/var/www`
  (configurable with `files.roots`), upload files or whole folders by dropping them anywhere on the
  page (progress per file, cancel, retry, replace prompts), download, rename/move, delete, create
  folders and files, and edit UTF-8 text files up to 1 MB with a save-conflict check. Uploads
  stream to disk (no buffering in memory) and are renamed into place when complete. Every operation
  runs in a short-lived helper process started by the agent as the folder's owner (`ovapps` for
  `/srv/apps`), so permissions and symlink safety are enforced by the kernel. All changes are in the
  activity log. New settings `files.roots`, `files.maxUploadMb` (2048), `files.maxEditKb` (1024).
  See docs/files.md. New agent actions `files.list/mkdir/move/delete` and the streaming
  `files.upload/download`; the agent socket now carries file bytes after the request line for those
  two. `scripts/ci/files-e2e.sh` checks ownership and symlink handling on a real host and runs in CI.
- docs/performance.md: measured and estimated CPU, memory and disk use, and advice for small
  servers.

### Changed (lower CPU and memory use, mainly for small servers)
- **MongoDB server is no longer installed on servers with under about 2 GB of RAM.** Only the
  Database Tools (enough for backups) are installed there. `OPENVPS_MONGODB_SERVER=1` forces the
  server. Existing installs are left alone; provision prints a hint if a MongoDB server runs on a
  small machine.
- **Fewer PM2 CLI starts.** The agent reuses a `pm2 jlist` result for 4 seconds, shares one run
  between concurrent callers, and drops the cache on every start/stop/restart/delete/save. Log
  viewing accepts a listing up to 30 seconds old (log paths only change on restart). The panel
  lists the root and apps PM2 one after the other instead of at once (half the peak memory).
  The PM2 CLI runs with Node's compile cache (`NODE_COMPILE_CACHE`) so each start costs less CPU.
- **Slower background polling in the web UI:** the Applications list and app detail refresh every
  10 s (was 5 s), the dashboard process card every 30 s (was 15 s). Hidden tabs still do not poll.
- **Smaller panel and agent memory:** the units start Node with `--max-semi-space-size=1
  --v8-pool-size=0` and a heap cap (160 MB panel, 128 MB agent). About 9 MB less after heavy use.
- **Backup archives also run under `ionice`** (best-effort, lowest priority), in addition to
  `nice`, so a big backup disturbs your apps less. It is skipped where the kernel refuses it.
- The panel HTTP server no longer has an overall request timeout (so long uploads work); idle
  connections are closed after 120 s and JSON request bodies must arrive within 30 s.

### Upgrading
- `sudo openvps upgrade` applies everything, including the new unit files (provision restarts the
  agent). No database migration.
- If the panel is served on its own domain, open that site in **Sites & domains** and save it once
  so its Nginx configuration gets the new `/api/files/` location (no upload size limit, no
  buffering); without it, uploads through the domain are limited by the site's body size setting.
- Servers that already got a MongoDB server from 0.5.x keep it; to free its memory when you do not
  need it: `sudo systemctl disable --now mongod`.

[Unreleased]: https://github.com/delowardhushor/openvps/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.6.0
[0.5.1]: https://github.com/delowardhushor/openvps/releases/tag/v0.5.1
[0.5.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.5.0
[0.4.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.4.0
[0.2.1]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.1
[0.2.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.2.0
[0.1.0]: https://github.com/delowardhushor/openvps/releases/tag/v0.1.0
