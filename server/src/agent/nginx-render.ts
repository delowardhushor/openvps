/**
 * Renders the Nginx configuration for an OpenVPS site. Inputs are validated
 * SiteSpec values only (see sites-spec.ts), so nothing here can inject directives.
 */
import type { SiteSpec } from './sites-spec.ts';

export interface RenderEnv {
  /** Directory served at /.well-known/acme-challenge/ for Let's Encrypt HTTP-01. */
  acmeRoot: string;
  /** Listen on IPv6 too. */
  ipv6: boolean;
  /** nginx >= 1.25.1 uses `http2 on;` instead of `listen ... http2`. */
  http2Directive: boolean;
  /**
   * Enable HTTP/2. Before 1.25.1 the http2 flag belongs to the shared listen socket, so it
   * is left off when other sites listen on 443 without it (avoids "protocol options redefined").
   */
  http2?: boolean;
  /** Certificate files, when a certificate exists for this site. */
  cert: { fullchain: string; key: string } | null;
  /** Panel upstream for type "panel". */
  panel: { port: number; tls: boolean };
  version: string;
}

export const SHARED_FILE_CONTENT = `# Managed by OpenVPS. Shared definitions for OpenVPS sites. Do not edit.
map $http_upgrade $openvps_connection_upgrade {
    default upgrade;
    ''      close;
}
`;

function indent(lines: string[], n = 4): string {
  const pad = ' '.repeat(n);
  return lines.map((l) => (l ? pad + l : l)).join('\n');
}

/**
 * `inherited` repeats server-level add_header lines (HSTS) inside locations that set their
 * own headers: Nginx drops the server's add_header directives in any location that has one.
 */
function contentLocations(spec: SiteSpec, env: RenderEnv, inherited: string[] = []): string[] {
  const common = [
    `client_max_body_size ${spec.maxBodyMb}m;`,
    '',
    '# Never serve dotfiles such as .env or .git (except .well-known).',
    'location ~ /\\.(?!well-known/) {',
    '    deny all;',
    '    return 404;',
    '}',
  ];
  const proxyHeaders = (upstream: string, ws: boolean, extra: string[] = []) => [
    'location / {',
    `    proxy_pass ${upstream};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header X-Forwarded-Host $host;',
    ...(ws ? ['    proxy_set_header Upgrade $http_upgrade;', '    proxy_set_header Connection $openvps_connection_upgrade;'] : []),
    '    proxy_read_timeout 300s;',
    '    proxy_send_timeout 300s;',
    ...extra.map((e) => '    ' + e),
    '}',
  ];

  switch (spec.type) {
    case 'proxy':
      return [...common, '', ...proxyHeaders(`http://127.0.0.1:${spec.upstreamPort}`, true)];
    case 'panel': {
      const scheme = env.panel.tls ? 'https' : 'http';
      const extra = env.panel.tls ? ['proxy_ssl_verify off;  # the panel uses a self-signed certificate on localhost', 'proxy_ssl_server_name off;'] : [];
      return [...common, '', ...proxyHeaders(`${scheme}://127.0.0.1:${env.panel.port}`, false, extra)];
    }
    case 'static':
    case 'spa': {
      const fallback = spec.type === 'spa' ? '/index.html' : '=404';
      return [
        ...common,
        '',
        `root ${spec.root};`,
        'index index.html index.htm;',
        '# Refuse symlinks whose owner differs from the target (e.g. a link to /etc planted later).',
        'disable_symlinks if_not_owner;',
        '',
        ...(spec.type === 'spa'
          ? ['# Build tools fingerprint asset names (e.g. app.3f9a1c.js), so they can be cached for long.']
          : ['# Plain files keep their names when they change, so cache them briefly.']),
        'location ~* \\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$ {',
        '    try_files $uri =404;',
        `    add_header Cache-Control "public, max-age=${spec.type === 'spa' ? 2592000 : 3600}";`,
        ...inherited.map((h) => '    ' + h),
        '    access_log off;',
        '}',
        '',
        'location / {',
        `    try_files $uri $uri/ ${fallback};`,
        ...(spec.type === 'spa'
          ? ['    # index.html must not be cached so new deployments show up immediately.', '    add_header Cache-Control "no-cache";', ...inherited.map((h) => '    ' + h)]
          : []),
        '}',
      ];
    }
  }
}

export function renderSite(spec: SiteSpec, env: RenderEnv): string {
  const names = spec.domains.join(' ');
  const useHttps = spec.https && env.cert !== null;
  const acme = [
    '# Let\'s Encrypt HTTP-01 validation (OpenVPS).',
    'location ^~ /.well-known/acme-challenge/ {',
    `    root ${env.acmeRoot};`,
    '    default_type text/plain;',
    '    try_files $uri =404;',
    '}',
  ];
  const logs = [`access_log /var/log/nginx/openvps-${spec.name}.access.log;`, `error_log /var/log/nginx/openvps-${spec.name}.error.log;`];

  const httpListen = ['listen 80;', ...(env.ipv6 ? ['listen [::]:80;'] : [])];
  const httpBody = useHttps && spec.forceHttps ? [...acme, '', 'location / {', '    return 301 https://$host$request_uri;', '}'] : [...acme, '', ...contentLocations(spec, env)];

  const out: string[] = [
    `# Managed by OpenVPS ${env.version}. Changes made here will be overwritten.`,
    `# Site: ${spec.name} (${spec.type})`,
    '',
    'server {',
    indent([...httpListen, `server_name ${names};`, '', ...logs, '', ...httpBody]),
    '}',
  ];

  if (useHttps) {
    const h2 = env.http2 !== false;
    const tlsListen = env.http2Directive
      ? ['listen 443 ssl;', ...(env.ipv6 ? ['listen [::]:443 ssl;'] : []), ...(h2 ? ['http2 on;'] : [])]
      : [`listen 443 ssl${h2 ? ' http2' : ''};`, ...(env.ipv6 ? [`listen [::]:443 ssl${h2 ? ' http2' : ''};`] : [])];
    const hsts = spec.hsts ? ['add_header Strict-Transport-Security "max-age=31536000" always;'] : [];
    const tls = [
      `ssl_certificate ${env.cert!.fullchain};`,
      `ssl_certificate_key ${env.cert!.key};`,
      'ssl_protocols TLSv1.2 TLSv1.3;',
      'ssl_session_timeout 1d;',
      'ssl_session_cache shared:OpenVPS:10m;',
      'ssl_session_tickets off;',
      ...hsts,
    ];
    out.push(
      '',
      'server {',
      indent([...tlsListen, `server_name ${names};`, '', ...tls, '', ...logs, '', ...acme, '', ...contentLocations(spec, env, hsts)]),
      '}',
    );
  }
  return out.join('\n') + '\n';
}
