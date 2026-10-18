# Architecture

```
 Browser ──HTTPS──▶ openvps.service (Node.js, user "openvps", systemd sandbox)
                     │
                     ├─ http/        tiny router, JSON bodies, CSRF, security headers, static SPA
                     ├─ auth/        scrypt passwords, sessions, rate limits, setup token
                     ├─ metrics/     /proc parsers + sampler with in-memory history
                     ├─ system/      allowlisted program runner (execFile, no shell)
                     ├─ routes/      API endpoints per module
                     ├─ audit.ts     activity log with redaction
                     └─ db/          node:sqlite, WAL mode, versioned migrations
                           │
                           ▼
                     /var/lib/openvps/openvps.db

 openvps CLI (root → runuser openvps) ──▶ same database (recovery, admin tasks)
 install.sh / upgrade.sh / uninstall.sh ──▶ /opt/openvps, /etc/openvps, systemd
```

## Repository layout

```
server/          API, CLI and agent (TypeScript, Node.js built-ins only)
  src/
  test/          node:test unit and API tests
web/             React + Vite single-page app
scripts/         install, upgrade, uninstall, package-release
packaging/       systemd unit, CLI wrapper, example config
docs/            documentation
.github/         CI, release workflow, issue templates
```

## Key decisions

**No runtime npm dependencies on the server.** A control panel runs next to everything else
on the server and is a valuable target. Node.js 22.13+ provides HTTP(S), SQLite
(`node:sqlite`), scrypt and a test runner, which covers Phase 1. This removes
supply-chain risk and native-addon compilation from installs. The web UI does use npm
packages (React, Vite), but only at build time; the shipped bundle is static files.

**SQLite.** One file, no extra service, transactional, easy to snapshot (`VACUUM INTO`) and
restore. WAL mode keeps reads non-blocking. If multi-server management ever needs a shared
database, the data access is isolated in small classes (`Users`, `Sessions`, `Audit`) that
can be re-implemented.

**Private Node.js runtime.** Users' applications often depend on a specific system Node.js
or nvm setup. OpenVPS ships its own runtime in `/opt/openvps/node` so the two never conflict
(BR-09).

**Release directories and an atomic symlink.** `/opt/openvps/releases/<version>` plus
`current → releases/<version>` makes upgrades and rollbacks a rename. Phase 2 will use the same
pattern for application deployments.

**Unprivileged by default.** The panel reads `/proc`, asks systemd for unit status, and talks to the
agent; none of that needs root. Its systemd unit removes all capabilities and applies
`ProtectSystem=strict`, `NoNewPrivileges`, a syscall filter and more. Root work is confined to the
agent's fixed action list.

## The agent and applications (v0.2)

```
 panel (openvps) ──Unix socket──▶ openvps-agent (root)
                                    ├─ root's PM2   (existing apps: list, control, logs only)
                                    └─ runuser ovapps → OpenVPS PM2 ──▶ apps in /srv/apps
                                                         ▲
                                     openvps-apps.service (PM2 daemon for ovapps, survives reboots)
```

- `server/src/agent/spec.ts`: the protocol. It lists the only actions the agent accepts, and the
  validation of app specs and env vars, shared by the panel and the agent.
- `server/src/agent/pm2.ts`: talks to one PM2 installation (binary, `PM2_HOME`, user). It parses
  `jlist`, keeps only safe fields, and tails logs safely.
- `server/src/agent/apps.ts`: turns an app spec into a PM2 ecosystem definition after filesystem
  checks, then replaces and saves it.
- `server/src/agent/server.ts`: the socket server, one JSON request per connection.
- `server/src/agent-client.ts`: the panel's client. `routes/apps.ts` exposes the HTTP API.
- `server/src/secretbox.ts` + `apps-store.ts`: apps and their sealed environment in SQLite.

Rules for future privileged features (Nginx, Certbot, backups):

1. Add a **named action** to `spec.ts` with typed parameters. Never accept a command string.
2. Validate again in the agent; write files atomically into root-owned locations; run the tool's
   own check (`nginx -t`) and restore the previous file on failure (FR-07, BR-05).
3. Return only what the UI needs; never return secrets.
4. Audit the call in the panel with actor, parameters (redacted) and outcome.
5. Cover it with tests against a fake tool and, where possible, an end-to-end CI job.

## Sites and certificates (v0.3)

```
 panel ──socket──▶ agent (root) ── writes /etc/nginx/sites-available/openvps-<name>.conf
                                 ├─ nginx -t  → reload  (or restore the previous files exactly)
                                 ├─ DNS + HTTP token check on port 80
                                 └─ certbot certonly --webroot -w /var/lib/openvps-agent/acme
                                                     --cert-name openvps-<name>
                                                     --deploy-hook "systemctl reload nginx"
```

- `agent/sites-spec.ts`: the `SiteSpec` and its validation (strict domain, name and path rules),
  shared by panel and agent. Nothing from the user reaches a config file unvalidated.
- `agent/nginx-render.ts`: renders a site from a spec. Every site serves the ACME path; HTTPS
  is added once a certificate exists.
- `agent/nginx-parse.ts`: a small tokenizer/parser for Nginx's syntax, used to list existing
  sites, detect domain conflicts and find which certificates are in use.
- `agent/sites.ts`: status, apply/remove with undo, pre-flight checks, Certbot.
- `routes/sites.ts` + `sites-store.ts`: the HTTP API and the site records in SQLite.

OpenVPS owns only files named `openvps-*`. Renewal is left to Certbot's timer so that
certificates keep renewing even when OpenVPS is stopped or removed.

## Backups (v0.4)

```
 panel (plans, schedule, history in SQLite)             agent (root)
   │  BackupService polls every 2 s, scheduler every 30 s
   ├─ backup.run {sources, sealed secrets in request} ─▶ one background job at a time:
   ├─ backup.job {id}  ◀─ step, log, result ───────────    tar -czf / mongodump --archive --gzip
   └─ backup.list / inspect / restore / verify / delete     → pack → sha256 → /var/backups/openvps/<plan>/
                                                           → S3 PUT (multipart if large) → retention
```

- `agent/backup-spec.ts`: the plan model, schedule maths, manifest format and strict validation,
  shared by panel and agent (storage endpoints, bucket and folder names, tar exclusions...).
- `agent/backup.ts`: `BackupManager`. Jobs are in agent memory (the panel records the outcome); a
  job the agent no longer knows about is reported as interrupted. The agent holds no credentials:
  MongoDB connection strings and storage keys arrive with each request, MongoDB's go to the tool in
  a `0600` file inside the job's staging directory, and everything is scrubbed from error text.
- `agent/s3.ts`: SigV4 over `node:http(s)` (single and multipart upload, list, head, get, delete),
  checked against AWS's published signing example. No SDK.
- `backups-store.ts`, `backups.ts`, `routes/backups.ts`: plans, destinations (keys sealed with
  `secretbox`), run history, the scheduler and the HTTP API. Missed schedules run once on return.

The agent never takes a command string: `tar`, `mongodump` and `mongorestore` run with fixed
arguments built from validated values.

## Request lifecycle

1. Security headers are set on every response (CSP, frame denial, HSTS over TLS).
2. Non-`/api` paths serve the SPA from `web/dist` (confined to that directory).
3. For `/api`: route match, then a CSRF check for mutating methods (custom header plus
   Sec-Fetch-Site and Origin checks), then session lookup from the HttpOnly cookie, then
   the auth requirement, then a JSON body parse (32 KB limit), then the handler.
4. `HttpError`s become `{ error: { code, message, field? } }`; anything else is logged
   and returned as a generic 500.

## Metrics

`MetricsCollector` reads `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime`,
`/proc/net/dev`, `/proc/mounts` and `statfs` every `metrics.intervalSeconds`, with no
subprocesses. CPU and network figures are deltas between samples. A ring buffer keeps
`historyMinutes` of points for charts. Snapshots carry `collectedAt`; the API marks data
stale after two missed intervals.

## Adding a module

1. Create `server/src/routes/<module>.ts` exporting `register<Module>Routes(router, app)` and
   register it in `app.ts`.
2. Add tables through a new migration.
3. Audit every state-changing action.
4. Add a page in `web/src/pages/` and a nav entry in `components/Layout.tsx`.
5. Add API tests through `test/helpers.ts`.
