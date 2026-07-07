# Skills

Skills are locally installed "playbooks": a markdown task description plus optional shell/Node scripts. Atomic Agent ships with a set of starter skills, and can install more by name from the ClawHub registry. The format is inspired by Hermes Agent and OpenCUA Operator: progressive loading (`skill.view`) keeps the prompt KV-cache lean, and scripts execute only with explicit user approval.

## On-disk format

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
| `project`  | `./.atomic-agent/skills/<name>/`         | always, if present        |
| `global`   | `$ATOMIC_AGENT_STATE_DIR/skills/<name>/` | fallback                  |

A project-local skill with the same `name` overrides the global one. This lets users commit a skill alongside their repository and override it with a local version.

## Starter skills

Atomic Agent ships with 17 starter skills that are auto-installed into the global skills directory on first run and refreshed on upgrade (platform-gated where relevant): `docker`, `ffmpeg`, `github`, `notion`, `obsidian`, `pandoc`, `pdf`, `xlsx`, `imagemagick`, `currency`, `wttr-weather`, `audio-transcribe`, `apple-calendar`, `apple-notes`, `apple-reminders`, `gog-workspace`, and `skill-creator`. The format is open, so users and playbook authors can add their own.

## CLI

```sh
atomic-agent skill install <path|owner/repo[/path]|@owner/slug> [--force] [--acknowledge-risk]
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

Local installation is `SKILL.md` validation plus `cp -r`. Skills can also be installed by name from the [ClawHub](https://clawhub.ai) registry (`@owner/slug`) or a configured GitHub tap (`owner/repo[/path]`).

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
