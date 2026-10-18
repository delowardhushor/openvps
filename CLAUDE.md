# OpenVPS: project context for AI assistants

Read this first. It is the hand-off document for any new AI session (Claude Code reads
`CLAUDE.md` automatically; `AGENTS.md` points here for other tools). **Keep it up to date:**
when a session changes architecture, conventions, status or workflow, update this file in
the same change.

## What OpenVPS is

An open-source (MIT), self-hosted control panel for a single Ubuntu 24.04 VPS, aimed at
developers running Node.js apps. Repo: https://github.com/delowardhushor/openvps
(maintainer: `delowardhushor`). Built from a BRD with phases:

| Phase | Version | Status |
|---|---|---|
| 1 Foundation: installer, auth, dashboard | v0.1.0 | ✅ released |
| 2a Applications: PM2, agent, env vars | v0.2.0, v0.2.1 (provision hang fix) | ✅ released |
| 3 Sites, domains, SSL (Nginx + Certbot) | v0.3.0 | ✅ built; release in progress (see "Current state") |
| 2b Git deployments | v0.4 (next) | not started |
| 4 Backups (MongoDB, files, S3) | later | not started |
| 5 Public release / 6 Future (multi-server, teams, MFA) | later | — |

Details: `docs/roadmap.md`, `CHANGELOG.md`.

## Hard design rules (do not break)

- **Zero runtime npm dependencies on the server.** Only Node built-ins: `node:http`,
  `node:sqlite`, `node:crypto`, `node:test`. Node >= 22.13. TypeScript is run via type
  stripping in dev/tests (`erasableSyntaxOnly`, `rewriteRelativeImportExtensions`; imports use
  `.ts` extensions) and compiled with `tsc` for releases. No enums/namespaces/parameter properties.
- **Panel is unprivileged.** `openvps.service` runs as user `openvps`, `ProtectSystem=strict`,
  no capabilities, HTTPS on port 7443 with a self-signed cert by default.
- **All root work goes through the agent** (`openvps-agent.service`, root, moderate sandbox:
  `ProtectSystem=full` + `ReadWritePaths=-/etc/nginx -/etc/letsencrypt`). Unix socket
  `/run/openvps-agent/agent.sock` (root:openvps 0660, dir 0750), one JSON-line request per
  connection, **fixed allowlist of named actions** in `server/src/agent/spec.ts`
  (`AGENT_ACTIONS`). Never add an action that takes a command string. Validate in panel *and*
  agent.
- **Apps run as `ovapps`** under OpenVPS's bundled PM2 (`/opt/openvps/pm2`, daemon =
  `openvps-apps.service`, `Type=forking`, `pm2 resurrect`). Code lives in `/srv/apps`.
  Root's existing PM2 is **control-only** (list/start/stop/restart/reload/logs); OpenVPS never
  creates root processes. The agent never spawns a PM2 daemon if one is down.
- **Never touch what we don't own.** Nginx: only `openvps-*.conf` files; hand-made sites are
  read-only and their domains are refused. Root PM2 config is never edited.
- **Every Nginx change**: `nginx -t` before (refuse if already broken) and after; exact undo on
  failure; then reload. Certbot: `certonly --webroot -w /var/lib/openvps-agent/acme
  --cert-name openvps-<name> --deploy-hook "systemctl reload nginx"`, fixed args only.
  Renewal is left to Certbot's own timer.
- Secrets: app env vars sealed with AES-256-GCM (`secretbox.ts`, key file `secret.key`),
  write-only in the UI/API, redacted in logs/audit (`redact.ts`).
- Every mutating API call is audited (`audit.ts`, actions like `app.create`, `site.update`,
  `certificate.issue`).
- Security headers/CSRF: mutating requests need header `x-openvps-request: 1` plus
  Sec-Fetch-Site/Origin checks; session cookie `__Host-ovps_sid`, HttpOnly, SameSite=Strict.

## Repository layout

```
server/src/
  main.ts, bootstrap.ts, app.ts      panel entry, wiring, HTTP app (security headers, clientIp, CSRF)
  config.ts                          /etc/openvps/config.json + OPENVPS_* env, strict validation
  context.ts                         AppContext passed to routes (db, stores, agent client, ...)
  http/core.ts, http/static.ts       tiny router, HttpError, SPA static serving
  auth/                              scrypt passwords, sessions, rate limit, setup token, users
  db/index.ts, db/migrations.ts      node:sqlite; forward-only numbered migrations (1 initial, 2 apps, 3 sites)
  routes/system.ts|auth.ts|apps.ts|sites.ts   HTTP API (agentError() maps agent codes -> HTTP)
  apps-store.ts, sites-store.ts      SQLite records for apps (sealed env) and sites (spec JSON)
  metrics/, system/                  /proc metrics collector, systemd service status
  cli.ts                             `openvps` local CLI (reset-password, unlock, setup-token, audit, backup-db...)
  agent.ts                           agent entry + buildAgent()/buildSites() (paths, systemd/nginx control)
  agent-client.ts                    panel -> agent socket client
  agent/spec.ts                      THE protocol: action allowlist + AppSpec validation
  agent/server.ts                    socket server + dispatcher (createDispatcher)
  agent/pm2.ts, apps.ts, runtimes.ts PM2 control, app apply/remove, Node runtimes
  agent/sites-spec.ts                SiteSpec {name, domains, type proxy|static|spa|panel, upstreamPort, root, https, forceHttps, hsts, maxBodyMb}
  agent/nginx-parse.ts               nginx config tokenizer/parser (existing servers, conflicts, layout)
  agent/nginx-render.ts              renders openvps-<name>.conf (+ openvps-00-shared.conf map)
  agent/sites.ts                     SitesManager: status, certificates, apply/remove with undo, checks, issue
  agent/exec.ts                      runTool (execFile, no shell, PATH incl. /snap/bin)
server/test/                         node:test suites; agent-fixture.ts (fake pm2 + temp nginx tree + fake certbot)
web/src/                             React (Vite) SPA, no UI library; plain CSS in styles.css (light/dark tokens)
  api.ts (typed client), router.ts, format.ts, components/, pages/
scripts/install.sh|upgrade.sh|uninstall.sh|provision.sh   bash, shellcheck-clean (-S warning)
scripts/package-release.sh           builds release/openvps-<ver>.tar.gz (+ bundled PM2) and .sha256
scripts/ci/apps-e2e.sh, sites-e2e.sh real-systemd end-to-end tests run on GitHub runners
packaging/                           systemd units, openvps CLI wrapper, config.example.json
docs/                                installation, applications, sites, configuration, upgrading,
                                     uninstalling, recovery, architecture, security, development, roadmap
```

On the server: `/opt/openvps/releases/<ver>` + `current` symlink (atomic switch),
`/opt/openvps/node` (private Node), `/etc/openvps/config.json` (root:openvps 0640),
`/var/lib/openvps` (DB, backups), `/var/lib/openvps-agent` (state, app specs, `acme/`),
`/usr/local/bin/openvps`.

## Commands

```bash
npm ci                     # root workspace (server + web)
npm run typecheck          # server + web
npm test                   # server tests (node:test, --test-concurrency=1)
npm run build              # tsc for server, vite build for web
npm run dev:server         # OPENVPS_DEV=1: HTTP on 127.0.0.1:7800, data in ./.data
npm run dev:web            # Vite dev server
bash scripts/package-release.sh
shellcheck -S warning scripts/*.sh scripts/ci/*.sh packaging/*.sh
```

Tests that use the real `nginx` binary skip unless running as root (`nginx -t` binds port 80);
`realNginxSkip()` in `server/test/agent-fixture.ts`. CI covers them in `sites-e2e.sh` (root,
real Nginx + Certbot + Pebble test CA).

## Install / upgrade behaviour (important when changing scripts)

- `install.sh`: preflight, checksum-verified package, private Node, `openvps` user, config,
  self-signed TLS (CN fixed to "OpenVPS"), units, then runs `provision.sh`. Rolls back only what
  this run created. Never enables ufw unless `--open-firewall`.
- `upgrade.sh`: DB snapshot, new release dir, atomic symlink switch, health check, rollback on
  failure, then runs `provision.sh` (so new units/agent changes apply automatically).
- `provision.sh` (idempotent): `ovapps` user, `/srv/apps`, bundled PM2, detects root's PM2
  **without starting a login/interactive shell** (that hung v0.2.0 in a TTY), acme dir, checks
  Nginx/Certbot, installs/restarts agent + apps units.
- `uninstall.sh [--purge]`: keeps websites created in OpenVPS running (removes only the
  panel-type site), keeps `/var/lib/openvps-agent/acme` if openvps sites remain.

## Workflow with the maintainer (how sessions have worked)

- The maintainer works on a Mac (`/Users/technonext/Desktop/works/next/openvps`) and **commits,
  tags and pushes himself**. AI sessions do not push. When a cloud session is linked to the Mac,
  files are written into that folder; files under `.github/` cannot be written that way, so CI
  workflow changes are delivered as a zip to unzip into the project.
- Watch file modes when copying: scripts must stay executable (`chmod +x scripts/*.sh`).
- Release: bump version in `package.json`, `server/package.json`, `web/package.json` and
  `package-lock.json` (4 places), update `CHANGELOG.md`, commit, `git tag vX.Y.Z`, push tags.
  `.github/workflows/release.yml` builds and publishes the GitHub release; users run
  `sudo openvps upgrade`. Publishing right after tagging can race: the upgrader may still see
  the old "latest" for a minute (`--version` forces one).
- The maintainer prefers explanations in plain language; he runs a production VPS with existing
  root-PM2 Node apps and a hand-made Nginx + Certbot site, so backwards compatibility with an
  existing server setup matters.

## Gotchas learned

- `bash -lic` / interactive shells grab the TTY and ignore SIGTERM: never use them in scripts.
- GitHub runner hostnames are long: TLS cert CN must not use the hostname (64-char limit).
- `nginx -s reload` / `systemctl reload nginx` return before new workers serve: the agent waits
  ~400 ms after reload, and the port-80 pre-flight retries.
- Nginx `add_header` in a location drops server-level headers: HSTS is repeated in locations.
- Nginx < 1.25.1: `http2` is a listen-socket flag; we only enable it if other 443 listeners have
  it (else "protocol options redefined"). >= 1.25.1 uses `http2 on;`.
- Static/SPA sites use `disable_symlinks if_not_owner` and roots are realpath-checked against
  `sites.staticRoots` (`/srv/apps`, `/var/www`).
- Panel behind its own Nginx site: trusts `X-Real-IP`/last `X-Forwarded-For` only from loopback.
- `pkill -f pattern` can match the invoking shell; use `[p]attern`.

## Current state (update this section every session)

- **v0.3.0** (sites/domains/SSL) is committed and tagged. CI's `npm test` failed on the first
  push because real-nginx suites ran as non-root; fixed by skipping them when not root. The
  maintainer may need to move the `v0.3.0` tag to the fix commit and confirm CI is green,
  including the new "Sites and certificates end-to-end" job (not yet seen passing on GitHub).
- **Next: v0.4 Git deployments** — repo + branch per app, per-app deploy keys, `npm ci` and
  validated build steps, release directories with atomic switch, health check, rollback,
  deployment history; also building React/static sites into their site folder. Deploys are
  triggered by a button only (no webhooks) — maintainer's decision.
- Decisions on record: existing root PM2 apps stay under root (control-only); existing Nginx
  sites read-only (adoption later); static files come from a folder on the server; panel can
  be served on its own domain.
