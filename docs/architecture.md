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
