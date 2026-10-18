# Development

## Prerequisites

- Node.js **22.13+** (24 LTS recommended). The server source is TypeScript that Node runs
  directly through type stripping, so the dev loop has no build step.
- npm 10+

## Run locally

```bash
npm install
npm run dev:server   # http://127.0.0.1:7800, data in server/.data, restarts on change
npm run dev:web      # http://localhost:5173 with hot reload; /api is proxied to :7800
```

Open http://localhost:5173. The dev server logs a `development setup token` (also in
`server/.data/setup-token`). Delete `server/.data` to start over.

### Applications in development

`npm run dev:agent` starts the agent as your own user on `server/.data/agent.sock`, with
apps under `server/.data/apps`. It needs a PM2 to talk to: point it at one with a config file,
for example `{"apps": {"pm2Bin": "/usr/local/lib/node_modules/pm2/bin/pm2", "pm2Node": "/usr/local/bin/node"}}`
in `OPENVPS_CONFIG`, and use the same file for `dev:server`. Without one, the Applications page
explains that PM2 is unavailable. The automated tests use a stand-in PM2
(`server/test/fixtures/fake-pm2.mjs`); CI also runs a real-PM2 end-to-end test
(`scripts/ci/apps-e2e.sh`).

On macOS, metrics fall back to Node's `os` module: CPU, memory, load and root disk work;
network and swap show as unavailable.

To use the CLI against your dev data:

```bash
cd server
OPENVPS_DEV=1 node src/cli.ts status
OPENVPS_DEV=1 node src/cli.ts reset-password admin
```

## Tests

```bash
npm test             # server unit + API tests (node:test)
npm run typecheck    # server and web
```

- `server/test/unit.test.ts`: password hashing, rate limiting, sessions, migrations, config
  validation, redaction, /proc parsers (with fixtures), the metrics collector, the exec allowlist.
- `server/test/api.test.ts`: the HTTP API end to end on an ephemeral port: setup token flow,
  authentication and lockout, CSRF, body limits, security headers, sessions, audit redaction,
  static file traversal.

Add tests with any behaviour change. API tests use `startTestServer()` and the cookie-jar
`Client` in `test/helpers.ts`.

## Build and package

```bash
npm run build                 # server/dist (tsc) and web/dist (vite)
bash scripts/package-release.sh   # release/openvps-<version>.tar.gz + .sha256
```

Test a package on a disposable Ubuntu 24.04 VM:

```bash
scp release/openvps-0.1.0.tar.gz* scripts/install.sh root@vm:
ssh root@vm 'bash install.sh --package ./openvps-0.1.0.tar.gz --yes'
```

## Project conventions

See [CONTRIBUTING.md](../CONTRIBUTING.md#coding-standards).
