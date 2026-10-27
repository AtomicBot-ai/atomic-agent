# Application updates

Status: current
Owner: src/update/

Checks available release versions and coordinates update execution. A version comparison/check must not silently become installation.

Entry point: [check-app-update.ts](check-app-update.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

## Packaged installs

[install-source.ts](install-source.ts) owns who installed the running binary. A Linux package (deb, rpm, the AUR's `atomic-agent-bin`; see [bundling](../../scripts/docs/bundling.md)) puts the bundle under `/usr/lib/atomic-agent` and leaves `install-source` beside the binary naming the format. When `process.execPath` is that binary and the marker reads, `runAppUpdate` throws with the package manager's upgrade command, `atomic-agent update` refuses before asking GitHub (`--check` still answers), the TUI skips its startup offer, uninstall plans data only, and analytics reports the format as the install channel. A copy anywhere else, the installer's `~/.local/bin` say, is unaffected even with a package on the same machine: it keeps self-updating, and `atomic-agent update` then says so (`readShadowedPackage`), because that copy comes first on the usual PATH and the package manager's upgrades never reach it. The managed engine's own updater (`atag models update`, `localModels.managed.autoUpdate`) writes only under the data directory and is not involved.

Checks: `npx vitest run src/update` when tests are present; `npm run lint`; `npm run docs:check`.
