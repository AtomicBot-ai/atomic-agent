# Analytics and opt-out

Status: current
Owner: src/analytics/

Owns product telemetry and usage metering. Preserve opt-out/kill-switch handling and sanitized dimensions; distinguish product analytics from local trace capture.

Entry point: [analytics-client.ts](analytics-client.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/analytics` when tests are present; `npm run lint`; `npm run docs:check`.

## Install events and the shared state folder

Desktop (0.0.3 and later) and the terminal share one state folder, `~/.atomic-agent`, so they share `analytics.json` and one install id. `app_installed` is still counted per surface: the file keeps one "sent" flag for the terminal (`appInstalledSent`, used by `tui` and `cli`) and one for the desktop (`appInstalledSentDesktop`), picked by the `surface` passed to `captureAppInstalled` (ATO-1227). Each surface therefore reports `app_installed` once. `other_surface_installed` on that event is `true` when the other surface's flag is already set, or when a legacy separate state dir (`~/.atomic-agent-desktop`) holds an `analytics.json`.

A file written before the desktop flag existed has only `appInstalledSent`; it reads as "terminal reported, desktop not". On a machine where the desktop ran first on an older build, the desktop therefore sends `app_installed` one more time after the upgrade.

`first_message_sent` and `model_configured` are split the same way (ATO-1262): `firstMessageSent` / `modelConfiguredSent` for the terminal and `firstMessageSentDesktop` / `modelConfiguredSentDesktop` for the desktop. The store takes the process's surface at construction (`runtime-observability.ts`), so callers need not pass it. A file from before the split reads as "terminal reported, desktop not", so on a machine where the desktop already sent its first message on an older build, it sends `first_message_sent` and `model_configured` once more after the upgrade.

Writes merge the file's current flags first (a flag only goes from `false` to `true`) and keep keys this build does not know, because both surfaces may have the file open at once. Older builds rewrite the file with only the keys they know, so an older terminal can drop `appInstalledSentDesktop`; the desktop then reports once more.

## `ui_action` from the terminal

Every built-in slash command the TUI runs sends one `ui_action` (ATO-1465), the same event name and property names the desktop uses, so a dashboard can union both and split them by the `surface` the client stamps on every event (`tui` here, `desktop` there).

- `action`: the command's canonical name with its slash (`/report`, `/discord`; an alias counts as its command, so `/cost` is `/usage`). Never its arguments: `/discord foo bar` sends `/discord`.
- `via`: `slash` (typed), `palette` (picked in the slash palette) or `menu` (a menu entry that runs a command).

Only names from the built-in registry are sent. Skills, plugin commands, unknown input and plain messages send nothing. The event goes through the normal client, so it is dropped while analytics is off, under `ATOMIC_AGENT_ANALYTICS=off` and under `DO_NOT_TRACK`. Wiring: `reportBuiltInSlashCommand` in `src/tui/submit-handler.ts` → `TuiAppCallbacks.onUiAction` → `runtime.reportUiAction` → `captureUiAction`.
