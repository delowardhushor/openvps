# Applications

OpenVPS manages Node.js applications with [PM2](https://pm2.keymetrics.io/). The
**Applications** page shows two kinds:

| | Existing PM2 apps (root) | Managed by OpenVPS |
|---|---|---|
| Where they come from | Already running under root's PM2 on your server | Added in the panel |
| Runs as | root (unchanged) | the unprivileged user `ovapps` |
| Start / stop / restart / reload | ✅ | ✅ |
| Logs, CPU, memory, restarts | ✅ | ✅ |
| Change command, directory, env vars | ❌ (OpenVPS never edits root's config) | ✅ |
| Create / delete | ❌ | ✅ |

OpenVPS never creates new root processes. If the panel were ever compromised, it could
not be used to run a new program as root.

## Before you start

Run this once on the server if you upgraded from v0.1, or if the Applications page says
the agent is not running:

```bash
sudo openvps provision
```

It creates the `ovapps` user and `/srv/apps`, installs OpenVPS's bundled PM2 for that
user, finds the PM2 root already uses, and starts two services:

- `openvps-apps`: PM2 for `ovapps`, which starts your apps at boot
- `openvps-agent`: the small root helper the panel talks to

It is safe to run again at any time.

## Add an application

1. Put the code in a folder under `/srv/apps`, owned by `ovapps`:

   ```bash
   sudo -u ovapps git clone https://github.com/you/my-api.git /srv/apps/my-api
   cd /srv/apps/my-api
   sudo -u ovapps npm ci
   sudo -u ovapps npm run build      # if your app has a build step
   ```

   For a private repository, clone it as yourself and then `sudo chown -R ovapps:ovapps /srv/apps/my-api`.
   Git deployments from the panel, with deploy keys, arrive in v0.3.

2. In the panel: **Applications → New application**.
   - **Name**: also the PM2 process name.
   - **Directory**: `/srv/apps/my-api`.
   - **How to start it**: an **npm script** (`npm run start`) or an **entry file** (`dist/server.js`).
   - **Node.js**: choose from the versions installed on the server. OpenVPS lists
     `/usr/bin/node`, `/usr/local/bin/node` and its own runtime.
   - **Environment variables**: type them in or **Paste .env**.
   - **Advanced**: arguments, cluster mode with several instances, and a memory limit that
     restarts the app when it uses too much.

3. **Create application** starts it. Logs are on the app's page.

## Environment variables

- Stored **encrypted** (AES-256-GCM). The key is in `/var/lib/openvps/secret.key`, separate
  from the database.
- **Write-only** in the panel: after saving, you can replace or remove a value but not read it.
- Never written to OpenVPS logs or the activity log (only variable names are recorded).
- PM2 itself keeps the running app's environment in its own files, readable by `ovapps`.
- `PORT`, `DATABASE_URL` and so on are fine. `PM2_*`, `HOME` and `USER` are reserved.
- `NODE_ENV` defaults to `production`.

**Save and restart** applies changes immediately. **Save only** applies them on the next restart.

## Cluster mode

With an entry file you can run several instances behind one port. **Reload** then restarts
them one at a time with no downtime. PM2 runs cluster workers on the Node.js that runs
PM2 itself (OpenVPS's runtime), so the form selects that runtime for you.

## Your existing root apps

OpenVPS finds root's PM2 automatically, whether it was installed with npm or through nvm in
root's shell profile. It lists those processes and lets you start, stop, restart, reload and
read logs.

- It does **not** run `pm2 save` for root. After you stop an app in the panel, it comes
  back at reboot if root's saved process list says it was running, exactly as before.
  Run `sudo pm2 save` yourself if you want the current state saved.
- To make these apps read-only in the panel, set `"agent": { "manageRootPm2": false }` in
  `/etc/openvps/config.json` and run `sudo systemctl restart openvps-agent`.
- To move an app to OpenVPS management (runs as `ovapps`, with editable settings and
  encrypted env), copy its code to `/srv/apps/<name>`, add it in the panel, check it works,
  then remove it from root's PM2 with `sudo pm2 delete <name> && sudo pm2 save`.

## Ports and domains

Apps listen on their own ports, such as 3000. To serve them on a domain with HTTPS, keep
using your Nginx configuration for now; site and certificate management arrive in Phase 3.
Don't open app ports in the firewall when Nginx proxies to them.

## Troubleshooting

| Problem | What to do |
|---|---|
| "The OpenVPS agent is not running" | `sudo openvps provision`, then `journalctl -u openvps-agent -n 50` |
| "Application directories must be inside /srv/apps" | Move the code under `/srv/apps/<name>` |
| "Entry file … was not found" | The path is relative to the directory, e.g. `dist/server.js` |
| App shows **Errored** | Open it and read the **Errors** log tab |
| Permission errors in the logs | `sudo chown -R ovapps:ovapps /srv/apps/<name>` |
| Root PM2 shows as unavailable | Root's PM2 daemon isn't running: `sudo pm2 resurrect`. OpenVPS never starts root's daemon itself |
| "The PM2 daemon is not running" for OpenVPS apps | `sudo systemctl restart openvps-apps` |

Useful commands:

```bash
sudo systemctl status openvps-agent openvps-apps
sudo -u ovapps env PM2_HOME=/var/lib/ovapps/.pm2 /opt/openvps/node/bin/node /opt/openvps/pm2/node_modules/pm2/bin/pm2 list
```
