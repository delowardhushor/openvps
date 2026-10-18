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

**No command execution API.** The panel can start external programs only through
`system/exec.ts`: a hard-coded allowlist of absolute paths, `execFile` with no shell, a
restricted argument character set, a minimal environment, timeouts and output caps. It uses
only `systemctl show` (read-only).

**The agent (v0.2).** All privileged work goes through `openvps-agent`, a root service that:

- listens on a Unix socket in a `root:openvps 0750` directory, so only root and the panel can connect;
- accepts exactly six actions (`agent.info`, `pm2.list`, `pm2.control`, `pm2.logs`, `app.apply`,
  `app.remove`), each with strictly validated parameters. Unknown actions and fields are refused;
- treats **root's existing PM2 apps** as control-only: start, stop, restart and reload of processes
  that already exist. It never creates root processes or changes their commands or environment;
- runs **apps added in OpenVPS** as the unprivileged `ovapps` user (via `runuser`, under
  `NoNewPrivileges` and `ProtectSystem=full`). App directories must resolve (after symlinks)
  inside `apps.allowedRoots`, and entry files inside the app directory;
- writes app definitions to a root-owned directory, so `ovapps` cannot plant symlinks the
  agent would write through;
- opens log files with `O_NOFOLLOW` and requires them to be regular files owned by the
  expected user. An app cannot make the agent read `/etc/shadow` by pointing its log there;
- never invokes the `pm2` CLI while that PM2's daemon is down, because doing so would start a
  daemon inside the agent's service;
- strips PM2's environment data (which contains apps' secrets) from everything it returns;
- serialises state-changing operations, and logs every action without env values.

**App secrets.** Environment variables are sealed with AES-256-GCM (random IV per value, key in
`/var/lib/openvps/secret.key`, `0600`), write-only in the API and UI, and only their names appear
in the activity log. They are decrypted only to hand to the agent when an app starts.

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

**Sites and certificates (v0.3).** Site settings are validated twice (panel and agent) against
strict patterns: domains are plain hostnames (no wildcards, IPs, spaces or `;`), names are
`[a-z0-9-]`, static folders must be real directories under `sites.staticRoots` (checked with the
symlinks resolved), and Nginx serves them with `disable_symlinks if_not_owner`, so a symlink
planted later by the apps user cannot expose files such as `/etc`. Config files are rendered from these values only, never from free text. Every
change runs `nginx -t` first and is reverted exactly if Nginx rejects it, and nothing is changed
while the existing configuration is broken. OpenVPS writes only `openvps-*` files and refuses
domains that hand-made sites already serve. Generated sites deny dotfiles (`.env`, `.git`).
Certbot runs with a fixed argument list; the panel never passes command strings. When the panel
is served through its own Nginx site, it trusts `X-Real-IP` only from loopback connections.

**Backups (v0.4).** Plans and restore requests are validated twice. Folders must resolve (symlinks
included) to a real directory inside `backups.fileRoots`, and a restore re-checks the recorded
path, so a backup cannot write outside the roots. Archives are made and extracted with fixed
`tar` arguments, tar exclusions are limited to simple name patterns, and every artifact and every
member is verified against its SHA-256 before anything is restored. MongoDB connection strings and
storage keys are sealed at rest, passed to the agent per task, given to `mongodump`/`mongorestore`
through a private `0600` file (never argv), and scrubbed from errors, logs and the activity log.
Storage endpoints must be `https://` unless they are on a private network. Local backups are
`root`-only. A restore needs the plan name typed and shows overwrite warnings first.

## Known limitations (planned)

- Backups are not encrypted by OpenVPS (use provider-side encryption); the storage bucket is trusted
  to hold only backups made by this server.

- No multi-factor authentication yet (planned with team accounts).
- A single administrator role. Role-based access arrives with team accounts (Phase 6).
- Anyone with panel access can run code as `ovapps` by adding an app; that is the purpose of a
  deployment panel. They cannot run code as root through the panel.
- PM2 keeps a running app's environment in `ovapps`' PM2 files; the encryption protects
  OpenVPS's copy, not PM2's.
- Rate-limit counters are in memory and reset when the service restarts.
- The self-signed certificate triggers a browser warning. Serve the panel on a domain from
  **Sites & domains** to get a trusted certificate.

## Operator checklist

- [ ] Restrict the panel port to your IPs (provider firewall or ufw), or use an SSH tunnel.
      Once the panel has its own HTTPS domain, close the panel port entirely.
- [ ] Use a long, unique passphrase for the administrator.
- [ ] Verify the certificate fingerprint on first connection, or install a trusted certificate.
- [ ] Keep Ubuntu updated (`unattended-upgrades`) and run `sudo openvps upgrade` regularly.
- [ ] Review `sudo openvps audit` or the Activity page for unexpected sign-in failures.
- [ ] Keep `/var/lib/openvps` backups off the server.
