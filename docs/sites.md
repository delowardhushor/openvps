# Sites, domains and SSL certificates

The **Sites & domains** page puts your domains in front of what runs on the server, through
Nginx, with free HTTPS certificates from Let's Encrypt. A site can serve one of four things:

| Type | Use it for | What Nginx does |
|---|---|---|
| **App** | A Node.js app (or anything listening on a local port) | Forwards requests to `http://127.0.0.1:<port>`, including WebSockets |
| **Single-page app** | A React, Vue, Angular or Vite build, e.g. an admin panel | Serves the folder; unknown paths load `index.html` so client-side routes work |
| **Static website** | Plain HTML, CSS and JavaScript files | Serves the folder as it is; unknown paths are 404 |
| **OpenVPS panel** | This panel, on a real domain with a trusted certificate | Forwards to the panel on its port |

## Before you start

You need Nginx and Certbot on the server (Ubuntu's packages are fine), and the OpenVPS agent:

```bash
sudo apt install nginx certbot
sudo openvps provision
```

`provision` is safe to run again; it runs automatically when you upgrade.

For each domain, add a DNS **A record** pointing to the server's public IP address (and an
**AAAA** record if the server has IPv6) at your domain provider. Port **80** must be open
in your firewall for Let's Encrypt to verify the domain, and **443** for HTTPS:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## Add a site

1. **Sites & domains → New site**, then pick what it serves.
2. Enter the domains, one per line. The first is the main one; add `www.` too if you use it.
3. Depending on the type:
   - **App**: the port the app listens on (its `PORT`). OpenVPS suggests the ports of your
     apps. Keep that port closed in the firewall: Nginx connects to it locally.
   - **Single-page app / Static website**: the folder with the built files (the one
     containing `index.html`). It must be inside `/srv/apps` or `/var/www`. For example,
     build on your computer and copy it up:

     ```bash
     npm run build
     rsync -a --delete dist/ root@your-server:/srv/apps/admin/dist/
     ```

     Nginx runs as `www-data`, so the folder must be readable by others (the default for
     files you copy as root). OpenVPS warns you if it isn't.
4. Leave **HTTPS** on and click **Create site and enable HTTPS**.

OpenVPS then:

1. writes `/etc/nginx/sites-available/openvps-<name>.conf` and links it into `sites-enabled`;
2. runs `nginx -t` and reloads Nginx (if the test fails, the change is undone exactly);
3. checks that each domain resolves and reaches this server on port 80, so a typo or a
   DNS record that hasn't propagated doesn't use up Let's Encrypt's
   [failed-validation limit](https://letsencrypt.org/docs/rate-limits/);
4. asks Let's Encrypt for a certificate with `certbot certonly --webroot`;
5. switches the site to HTTPS and redirects HTTP to it.

If the certificate step fails, the site still works over plain HTTP. The page shows what
went wrong (usually DNS); fix it and click **Get certificate**.

### Updating a static site or SPA

Copy the new build into the same folder. There is nothing to restart: `index.html` is sent
with `Cache-Control: no-cache`, so visitors get the new version on their next visit, while
fingerprinted assets (`app.3f9a1c.js`) are cached for 30 days. For a plain static website,
assets are cached for one hour.

Git deployments that build the site for you are coming in v0.4.

## The panel on its own domain

Create a site of type **OpenVPS panel** with a domain like `panel.example.com`. When HTTPS
works there, you can close the panel's port (7443) in your firewall and use only the domain:

```bash
sudo ufw delete allow 7443/tcp
```

Only one site can be the panel. The panel trusts the client address Nginx passes in
`X-Real-IP` only for connections from the server itself, so rate limits and the activity
log keep seeing real visitors' addresses.

## Certificates and renewal

**SSL certificates** lists every certificate on the server: the ones OpenVPS requested, ones
you created with Certbot yourself, and any other certificate an Nginx site uses, with the days
left and which sites use it. The dashboard warns when one has fewer than 21 days left.

Certificates are renewed by Certbot's own timer (`certbot.timer`, installed with the
`certbot` package), which renews 30 days before expiry and then runs `systemctl reload nginx`.
OpenVPS doesn't need to be running for renewals to happen. Set an email under **SSL
certificates** so Let's Encrypt can warn you if a renewal ever fails.

OpenVPS's certificates are named `openvps-<site>` in Certbot (`sudo certbot certificates`).

## Existing Nginx sites

Sites you configured by hand are listed as **read-only**: OpenVPS shows their domains,
targets and certificates but never edits, moves or deletes them. OpenVPS also refuses to
create a site for a domain an existing site already serves, so two configurations never
fight over the same name.

If Nginx's configuration has an error (`sudo nginx -t` fails), OpenVPS won't change
anything until it's fixed.

## What OpenVPS writes

| Path | Contents |
|---|---|
| `/etc/nginx/sites-available/openvps-<name>.conf` | One file per site (linked from `sites-enabled`) |
| `/etc/nginx/sites-available/openvps-00-shared.conf` | A shared WebSocket `map` used by app sites |
| `/var/lib/openvps-agent/acme/` | Let's Encrypt challenge files (served at `/.well-known/acme-challenge/`) |
| `/etc/letsencrypt/live/openvps-<name>/` | Certificates, managed by Certbot |
| `/var/log/nginx/openvps-<name>.*.log` | Per-site access and error logs |

On servers without `sites-available`, files go to `/etc/nginx/conf.d/` instead. Generated
files start with `# Managed by OpenVPS`; changes made there by hand are overwritten the next
time the site is saved. The **Nginx config** tab of a site shows the file.

Deleting a site removes its Nginx file (and, if you tick the box, its certificate). Your
files in `/srv/apps` are never touched. Uninstalling OpenVPS keeps your sites running; only
the panel's own domain is removed.

## Troubleshooting

| Message | What to do |
|---|---|
| *has no DNS record yet* | Add the A record; wait a few minutes; **Check DNS and port 80** |
| *resolves to …, but this server did not answer* | The record points elsewhere, or port 80 is closed (`sudo ufw allow 80/tcp`, and your provider's firewall) |
| *is already served by /etc/nginx/…* | That domain is in a hand-made site. Remove it there first |
| *Nginx's configuration has an error* | Run `sudo nginx -t` and fix the file it names |
| *too many certificates / failed authorizations* | Let's Encrypt rate limit: wait (usually an hour) and retry |
| 403 on a static site | Make the folder readable: `sudo chmod -R o+rX /srv/apps/<name>` |
| 502 on an app site | The app isn't running or listens on a different port |

Certbot's full log is in `/var/log/letsencrypt/letsencrypt.log`.
