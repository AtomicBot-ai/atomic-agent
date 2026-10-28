# Skills

Status: current
Owner: src/skills/


Skills are locally installed "playbooks": a markdown task description plus optional shell/Node scripts. Atomic Agent ships with a set of starter skills, and can install more by name from the ClawHub registry. The format is inspired by Hermes Agent and OpenCUA Operator: progressive loading (`skill.view`) keeps the prompt KV-cache lean, and scripts execute only with explicit user approval.

## On-disk format

This page describes Atomic's native/local registry. Cloud additionally supports [project skill compatibility and scoped controls](cloud-workspace.md), with separate loaded state and source-aware revalidation.

```
<skill-root>/
  SKILL.md           # required: YAML frontmatter + markdown body
  scripts/           # optional: shell/node/bash scripts
    *.sh | *.ts | *.js | *.mjs | *.cjs
  references/        # optional: static files the agent reads via `os.fs.read`
```

## Frontmatter

```yaml
---
name: check-gmail-inbox          # required, kebab-case, unique
description: "Check Gmail inbox" # required, ≤ ~200 characters
version: 0.1.0                   # required, free-form string (SemVer recommended)
requires_tools:                  # informational list of tools the skill expects
  - browser.navigate
  - browser.read_aria
requires_scripts:                # only these names may be invoked via skill.run_script
  - fetch-headers.sh
dangerous: true                  # if true, marks the skill as dangerous (for human readers)
---
```

Validation:

- `name` matches `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`.
- All fields are strictly typed; lists must contain non-empty strings.
- Unknown keys are ignored (forward-compat), but invalid types are an error.

## Install locations

| Source     | Path                                     | When it wins              |
| ---------- | ---------------------------------------- | ------------------------- |
| `global`   | `$ATOMIC_AGENT_STATE_DIR/skills/<name>/` | always, if present        |
| `project`  | `./.atomic-agent/skills/<name>/`         | when no global skill has that name |

A project-local skill cannot replace a global skill with the same `name`: the global copy is used and the project copy is skipped with a warning in the log. A checked-out repository therefore cannot swap out a skill the user installed, or inherit what that skill is trusted to do. Project skills with new names load normally. The `gog-workspace` setup check (`check-gog.sh` with no arguments) runs without an approval prompt only from the global copy; every other skill script, including any project copy, asks first.

## Starter skills

Atomic Agent ships with 17 starter skills that are auto-installed into the global skills directory on first run and refreshed on upgrade (platform-gated where relevant): `docker`, `ffmpeg`, `github`, `notion`, `obsidian`, `pandoc`, `pdf`, `xlsx`, `imagemagick`, `currency`, `wttr-weather`, `audio-transcribe`, `apple-calendar`, `apple-notes`, `apple-reminders`, `gog-workspace`, and `skill-creator`. The format is open, so users and playbook authors can add their own.

## CLI

```sh
atomic-agent skill install <path|owner/repo[/path]|@owner/slug> [--force] [--yes] [--acknowledge-risk]
                                        # install from a local folder, a GitHub tap, or ClawHub (@owner/slug)
atomic-agent skill uninstall <name>     # remove an installed global skill
atomic-agent skill list                 # list installed skills (project + global) with enabled/disabled state
atomic-agent skill show <name>          # print SKILL.md for an installed skill
atomic-agent skill enable <name>        # re-enable a previously disabled skill
atomic-agent skill disable <name>       # hide a skill without removing its files
atomic-agent skill browse [--source owner/repo]   # browse installable skills (ClawHub + configured taps)
atomic-agent skill search <query>       # search ClawHub + configured taps
atomic-agent skill tap list|add <owner/repo>|remove <owner/repo>   # manage hub taps
```

Local installation is a security scan, `SKILL.md` validation and `cp -r`. Skills can also be installed by name from the [ClawHub](https://clawhub.ai) registry (`@owner/slug`) or a configured GitHub tap (`owner/repo[/path]`).

### Install security scan

Every install runs the heuristic scanner (`src/skills/hub/skill-security-scanner.ts`) before anything is copied: local folders (CLI, `POST /api/skills/install`, sidecar `skill_install`), GitHub taps and ClawHub. A local folder is first copied (symlinks as links, never followed) into a private temp folder; that copy is scanned and that same copy is installed, so the folder cannot change between the scan and the copy. Hub and ClawHub installs scan the extracted files on disk. Every regular file is read, whatever its name, because a script can source any other file of the skill; text is read as UTF-8 or UTF-16 (with or without a BOM). Files are never skipped for size: up to 4 MiB a file is scanned whole; a bigger one has its first and last 512 KiB scanned and adds an `oversized-file` finding. A binary file adds `unscanned-binary`. Both are `dangerous` for something that runs (under `scripts/` or `bin/`, a script extension, or a `#!` line) and `caution` for docs and data. Past 64 MiB for one skill, an unreadable file and a symlink that points outside the skill are `dangerous` `unscanned-file` findings; a symlink inside the skill adds nothing, its target is scanned as its own file. PowerShell download-and-run (`irm … | iex`, `iex (New-Object Net.WebClient).DownloadString(…)`) is `dangerous` like `curl | sh`. ClawHub's own verdict is merged in: `malicious` is `dangerous`, `suspicious` and `unknown` (no scan result) are `caution`.

The verdict gates the install (`enforceScanGate`):

- `ok` installs.
- `caution` needs an explicit yes. The CLI asks `[y/N]` in a terminal; `--yes` answers it for scripts; without a terminal and without `--yes` the install is refused. The HTTP route answers 428 `needs_confirmation` with the findings and a `scanId`, and installs on a retry with `confirm: "<scanId>"`; the sidecar fails the request unless `confirm` is the id its error named. The id is a hash of the verdict and findings, so a yes covers only the findings that were shown: if the folder changed, the retry is refused with the new id. The TUI shows its confirm modal.
- `dangerous` is refused unless `--acknowledge-risk` (HTTP/sidecar `acknowledgeRisk: "<scanId>"`); `--yes` and `confirm` do not override it.

The scan is a tripwire, not a sandbox: a clean verdict does not prove a skill is safe.

## Agent tools

- `skill.view({ name })` reads `SKILL.md`, strips the frontmatter, and stores the skill body in `session.loadedSkills`. A repeated `skill.view` for the same skill does not grow the prompt (cached for the session). Read-only, no approval required.
- `skill.run_script({ skill, script, args?, timeoutMs? })` executes `scripts/<script>`. Only scripts listed in `requires_scripts` are allowed; any path outside `scripts/` is rejected. Always **dangerous**: routed through the approval gate, with a preview that includes the skill name, script path and arguments.

Extensions (`.ts`, `.js`, `.mjs`, `.cjs`) are executed via `node`, `.sh` via `bash`, everything else is run directly (shebang/executable file).

## Prompt and KV-cache

The stable prompt prefix contains only `name: description` of installed skills (see `src/prompt/stable-prefix.ts`). A skill body enters the prompt **only** after `skill.view` and stays there until the end of the session as a stable part of the tail. This means one KV-cache invalidation per session, not per step.

## Example: `echo`

```
echo/
  SKILL.md
  scripts/
    say.js
```

`SKILL.md`:

```markdown
---
name: echo
description: "Echo CLI arguments back to stdout"
version: 0.1.0
requires_scripts: [say.js]
dangerous: false
---

Invoke `skill.run_script` with `skill: echo`, `script: say.js` and arbitrary `args`. The script will print `"said <args>"`.
```

`scripts/say.js`:

```js
process.stdout.write("said " + process.argv.slice(2).join(" "));
```

## Explicit boundaries

- Skills are **data + scripts**, not plugins: they cannot dynamically register new tools or `require` native modules.
- Sources are local folders, GitHub taps (`owner/repo[/path]`), and the ClawHub registry (`@owner/slug`), not arbitrary URL fetches.
- Scripts run only with explicit user approval, and only those listed in `requires_scripts`.
