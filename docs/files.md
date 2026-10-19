# Files

The **Files** page is a file manager for the folders your apps and websites live in
(`/srv/apps` and `/var/www` by default). Browse, upload, download, rename, move, delete and edit
small text files from the browser, without SFTP.

## Uploading

- **Drag and drop** files or whole folders anywhere on the page. Drop onto a folder row to upload
  into that folder. Folder structure is kept (missing folders are created).
- Or use **Upload files** / **Upload folder**.
- Two files upload at a time, with a progress bar each. **Cancel all** stops the queue; a failed
  or cancelled file can be retried from the list. Closing the tab during an upload asks first.
- Files are streamed to disk, never held in memory, so large files are fine on a small server.
  The limit is `files.maxUploadMb` (default 2048 MB). The server also checks that the disk has
  room (the size of the file plus a reserve) before it starts.
- A file is written under a temporary name and moved into place when complete, so a visitor or
  your app never sees a half-written file, and a cancelled or failed upload leaves nothing behind.
- If a name already exists you are asked whether to replace it. Nothing is replaced silently.
- New files get mode `0644` and folders `0755`; replacing a file keeps its permissions.

## Other actions

| Action | Notes |
|---|---|
| **New folder / New file** | One level at a time. A new file opens in the editor. |
| **Rename** | Also moves: it will not replace an existing name. Moves stay inside the same managed folder. |
| **Delete** | Permanent, asks first. Deleting a folder deletes everything inside it. Select several rows to delete together. |
| **Download** | Always sent as a download (never displayed by the browser), so an uploaded HTML file cannot run in the panel's origin. |
| **Edit** | UTF-8 text files up to `files.maxEditKb` (default 1024 KB). Binary or non-UTF-8 files are not opened. Saving checks the file did not change meanwhile and offers to reload or overwrite. Ctrl+S saves. |

Links (symlinks) are shown as links. A link to a folder inside the managed folder can be opened;
a link that points outside it is shown but cannot be followed, and links are never followed when
deleting or renaming (the link itself is changed).

## Who the file manager acts as

Every operation runs in a small helper process that the agent starts **as the user who owns the
managed folder**: `ovapps` for `/srv/apps`, `root` for a root-owned `/var/www`. So:

- Files you upload to `/srv/apps` belong to `ovapps`, exactly like the files your apps create.
- The file manager can only do what that user may do. It cannot write into a root-owned folder or
  read a root-only file inside `/srv/apps`; the error says so. As on the command line, the owner of
  a folder can still replace or delete files inside it, whoever owns them.
- The kernel enforces this, so a link planted by an app cannot be used to read or write files the
  app's own user could not reach.

Each operation starts one short Node process (about 45 MB, a few hundredths of a second of CPU)
that exits as soon as it is done, and at most three run at once. When nobody uses the Files page,
nothing runs.

## Settings

In `/etc/openvps/config.json` (see [configuration](configuration.md)):

| Key | Default | Description |
|---|---|---|
| `files.roots` | `["/srv/apps","/var/www"]` | Folders the file manager may open. System and OpenVPS data directories are refused. |
| `files.maxUploadMb` | `2048` | Largest single upload. |
| `files.maxEditKb` | `1024` | Largest file opened in the editor. |

Then restart both services: `sudo systemctl restart openvps openvps-agent`. Both read the list
and both enforce it.

## Using it behind a domain

If the panel is served through its own Nginx site (a "panel" site in **Sites & domains**), OpenVPS
adds a `/api/files/` location that has no upload size limit, no request or response buffering and
one-hour timeouts, so large files stream straight through. After upgrading from an older version,
open the panel site and save it once to regenerate its Nginx configuration.

## Security notes

- Paths are validated three times (panel, agent, helper): no `..`, no empty segments, no control
  characters, bounded length. The agent compares the folder with its own configured list.
- Every change is in the **Activity log** (`file.upload`, `file.save`, `file.move`, `file.delete`,
  `file.mkdir`, `file.download`) with the path and size, never the contents.
- Anyone who can sign in to the panel can change the files of every app on the server, which is
  also true of the Applications page; there is one administrator role.
- Uploading an executable does not run it. Apps still run only when started through PM2.

## Limits (v1)

- No zip/unzip, search, copy, permission or owner changes, or resumable uploads.
- Files appear and disappear as they are changed by other processes; use **Refresh**.
- A folder shows at most 5000 entries.
- A leftover `.openvps-upload-*` file can remain only if the agent was killed in the middle of an
  upload; it is visible in the list and can be deleted.
