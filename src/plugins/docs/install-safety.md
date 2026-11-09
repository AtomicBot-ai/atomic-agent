# Plugin install safety

Status: current
Owner: src/plugins/

Every plugin install and update (local folder, marketplace, `--force`, `plugin update`) runs three checks on the staged copy before it replaces anything. Code: [../plugin-install-review.ts](../plugin-install-review.ts), [../plugin-permissions.ts](../plugin-permissions.ts).

## 1. Security scan

The skill scanner (`src/skills/hub/scan-skill-dir.ts`) reads every file of the plugin: skills, commands, agents, `hooks/hooks.json`, `.mcp.json`, everything else. Same verdicts and gate as `skill install` (`enforceScanGate`):

- `ok`: continues.
- `caution`: asks in a terminal ("Install this plugin anyway?"); without one it needs `--yes`.
- `dangerous`: refused unless `--acknowledge-risk`.

A client that shows the findings answers with the scan id (`approvedScanId`), so a yes covers only the findings it showed.

## 2. Permission diff (update and `--force`)

`diffPluginPermissions(oldBundle, newBundle)` compares what each version would run and what it adds: local (stdio) MCP servers added, removed or with a changed command; remote server URLs; which of the user's keys each server receives; hooks added or removed; script files added, changed (by sha256) or removed; new skills, commands and subagents; and whether the plugin starts running code. `describePermissionDiff` turns it into plain lines, printed before any question.

`codeChanged` is true when anything that runs is new or different. URL changes of a remote server that receives no keys, and removals, are shown but do not count: they run nothing here and hand over nothing. Any change to a server that receives keys (a new address, a new key) does count.

## 3. Runs-code consent

A plugin runs code when it ships hooks, a local MCP server or skill scripts, or when any MCP server of it receives the user's keys (`${NAME}` in its entry, `bundleRunsCode`). Handing over a key is trusted like running code: same flag, same question. Such a plugin installs with those parts off (`runsCodeAccepted: false`) until the person agrees, once per package:

- In a terminal the CLI lists exactly what would run (`describePluginCode`: each local MCP command, each hook command, each script file, each server and the keys it gets) and asks.
- `--accept-code` agrees up front. Without a terminal and without the flag the plugin installs with code off; `plugin allow-code <name>` turns it on later.
- On update an earlier yes is kept only when `codeChanged` is false; otherwise the record is reset and the question comes back.
- A desktop answer echoes `consentId` (`codeConsentIdOf`), a hash of exactly that list, so code that changed after the question was shown is never allowed unseen.

Consent never comes from the plugin, from prompt text or from a headless default.

## For the desktop

Plain exported functions, no UI: `stagePluginCopy`, `inspectStagedPlugin` (scan, scan id, code list, consent id, diff, change lines), `createPluginInstallReview({approvedScanId, confirmCaution, acknowledgeRisk, acceptCode, approvedConsentId})`, `reviewAndCommit`, `discardStagedPlugin`.

## Not covered

Heuristic scan only, not a sandbox. A model-based judge (ATO-612) and OS sandboxing of plugin code (ATO-469) are follow-ups.
