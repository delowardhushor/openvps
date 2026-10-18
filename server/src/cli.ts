import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, ConfigError } from './config.ts';
import { currentSchemaVersion, dbPath, migrate, openDb } from './db/index.ts';
import { migrations } from './db/migrations.ts';
import { Users, USERNAME } from './auth/users.ts';
import { Sessions } from './auth/sessions.ts';
import { Audit } from './audit.ts';
import { checkPasswordPolicy, hashPassword } from './auth/password.ts';
import { hasSetupToken, issueSetupToken, setupTokenPath } from './auth/setup.ts';
import { VERSION } from './version.ts';

/**
 * Local administration CLI (installed as /usr/local/bin/openvps).
 * It acts directly on the database, so it is the recovery path when the web
 * login is unavailable (forgotten password, locked account). Requires shell
 * access to the server, which is the trust boundary for these operations.
 */
const HELP = `OpenVPS ${VERSION} — local administration

Usage: openvps <command> [options]

Commands:
  status                    Show version, config, database and account summary
  version                   Print the version
  setup-token               Show the first-run setup token (creates one if needed)
  users                     List administrator accounts
  reset-password <user>     Set a new password (prompts; or --password-stdin) and sign out the user
  unlock <user>             Clear a temporary login lockout
  revoke-sessions [user]    Sign out one user, or everyone when no user is given
  migrate                   Apply pending database migrations
  check-config              Validate the configuration file
  audit [--limit N]         Print recent audit log entries
  backup-db <file>          Write a consistent snapshot of the database to <file>

Installation management (run as root):
  upgrade [--version X]     Upgrade to the latest or a specific release, with automatic rollback
  uninstall [--purge]       Remove OpenVPS (keeps config and data unless --purge)
  provision                 Set up or repair application management (agent, apps user, PM2)

Service control is done with systemd: sudo systemctl status|restart openvps
`;

function fail(msg: string, code = 1): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) fail('No terminal available. Use --password-stdin.');
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(VERSION + '\n');
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fail(`Configuration error: ${e.message}`, 78);
    throw e;
  }
  if (cmd === 'check-config') {
    process.stdout.write(`Configuration OK (${config.source ?? 'defaults'})\n`);
    return;
  }

  const db = openDb(config.dataDir);
  const latest = migrations.at(-1)!.version;
  if (cmd === 'migrate') {
    const r = migrate(db);
    process.stdout.write(r.applied.length ? `Migrated schema ${r.from} -> ${r.to}\n` : `Schema is up to date (version ${r.to})\n`);
    return;
  }
  // All other commands need the current schema.
  migrate(db);

  const users = new Users(db);
  const audit = new Audit(db);
  const sessions = new Sessions(db, { idleMs: config.session.idleMinutes * 60_000, absoluteMs: config.session.absoluteHours * 3_600_000 });
  const findUser = (name: string | undefined) => {
    if (!name) fail('Username required.');
    const u = users.byUsername(name);
    if (!u) fail(`No such user: ${name}`);
    return u;
  };

  switch (cmd) {
    case 'status': {
      const n = users.count();
      process.stdout.write(
        [
          `OpenVPS version   ${VERSION}`,
          `Config            ${config.source ?? '(defaults)'}`,
          `Data directory    ${config.dataDir}`,
          `Database          ${dbPath(config.dataDir)} (schema ${currentSchemaVersion(db)}/${latest})`,
          `Listen            ${config.tls.enabled ? 'https' : 'http'}://${config.listen.host}:${config.listen.port}`,
          `Administrators    ${n}${n === 0 ? '  (setup not completed — run: openvps setup-token)' : ''}`,
          '',
        ].join('\n'),
      );
      return;
    }
    case 'setup-token': {
      if (users.count() > 0) fail('Setup is already complete. Use "openvps reset-password <user>" to recover access.');
      const file = setupTokenPath(config.dataDir);
      let token: string | null = null;
      if (!rest.includes('--new') && hasSetupToken(db) && existsSync(file)) token = readFileSync(file, 'utf8').trim();
      if (!token) token = issueSetupToken(db, config.dataDir);
      process.stdout.write(token + '\n');
      return;
    }
    case 'users': {
      for (const u of users.all()) {
        const locked = users.isLocked(u) ? '  [locked]' : '';
        const last = u.last_login_at ? new Date(u.last_login_at).toISOString() : 'never';
        process.stdout.write(`${u.username}\t${u.role}\tlast login: ${last}${locked}\n`);
      }
      if (users.count() === 0) process.stdout.write('No administrators yet.\n');
      return;
    }
    case 'reset-password': {
      const name = rest.find((a) => !a.startsWith('--'));
      const u = findUser(name);
      let pw: string;
      if (rest.includes('--password-stdin')) {
        pw = await readStdin();
      } else {
        pw = await promptHidden('New password: ');
        const again = await promptHidden('Repeat password: ');
        if (pw !== again) fail('Passwords do not match.');
      }
      const policy = checkPasswordPolicy(pw, u.username, config.auth.minPasswordLength);
      if (!policy.ok) fail(policy.problems.join('\n'));
      users.setPassword(u.id, await hashPassword(pw));
      const n = sessions.revokeAllForUser(u.id);
      audit.record({ actor: 'cli', action: 'cli.password_reset', target: u.username, outcome: 'success', details: { revokedCount: n } });
      process.stdout.write(`Password updated for ${u.username}; ${n} session(s) signed out.\n`);
      return;
    }
    case 'unlock': {
      const u = findUser(rest[0]);
      users.unlock(u.id);
      audit.record({ actor: 'cli', action: 'cli.unlock', target: u.username, outcome: 'success' });
      process.stdout.write(`Unlocked ${u.username}.\n`);
      return;
    }
    case 'revoke-sessions': {
      if (rest[0]) {
        const u = findUser(rest[0]);
        const n = sessions.revokeAllForUser(u.id);
        audit.record({ actor: 'cli', action: 'cli.revoke_sessions', target: u.username, outcome: 'success', details: { revokedCount: n } });
        process.stdout.write(`Signed out ${n} session(s) for ${u.username}.\n`);
      } else {
        const n = sessions.revokeAll();
        audit.record({ actor: 'cli', action: 'cli.revoke_sessions', outcome: 'success', details: { revokedCount: n } });
        process.stdout.write(`Signed out ${n} session(s).\n`);
      }
      return;
    }
    case 'create-admin': {
      // Non-interactive provisioning (automation). Only allowed before setup.
      if (users.count() > 0) fail('An administrator already exists.');
      const name = rest.find((a) => !a.startsWith('--'));
      if (!name || !USERNAME.test(name)) fail('Valid username required.');
      const pw = await readStdin();
      const policy = checkPasswordPolicy(pw, name, config.auth.minPasswordLength);
      if (!policy.ok) fail(policy.problems.join('\n'));
      users.create(name, await hashPassword(pw));
      audit.record({ actor: 'cli', action: 'cli.admin_create', target: name, outcome: 'success' });
      process.stdout.write(`Created administrator ${name}.\n`);
      return;
    }
    case 'backup-db': {
      // Consistent online snapshot (safe while the service is running).
      const target = rest[0];
      if (!target || !target.startsWith('/')) fail('Usage: openvps backup-db /absolute/path/backup.db');
      if (existsSync(target)) fail(`Refusing to overwrite ${target}`);
      db.prepare('VACUUM INTO ?').run(target);
      process.stdout.write(`Database backed up to ${target}\n`);
      return;
    }
    case 'audit': {
      const i = rest.indexOf('--limit');
      const limit = i >= 0 ? Number(rest[i + 1]) : 30;
      for (const e of audit.list({ limit }).reverse()) {
        process.stdout.write(
          `${new Date(e.ts).toISOString()}  ${e.outcome.padEnd(7)}  ${e.action.padEnd(24)}  ${e.actor ?? '-'}  ${e.ip ?? '-'}  ${e.target ?? ''}${e.details ? '  ' + JSON.stringify(e.details) : ''}\n`,
        );
      }
      return;
    }
    default:
      fail(`Unknown command: ${cmd}\n\n${HELP}`, 64);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => fail(`Error: ${(e as Error).message}`));
