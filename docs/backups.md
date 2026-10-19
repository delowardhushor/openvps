# Backups

The **Backups** page copies your app folders and MongoDB databases on a schedule, keeps the
copies on this server and/or in S3-compatible cloud storage, deletes old ones for you, and walks
you through restoring.

**Keep a copy off the server.** Backups that only live on the machine they protect disappear
with it (disk failure, deleted VPS, ransomware). Add cloud storage and let each plan copy there.

## Before you start

The agent does the work, so run `sudo openvps provision` once (it also runs on upgrade). It
creates `/var/backups/openvps`, readable by root only. Then:

- **Folders** need nothing else (`tar` is part of Ubuntu).
- **MongoDB** needs `mongodump`/`mongorestore` (the
  [MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/installation/installation-linux/)).
  `sudo openvps provision` (also run by install and upgrade) installs what is missing from
  MongoDB's official apt repository, on Ubuntu 20.04/22.04/24.04 (amd64/arm64):
  - **No MongoDB on the server:** installs MongoDB Community 8.0 (7.0 on Ubuntu 20.04, which 8.0 does not support; `mongodb-org`: server, `mongosh`
    and the tools) and starts it. It listens on `127.0.0.1:27017` only and has **no users and no
    authentication** yet, so any local account can read it. Create an admin user and turn on
    `security.authorization` in `/etc/mongod.conf` before putting real data in it.
  - **MongoDB already installed** (any way): only `mongodb-database-tools` is added. Your server,
    its version and its configuration are not touched.
  - **CPU without AVX** (some old VMs; MongoDB 5+ needs it): only the tools are installed.
  - **Under about 2 GB of RAM:** only the tools are installed, because an idle MongoDB server
    uses roughly 150-300 MB. Set `OPENVPS_MONGODB_SERVER=1` to install the server anyway.
  - Don't want it? Run `sudo openvps provision --no-mongodb` (or set `OPENVPS_SKIP_MONGODB=1`)
    and install the tools yourself. If the install fails, provision prints the reason as a
    warning and carries on; folder backups are unaffected.
  The Backups page tells you if the tools are missing.
- **Cloud storage** needs an account with any S3-compatible provider and a private bucket.

To look at the data itself, see [Databases](databases.md).

## Cloud storage

**Backups → Add storage**, pick your provider, and fill in the endpoint, bucket and a key pair,
then **Test connection**. OpenVPS writes a tiny file, reads it back and deletes it.

| Provider | Endpoint | Region | Path-style |
|---|---|---|---|
| Amazon S3 | `https://s3.<region>.amazonaws.com` | the bucket's region | off |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | on |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | on |
| Wasabi | `https://s3.wasabisys.com` (or `s3.<region>.wasabisys.com`) | e.g. `us-east-1` | on |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | e.g. `nyc3` | off |
| MinIO / other | your server's URL (`http://` only on a private network) | `us-east-1` | on |

Create the key pair with access to that one bucket only (read, write, list and delete), so a
leaked key cannot touch anything else. The secret is stored encrypted and is never shown again;
leave it blank when editing to keep the stored one. Use the optional folder (e.g. `my-vps/`) when
several servers share a bucket.

## Make a plan

**Backups → New backup plan:**

1. **Folders** inside `/srv/apps` or `/var/www` (the **+ app** buttons add your registered apps).
   Names such as `node_modules` or `*.log` can be skipped; `node_modules` is skipped by default
   because `npm ci` rebuilds it.
2. **MongoDB**: a connection string such as
   `mongodb://user:password@localhost:27017/?authSource=admin`, and optionally the databases to
   include (default: everything the connection can see). The password is stored encrypted and
   passed to `mongodump` through a private temporary file, never on the command line.
3. **When**: every day, every week, every hour, or only when you click. Times are server time.
4. **Where**: this server, cloud storage, or both.
5. **Keep the newest N** backups (default 7), optionally also deleting anything older than N days.
   Old backups are deleted after each successful run, only ones named after this plan. The newest
   backup is never deleted.

Use **Back up now** on the plan page to try it. Backups run at low CPU priority and one at a time.

If the panel was off at the scheduled time, the backup runs once when it comes back. If a
destination is unreachable but another worked, the run shows **Partly done** with the reason.

## What a backup contains

Each run is one file named `<plan>-<UTC date>-<time>.ovbk.tar` plus a `.json` description:

```
nightly-20260118-031500.ovbk.tar       # tar of: manifest.json, files-<name>.tar.gz,
                                       #         mongodb-<name>[--<db>].archive.gz
nightly-20260118-031500.ovbk.tar.json  # the manifest + size + SHA-256 of the file above
```

On this server they are in `/var/backups/openvps/<plan>/`; in a bucket, under
`<folder>/<plan>/`. Each member is an ordinary `tar.gz` or `mongodump --archive --gzip`, so you
can always open them by hand without OpenVPS:

```bash
tar -xf nightly-20260118-031500.ovbk.tar -C /tmp/restore
tar -xzf /tmp/restore/files-shop.tar.gz -C /srv/apps/shop
mongorestore --gzip --archive=/tmp/restore/mongodb-main.archive.gz --uri "mongodb://..."
```

The description file is written last, so a backup without one was interrupted and is shown as
incomplete.

## Check a backup

**Check** recalculates the checksum of a backup on this server and confirms its contents are
listed. For cloud copies, **Check** compares the size and the checksum recorded at upload without
downloading; **Full check** downloads the backup and verifies every byte. A backup you have never
checked is a hope, not a backup: check one after the first run, and restore one now and then.

## Restore

**Restore…** next to a backup opens a guided restore:

1. It reads the backup and lists what is inside.
2. For each folder, choose **Into a separate folder** (the default: nothing is overwritten; the
   result shows the path under `/var/backups/openvps/.restores/` to copy from) or **Over the
   current folder**. The second shows how many items are already there and warns that files with
   the same names are replaced (files that exist only on the server are kept).
3. MongoDB is off by default. Tick it to restore into the live database, optionally dropping each
   collection first (otherwise documents that already exist are skipped).
4. Type the plan's name to confirm.

Before anything is written the agent re-checks the whole backup against its checksum, and each
item against its own, so a damaged backup restores nothing. Restoring is limited to the
configured folders even if a backup claims another path.

Tip: take a fresh backup first, so you can undo the restore.

### Restoring on a new server

1. Install OpenVPS, run `sudo openvps provision`, and add the **same cloud storage** (same
   bucket and folder).
2. Create a plan **with the same name** and the same MongoDB source(s), so the restore knows
   where to write.
3. Open the plan: the backups in the bucket are listed. Restore from there.

OpenVPS's own settings (accounts, sites, apps, plans) are not in these backups; use
`sudo openvps backup-db` for the panel database, and keep `secret.key` with it (see
[recovery](recovery.md#back-up-and-restore-the-database)). App code, certificates and Nginx
configuration can be rebuilt or reissued.

## Configuration

See [configuration](configuration.md): `backups.dir`, `backups.fileRoots`, `backups.scheduler`
and the tool paths. After changing them run `sudo systemctl restart openvps-agent openvps`.

Allowing more folders is a deliberate choice: add them to `backups.fileRoots`. The agent's
systemd sandbox makes `/etc` read-only, so restoring into `/etc/...` needs a matching
`ReadWritePaths` entry in `openvps-agent.service`.

## Security notes

- Backups contain your data. Local copies are root-only (`0700`). Treat the bucket as private and
  trusted: anyone who can write to it can plant a backup you might later restore.
- Backups are **not encrypted** by OpenVPS; rely on your provider's encryption at rest, or encrypt
  buckets and keys carefully. (Client-side encryption is on the roadmap.)
- Storage keys and MongoDB connection strings are sealed in the panel database and sent to the
  agent only for the duration of a task. They never appear in the activity log, the API or logs.
- Every action (plan changes, runs, restores, deletes) is in the activity log.

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `mongodump is not installed` | Run `sudo openvps provision` (installs MongoDB / the Database Tools), or install the tools by hand |
| `AccessDenied` / `SignatureDoesNotMatch` | Wrong key, secret or region, or the key lacks permission; **Test connection** |
| `NoSuchBucket` | The bucket name or endpoint is wrong (or path-style is set the wrong way) |
| `Another backup task is already running` | The agent runs one backup task at a time; try again shortly |
| `The agent restarted while this was running` | The agent (or server) restarted mid-run; run it again |
| `... does not match its checksum` | The file is damaged or changed; restore an older backup |
| Backups are slow or use a lot of disk | Skip big folders (caches, uploads you can rebuild); check free space on the page |
