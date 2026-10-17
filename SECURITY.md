# Security policy

OpenVPS manages servers, so we treat security reports as our highest priority.

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release (0.x) | ✅ security fixes |
| Older releases | ❌ please upgrade |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab).

Please include:

- the affected version (`openvps version`) and OS
- a description of the issue and its impact
- steps to reproduce or a proof of concept
- any suggested fix

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within 3 business days |
| Initial assessment and severity | within 7 days |
| Fix released for critical/high issues | within 30 days, sooner when actively exploited |

We will keep you updated, credit you in the advisory and changelog (unless you
prefer otherwise), and coordinate a disclosure date with you. Please give us a
reasonable chance to release a fix before public disclosure.

## Scope

In scope: the OpenVPS server, web UI, CLI, installer, upgrade and uninstall scripts.

Out of scope: vulnerabilities in third-party software OpenVPS manages (Nginx,
PM2, Node.js, Ubuntu packages) unless OpenVPS configures them insecurely; attacks
that need existing root access to the server; denial of service through
volumetric traffic.

## Hardening recommendations for operators

See [docs/security.md](docs/security.md#operator-checklist).
