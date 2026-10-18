# Roadmap

Based on the OpenVPS Business Requirements Document. Each phase ships when its exit
criteria are met.

## Phase 1: Foundation ✅ (v0.1)

Repository structure and standards, installer with OS checks, initial administrator setup,
authentication and session security, server dashboard, persistent configuration and logging.

**Exit criteria:** a fresh Ubuntu 24.04 install can securely launch the dashboard and display
server metrics.

## Phase 2: Application management

**v0.2 ✅**: register Node.js applications (name, directory, runtime, start command), encrypted
environment variables, PM2 integration (list, start, stop, restart, reload, status, restarts, logs)
for both root's existing apps and apps run by the unprivileged `ovapps` user, and the privileged
agent with a narrow, audited action set.

**Next**: Git deployments with repository and branch, per-app deploy keys, dependency
install, validated build steps (including building React/static sites into their site folder),
release directories, health check, automatic rollback and deployment history.

**Exit criteria:** a user can deploy and manage a Node.js application through the interface.

## Phase 3: Web infrastructure ✅ (v0.3)

- Nginx sites generated from validated settings: reverse proxy to an app (with WebSockets),
  single-page apps (React, Vue, Angular builds), static websites, and the panel itself
- `nginx -t` before and after every change, with an exact restore on failure
- Existing hand-made sites detected and shown read-only; domain conflicts refused
- Let's Encrypt via Certbot: DNS and port-80 checks before issuance, automatic renewal by
  Certbot's timer, expiry warnings on the dashboard

Later: adopting hand-made sites into OpenVPS, wildcard certificates (DNS-01), custom Nginx snippets.

**Exit criteria:** an application is reachable on its domain over HTTPS.

## Phase 4: Backups and stability

**v0.4 ✅ (backups):** scheduled folder and MongoDB backups, local and S3-compatible storage,
retention, integrity checks, guided restore. **Still to do in this phase:** client-side
encryption of backups, backing up OpenVPS's own database and key, restore tests on clean VPS
instances in CI, and the security review.

- Scheduled MongoDB (`mongodump`) and file backups
- Destinations: local plus S3-compatible storage (off-server strongly recommended)
- Retention policies, integrity checks, guided restore with overwrite warnings
- Security review and end-to-end tests on clean VPS instances

**Exit criteria:** installation, deployment, backup, restore and recovery tests pass.

## Phase 5: Public release

Complete documentation, GitHub Releases, clean-VPS install testing, public beta, then stable.

## Phase 6: Future

Remote multi-server management, team accounts with roles and MFA, more runtimes and databases,
alerting, and optional commercial services (the self-hosted core stays free).
