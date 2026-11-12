# npm

Status: current
Owner: scripts/

`npm install -g atomic-agent` (or `npx atomic-agent`) installs the CLI with the `atag` command.

## Packages

| Package | What it holds |
|---|---|
| `atomic-agent` | The launcher (`packaging/npm/atomic-agent`): `bin/atag.js` finds the platform package and runs its binary with the same arguments, terminal and exit status. Commands: `atag`, `atomic-agent`. |
| `@atomicbot/atag-<slug>` | One per release target (`scripts/bundle-targets.ts`): the release bundle `atomic-agent-<slug>.tar.gz\|zip`, unpacked, with `os`/`cpu` (and `libc: glibc` on Linux) set. |

The launcher lists every platform package as an `optionalDependency`, so npm downloads only the one matching the machine. The binary runs in place inside `node_modules/@atomicbot/atag-<slug>/`, because the runtime resolves `grammars/`, `vendor/`, `starter-skills/` and `node_modules/` next to `process.execPath`. The bundle's `node_modules/` (better-sqlite3 with the addon built for the SEA's Node, bindings, file-uri-to-path, playwright-core) ships as `bundleDependencies` with install scripts stripped, so npm neither drops it nor rebuilds the addon for the user's Node (`scripts/npm-packaging.ts`).

The root `package.json` is also named `atomic-agent` but is the source tree (sidecar, debug CLI); it is never published. Only `packaging/npm/atomic-agent` goes to npm under that name.

## Releases

Publishing a `vX.Y.Z` release on GitHub runs `.github/workflows/npm.yml`: it downloads the release's bundles, checks each against its `.sha256`, stages the packages (`npx tsx scripts/npm-packages.ts stage --version X.Y.Z --archives dl --out dist/npm`) and publishes them, platform packages first, with npm provenance. A pre-release goes to the `next` dist-tag. Versions already on npm are skipped, so a re-run is safe. Without the `NPM_TOKEN` secret the workflow logs a notice and publishes nothing.

Run it by hand for a release that is already out: `gh workflow run npm.yml -f tag=vX.Y.Z` (add `-f dry_run=true` to stage and run `npm publish --dry-run` only).

## Updates

`atag update` knows an npm copy by its path (`src/update/install-source.ts`) and answers with `npm install -g atomic-agent@latest` instead of re-running install.sh over files npm owns. `atag uninstall` lists only the data and names `npm uninstall -g atomic-agent`.

## One-time setup (by hand)

1. Sign in to npmjs.com as an owner of the `atomicbot` organization (the `@atomicbot` scope).
2. Create a granular access token: publish rights for the package `atomic-agent` and the `@atomicbot` scope (packages that do not exist yet included), no IP limits. Save it as the repository secret `NPM_TOKEN`.
3. Claim the name and ship the current release: `gh workflow run npm.yml -f tag=vX.Y.Z` with the latest published tag. The first run creates `atomic-agent` and the `@atomicbot/atag-*` packages.
4. Check from a clean machine: `npm install -g atomic-agent && atag --version`.
