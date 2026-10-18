import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.ts';
import { bootstrap } from './bootstrap.ts';
import { createApp } from './app.ts';
import { issueSetupToken, hasSetupToken, setupTokenPath } from './auth/setup.ts';
import { createLogger } from './logger.ts';
import { VERSION } from './version.ts';

const MIN_NODE = [22, 13];

function checkNode(): void {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0]! || (maj === MIN_NODE[0] && min < MIN_NODE[1]!)) {
    process.stderr.write(`OpenVPS requires Node.js >= ${MIN_NODE.join('.')} (found ${process.versions.node}).\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkNode();
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${e.message}\n`);
      process.exit(78); // EX_CONFIG; systemd will not hot-loop thanks to StartLimit settings
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  log.info('starting OpenVPS', { version: VERSION, node: process.versions.node, config: config.source ?? '(defaults)', dev: config.dev });

  const app = await bootstrap(config, { log });
  if (!app.host.supported) log.warn('unsupported platform', { note: app.host.supportNote });

  if (app.users.count() === 0) {
    if (!hasSetupToken(app.db) || config.dev) {
      const token = issueSetupToken(app.db, config.dataDir);
      if (config.dev) log.info('development setup token', { setupCode: token });
    }
    log.info('no administrator yet: complete setup in the browser', { file: setupTokenPath(config.dataDir), hint: 'sudo openvps setup-token' });
  }

  app.metrics.start();
  app.backups.start({ scheduler: config.backups.scheduler });
  const maintenance = () => {
    try {
      const s = app.sessions.pruneExpired();
      const a = app.audit.prune(config.audit.retentionDays);
      if (s || a) log.debug('maintenance', { expiredSessions: s, prunedAudit: a });
    } catch (e) {
      log.error('maintenance failed', { error: e as Error });
    }
  };
  maintenance();
  setInterval(maintenance, 60 * 60_000).unref();

  const handler = createApp(app);
  const listener = (req: Parameters<typeof handler>[0], res: Parameters<typeof handler>[1]) => void handler(req, res);

  let server: Server;
  if (config.tls.enabled) {
    server = createHttpsServer(
      { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: 'TLSv1.2' },
      listener,
    );
  } else {
    server = createHttpServer(listener);
    if (!config.dev && config.listen.host !== '127.0.0.1' && config.listen.host !== '::1' && !config.trustProxy) {
      log.warn('TLS is disabled and the panel listens on a public interface; credentials would travel in clear text');
    }
  }
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  server.on('error', (e) => {
    log.error('server error', { error: e });
    process.exit(1);
  });
  server.listen(config.listen.port, config.listen.host, () => {
    const scheme = config.tls.enabled ? 'https' : 'http';
    log.info('listening', { url: `${scheme}://${config.listen.host}:${config.listen.port}` });
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    app.metrics.stop();
    app.backups.stop();
    server.close(() => {
      app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
