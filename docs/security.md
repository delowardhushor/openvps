# Security model

## Assets and threats

| Asset | Main threats |
|---|---|
| Administrator access to the panel | Password guessing, session theft, CSRF, someone claiming the panel before you |
| The server itself | Escalating from the panel to arbitrary command execution |
| Secrets (passwords, tokens, keys) | Leakage through logs, the activity log or the database |
| The installation process | Tampered downloads, breaking an existing server |

## Controls in Phase 1

**Claiming the panel.** Until an administrator exists, setup requires a random one-time
token (144 bits) stored only as a SHA-256 hash, plus a `0600` file readable by root and
`openvps`. Without shell access, nobody can complete setup. Setup is atomic, so two concurrent
requests cannot both create an admin. The token is deleted once used.

**Passwords.** scrypt (N=2¹⁵, r=8, p=1, 64-byte key, 16-byte salt), parameters stored per hash
and upgraded on next sign-in if raised. Minimum length 12, no username, no single repeated
character, a small common-password blocklist. Comparisons are constant-time; unknown usernames
are verified against a dummy hash so timing does not reveal valid names.

**Brute force.** Per-IP rate limit (default 20 attempts per 15 minutes) and per-account lockout
(5 failures, 15 minutes). Error messages do not distinguish unknown users from wrong passwords.
Every attempt is audited with its source IP.

**Sessions.** 256-bit random tokens in an `HttpOnly; SameSite=Strict; Secure` cookie (with the
`__Host-` prefix over HTTPS). Only the SHA-256 of the token is stored server-side, so a database
leak does not leak sessions. Idle timeout (2 h) and absolute lifetime (12 h). Changing a password
signs out other sessions; you can list and revoke sessions in the UI or with the CLI.

**CSRF.** SameSite=Strict, plus every mutating request needs the `X-OpenVPS-Request` header
(which a cross-origin page cannot send without a CORS preflight, and OpenVPS never allows CORS),
plus `Sec-Fetch-Site` and `Origin` checks.

**Browser hardening.** Strict CSP (`default-src 'self'`, no inline scripts or styles,
`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
HSTS over TLS, `Cache-Control: no-store` on API responses.

**Transport.** HTTPS by default (TLS 1.2+), using a self-signed ECDSA certificate created at
install time, with its fingerprint printed for verification.

**No command execution API.** External programs can only be started through
`system/exec.ts`: a hard-coded allowlist of absolute paths, `execFile` with no shell, a
restricted argument character set, a minimal environment, timeouts and output caps. Phase 1
uses only `systemctl show` (read-only).

**Least privilege.** The service runs as `openvps` with no capabilities, `NoNewPrivileges`,
`ProtectSystem=strict` (writable: `/var/lib/openvps` only), `ProtectHome`, private `/tmp` and
devices, kernel and cgroup protections, `RestrictAddressFamilies`, a `@system-service` syscall
filter, and memory and task limits.

**Secrets in logs.** Logger and activity-log fields pass through a redactor (password, secret,
token, key, authorization, cookie, credential, PEM private keys). Request bodies are never logged.

**Input handling.** JSON-only bodies with a 32 KB cap, typed field validation, parameterised SQL
everywhere, static files confined to the web root, strict config validation.

**Supply chain.** Zero runtime npm dependencies on the server. Releases and the Node.js runtime
are verified with SHA-256 checksums. CI runs `npm audit` on the build tooling.

**Installer safety.** Preflight checks before any change, an explicit plan and confirmation,
refusal to overwrite an existing install, automatic rollback of a partial install, and no
changes to Nginx, PM2, system Node.js or firewall policy unless requested.

## Known limitations (planned)

- No multi-factor authentication yet (planned with team accounts).
- A single administrator role. Role-based access arrives with team accounts (Phase 6).
- Rate-limit counters are in memory and reset when the service restarts.
- The self-signed certificate triggers a browser warning. Use your own certificate or the
  Phase 3 certificate manager.

## Operator checklist

- [ ] Restrict the panel port to your IPs (provider firewall or ufw), or use an SSH tunnel.
- [ ] Use a long, unique passphrase for the administrator.
- [ ] Verify the certificate fingerprint on first connection, or install a trusted certificate.
- [ ] Keep Ubuntu updated (`unattended-upgrades`) and run `sudo openvps upgrade` regularly.
- [ ] Review `sudo openvps audit` or the Activity page for unexpected sign-in failures.
- [ ] Keep `/var/lib/openvps` backups off the server.
