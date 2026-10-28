# Uninstallation

Status: current
Owner: src/uninstall/

Resolves explicit uninstall targets before destructive removal. Preserve platform path handling and user-state choices.

Entry point: [resolve-uninstall-plan.ts](resolve-uninstall-plan.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

## Linux packages

When a deb, rpm or AUR package installed the binary ([install-source](../update/install-source.ts) reads the marker under `/usr/lib/atomic-agent`), `ResolvedUninstallPlan.installSource` is set and the plan holds the data targets only: the package manager owns the tree, and removing it by hand would leave dpkg's or rpm's database naming files that are gone. [package-notice.ts](package-notice.ts) owns the line the CLI plan and the TUI confirm screen show instead, with the package manager's remove command.

## Desktop app

Since Desktop 0.0.3 / terminal 0.6.9 the desktop app runs on the same state directory, so removing it removes the desktop's chats, memory, settings, API keys and models too. [detect-desktop-sharing.ts](detect-desktop-sharing.ts) looks for the desktop around the directory actually being removed (it honours `ATOMIC_AGENT_STATE_DIR`): the desktop's `state-dirs.json` record in Electron's userData listing that directory, the installed app (macOS `/Applications` or `~/Applications`, Windows `%LOCALAPPDATA%\Programs\Atomic Agent`, Linux `/opt/Atomic Agent` for the .deb; an AppImage is found only through the record), and the pre-0.0.3 `~/.atomic-agent-desktop`. The result is `ResolvedUninstallPlan.desktop`; `sharesStateDir` is set by the record, or by an installed app when the directory is the default `~/.atomic-agent`. The legacy directory alone does not set it. Detection only adds warnings: it never adds or drops a target, and `~/.atomic-agent-desktop` is never deleted. [desktop-data-policy.ts](desktop-data-policy.ts) is what callers do about it: `plansToDeleteDesktopData` says whether the plan would delete the shared folder, and `keepDesktopData` cuts the plan the way `--keep-data` does, re-totalled from the sizes already measured. The CLI applies the cut for `--yes` runs and asks a separate `[y/N]` question after the typed word on interactive runs; `--include-desktop-data` skips both and deletes. The TUI asks the same question as its own step (Keep data is the default). [desktop-notices.ts](desktop-notices.ts) owns the wording the CLI plan and the TUI confirm screen both print: the shared-folder warning under the state directory row (absent under `--keep-data`) and the "Left in place" line for the legacy directory.

Checks: `npx vitest run src/uninstall src/cli/uninstall-command.test.ts src/tui/uninstall`; `npm run lint`; `npm run docs:check`.
