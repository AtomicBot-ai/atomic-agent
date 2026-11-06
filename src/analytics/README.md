# Analytics and opt-out

Status: current
Owner: src/analytics/

Owns product telemetry and usage metering. Preserve opt-out/kill-switch handling and sanitized dimensions; distinguish product analytics from local trace capture.

Entry point: [analytics-client.ts](analytics-client.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/analytics` when tests are present; `npm run lint`; `npm run docs:check`.

## Install events and the shared state folder

Desktop (0.0.3 and later) and the terminal share one state folder, `~/.atomic-agent`, so they share `analytics.json` and one install id. `app_installed` is still counted per surface: the file keeps one "sent" flag for the terminal (`appInstalledSent`, used by `tui` and `cli`) and one for the desktop (`appInstalledSentDesktop`), picked by the `surface` passed to `captureAppInstalled` (ATO-1227). Each surface therefore reports `app_installed` once. `other_surface_installed` on that event is `true` when the other surface's flag is already set, or when a legacy separate state dir (`~/.atomic-agent-desktop`) holds an `analytics.json`.

A file written before the desktop flag existed has only `appInstalledSent`; it reads as "terminal reported, desktop not". On a machine where the desktop ran first on an older build, the desktop therefore sends `app_installed` one more time after the upgrade.

`first_message_sent` and `model_configured` still have one flag per file, shared by both surfaces.

Writes merge the file's current flags first (a flag only goes from `false` to `true`) and keep keys this build does not know, because both surfaces may have the file open at once. Older builds rewrite the file with only the keys they know, so an older terminal can drop `appInstalledSentDesktop`; the desktop then reports once more.
