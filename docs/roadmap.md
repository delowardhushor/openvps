# Roadmap

Based on the OpenVPS Business Requirements Document. Each phase ships when its exit
criteria are met.

## Phase 1: Foundation ✅ (v0.1)

Repository structure and standards, installer with OS checks, initial administrator setup,
authentication and session security, server dashboard, persistent configuration and logging.

**Exit criteria:** a fresh Ubuntu 24.04 install can securely launch the dashboard and display
server metrics.

## Phase 2: Application management

- Register Node.js applications (name, directory, runtime, start command)
- Encrypted environment variables
- PM2 integration: list, start, stop, restart and reload, status, restarts, logs
- Git deployments: repository and branch, deploy keys, dependency install, validated build steps,
  release directories, health check, automatic rollback, deployment history
- Privileged helper with a narrow, audited action set (see [architecture](architecture.md#privileged-operations-phase-2))

**Exit criteria:** a user can deploy and manage a Node.js application through the interface.

## Phase 3: Web infrastructure

- Nginx reverse-proxy sites per application, generated from templates
- `nginx -t` validation before reload; automatic restore on failure
- Detect existing sites and require explicit adoption
- Let's Encrypt via Certbot: prerequisite checks (DNS, port 80), issuance, renewal monitoring,
  expiry warnings
- Option to serve the panel itself on a domain with a trusted certificate

**Exit criteria:** an application is reachable on its domain over HTTPS.

## Phase 4: Backups and stability

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
