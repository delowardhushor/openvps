# Contributing to OpenVPS

Thanks for helping! This guide gets you from clone to pull request.

## Ground rules

- Be respectful and constructive. We follow the
  [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
- Discuss larger changes in an issue first, especially new modules, new
  dependencies or anything that runs with elevated privileges.
- Report security problems privately (see [SECURITY.md](SECURITY.md)).

## Development setup

You need Node.js **22.13+** (24 LTS recommended) and npm. Development works on Linux
and macOS; on macOS some metrics (network, swap) show as unavailable.

```bash
git clone https://github.com/delowardhushor/openvps.git
cd openvps
npm install
npm run dev:server     # API on http://127.0.0.1:7800, data in server/.data
npm run dev:web        # UI on http://localhost:5173 (proxies /api to the server)
```

The dev server prints a setup token in its log, and also writes it to `server/.data/setup-token`.

More detail: [docs/development.md](docs/development.md).

## Checks to run before a pull request

```bash
npm run typecheck
npm test
npm run build
bash -n scripts/*.sh      # and shellcheck scripts/*.sh if installed
```

CI runs the same checks on every pull request.

## Coding standards

- **TypeScript, strict mode.** Server code uses only syntax that Node can strip
  (`erasableSyntaxOnly`): no `enum`, no parameter properties, no namespaces.
- **No new runtime dependencies in `server/`** without discussion. The server
  deliberately uses only Node.js built-ins to keep the supply-chain surface small.
- **Never run a shell.** External programs go through `server/src/system/exec.ts`
  (allowlisted absolute paths, `execFile`, validated arguments, timeouts).
- **Validate every input** at the API boundary and return errors through `HttpError`.
- **Audit sensitive actions** with `app.audit.record(...)`. Never put secrets in
  logs or audit details. The redactor is a safety net, not a licence.
- **Database changes** go in a new migration in `server/src/db/migrations.ts`.
  Never edit a migration that has shipped.
- **Tests** for any new behaviour: unit tests for pure logic, API tests through
  `test/helpers.ts` for endpoints.
- Formatting: 2 spaces, single quotes, semicolons, ~120-column lines (see `.editorconfig`).

## Commits and pull requests

- Use clear, imperative commit messages ("Add disk usage alerts"). Conventional
  Commit prefixes (`feat:`, `fix:`, `docs:`) are welcome but not required.
- Keep pull requests focused. Fill in the template, including how you tested.
- Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
- Update docs when behaviour or configuration changes.

## Releasing (maintainers)

1. Bump `version` in `package.json`, `server/package.json` and `web/package.json`.
2. Move the **Unreleased** changelog entries under the new version.
3. Tag `vX.Y.Z` and push the tag. The release workflow builds
   `openvps-X.Y.Z.tar.gz` plus its `.sha256` and publishes a GitHub Release.
4. Test the release on a clean Ubuntu 24.04 VPS: install, upgrade from the
   previous version, uninstall.
