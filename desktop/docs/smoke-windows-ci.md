# Desktop smoke on Windows (CI)

`.github/workflows/desktop-smoke-windows.yml` runs the desktop smoke suite on a
GitHub-hosted Windows runner (`windows-latest`). Every other check runs on
macOS, so this is where Windows-only bugs show up: `cmd` quoting, path
separators, process trees, packaging.

## What it does

1. Builds the agent the way `desktop.yml`'s Windows job does (`npm ci`,
   `npm run build`, the SEA steps, `package-bundle.ts win32-x64`). There is
   no signing and no installer.
2. Builds the desktop app (`npm ci` and `npm run build` in `desktop/`).
3. Runs `node desktop/scripts/smoke-ci.mjs`. The script launches
   `electron . --smoke` with a throwaway home, temp dir, agent state dir,
   workspace and Chromium profile, all inside one run directory. It points
   the app at `bundle/win32-x64/atomic-agent.exe` and reads the app's
   `PASS` / `FAIL` / `SMOKE` lines. The checks themselves are the in-repo
   ones (`desktop/main/main.ts` `smokeTest`, `release-fixes-smoke.ts`,
   `smoke-tasks/tNN.ts`).
4. Uploads the artifact `desktop-smoke-windows-<run number>`.

No secrets are used. The run starts with an empty state dir, so there is no
provider and no key. The runner also has no GPU and no local model.

## Starting it

- **By hand:** Actions → *Desktop smoke (Windows)* → *Run workflow*. Pick the
  branch, then set `tasks`:
  - `full` (default): the whole suite, about 30 to 60 minutes.
  - `all`: every release-fix task, without the long lanes of the full suite.
  - `fusion`: only the run-mode lane.
  - `108,111`: just those release-fix tasks. This takes a few minutes and is
    the quickest way to check one fix on Windows.

  `ref` can name another branch, tag or SHA to test.
- **From the CLI:** `gh workflow run desktop-smoke-windows.yml --ref <branch> -f tasks=108,111`
- **Automatically:** every pull request into `rel/xp-build` that touches
  `desktop/**` or `src/**` runs `full`.

## Reading the result

- **Job summary** (the run's page): the verdict, PASS/FAIL counts, every
  unexpected failure, the known failures that fired, and the known-failure
  entries that did not fire.
- **Annotations:** each unexpected FAIL is listed as an error on the run.
- **Artifact** `desktop-smoke-windows-<n>`:
  - `smoke.log`: everything the app printed.
  - `summary.json`: the same verdict, in machine-readable form.
  - `state/agent.log` (and `.1`): what `atag serve` said. This is the log
    Settings › Diagnostics shows.
  - `state/**.log`: model server and download logs, if any were written.
  - `atomic-desktop-smoke.png`: the window at the end of a `full` run.
  - `crashpad/*.dmp`: present only if Electron crashed.

The job **fails** when:

- a `FAIL` line is not on the known-failures list (exit 1), or
- the run did not finish (exit 2). This means a crash, a hang past the
  timeout, or no `SMOKE …` summary line.

## Known failures

`desktop/test/smoke-known-failures-windows-ci.txt` lists the checks that
cannot pass on this runner, each with its reason. Typical reasons:

- the check needs a real model turn or a configured provider;
- it drives a `#!/bin/sh` stand-in, which Windows cannot run;
- it needs a macOS-only tool.

Matching rules:

- An entry matches a FAIL whose name equals the entry, or starts with the
  entry followed by ` — `.
- An entry ending in `*` matches by prefix, e.g. `T41:*`.
- Lines starting with `#` are comments.

When a run shows a new FAIL:

1. Read the FAIL line and `agent.log`.
2. If it is a real Windows bug, file it in Linear. Leave it off the list, so
   the job stays red until the bug is fixed.
3. If it is the runner's limit, add the check name (or a `Tnn:*` prefix) to
   the list with a `#` comment saying why.

Entries that "did not fire" are either fixed or were not run (a narrower
`tasks` value). An entry that is fixed can be removed.

## Running the same thing locally

After the same builds, from the repo root:

```
node desktop/scripts/smoke-ci.mjs --tasks 108,111 --known-failures desktop/test/smoke-known-failures-windows-ci.txt
```

On macOS and Linux, the script falls back to `node dist/cli/index.js` when
there is no staged bundle. `--seed <dir>` copies a prepared state dir in
first, such as the QA kit's `seed-local`. `--start-model` runs
`models start` before the window opens, which is what the QA kit's `smoke.sh`
does for `full`. Run `--help` for the rest.
