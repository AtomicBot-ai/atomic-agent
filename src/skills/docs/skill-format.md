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
env_keys:                        # optional: secret-looking env names this skill's scripts receive
  - SOME_SERVICE_API_KEY

requires_bins:                   # optional: external programs the skill runs ("a|b" = either one)
  - gh
install:                         # optional: install line shown when one is missing (or one string)
  darwin: "brew install gh"
dangerous: true                  # if true, marks the skill as dangerous (for human readers)
---
```

Validation:

- `name` matches `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`.
- All fields are strictly typed; lists must contain non-empty strings.
- Unknown keys are ignored (forward-compat), but invalid types are an error.
- `env_keys` entries must be environment variable names (`A-Z`, `0-9`, `_`).

### Script environment and `env_keys`

`skill.run_script` gives a script the same filtered environment as `os.shell.run`: secret-looking variables (API keys, tokens, passwords) loaded from `<stateDir>/.env` are removed, except names listed in `tools.shell.envPassthrough`. A skill that needs its own service key declares it in `env_keys`, and then only that skill's scripts receive it, read from the agent's environment (which includes `.env`) for that run. Another skill's scripts and `os.shell.run` still get it filtered out, so the user only has to put the key in `.env`. The agent's own provider keys and bot tokens (`KNOWN_SECRET_ENV_VARS` in `src/sandbox/command-env.ts`) are never passed this way, whatever a skill declares. The approval preview lists the declared names (never the values), and the script's output is masked for known secrets like any tool result.

- `requires_bins` and `install` are display-only and never fail a manifest: names that are not bare program names (no `/`, no spaces) and hints over 200 characters are dropped. The desktop's Settings > Skills looks each name up on the app's PATH and shows "needs program gh, not found" with the `install` line for the current platform (`darwin`, `linux`, `win32`, or `any`). A ClawHub/OpenClaw skill's `metadata.openclaw.requires.bins` and `install` (`kind: brew` formula, `kind: node` package) are read when these keys are absent.

## Install locations

| Source     | Path                                     | When it wins              |
| ---------- | ---------------------------------------- | ------------------------- |
| `global`   | `$ATOMIC_AGENT_STATE_DIR/skills/<name>/` | always, if present        |
| `project`  | `./.atomic-agent/skills/<name>/`         | when no global skill has that name |
| `global` (shared) | `~/.agents/skills/<name>/` (or `$ATOMIC_AGENT_SHARED_SKILLS_DIR`) | when no global, plugin or project skill has that name |

A project-local skill cannot replace a global skill with the same `name`: the global copy is used and the project copy is skipped with a warning in the log. A checked-out repository therefore cannot swap out a skill the user installed, or inherit what that skill is trusted to do. Project skills with new names load normally. The shared `~/.agents/skills` folder is where `npx skills` (vercel-labs/skills), Codex, Cline, Pi and Zed put skills installed "for all agents"; those skills are user-level (no folder trust) but have the lowest priority, follow global bans, and a skill folder linked there is confined to its own resolved folder. The `gog-workspace` setup check (`check-gog.sh` with no arguments) runs without an approval prompt only from the global copy (not a project or shared copy); every other skill script, including any project copy, asks first.

## Starter skills

Atomic Agent ships with a set of starter skills that are auto-installed into the global skills directory on first run and refreshed on upgrade (platform-gated where relevant). The current list, with what each one does and what it needs, is the table in [`starter-skills/README.md`](../../../starter-skills/README.md#bundled-skills). The format is open, so users and playbook authors can add their own.

## CLI

```sh
atomic-agent skill install <path|owner/repo[/path]|@owner/slug> [--force] [--yes] [--acknowledge-risk]
                                        # install from a local folder, a GitHub tap, ClawHub (@owner/slug)
atomic-agent skill update [<name>...] [--check] [--yes] [--acknowledge-risk]
                                        # update skills installed from a GitHub tap or ClawHub
atomic-agent skill update --rollback <name>   # restore the copy the last update replaced or skills.sh (skills.sh/owner/repo/skill)
atomic-agent skill uninstall <name>     # remove an installed global skill
atomic-agent skill list                 # list installed skills (project + global) with enabled/disabled state
atomic-agent skill show <name>          # print SKILL.md for an installed skill
atomic-agent skill enable <name>        # re-enable a previously disabled skill
atomic-agent skill disable <name>       # hide a skill without removing its files
atomic-agent skill browse [--source owner/repo]   # browse installable skills (ClawHub + configured taps)
atomic-agent skill search <query>       # search ClawHub + skills.sh + configured taps
atomic-agent skill tap list|add <owner/repo>|remove <owner/repo>   # manage hub taps
atomic-agent skill history [name]       # change log, saved versions, use count
atomic-agent skill restore <name> [--version <id>|archive]   # undo: put back an archived copy or a saved version
atomic-agent skill curate [--dry-run]   # archive unused agent-learned skills now
atomic-agent skill learned [undo <id>]  # skills the agent learned by itself; undo one
atomic-agent skill learned approve|discard <id>   # a learned draft pending review: make it live, or delete it
```

Local installation is a security scan, `SKILL.md` validation and `cp -r`. Skills can also be installed by name from the [ClawHub](https://clawhub.ai) registry (`@owner/slug`) or a configured GitHub tap (`owner/repo[/path]`). Search also asks [skills.sh](https://skills.sh) and shows its install counts; a skills.sh row (`skills.sh/owner/repo/skill`) is looked up in its GitHub repository and then installed like a tap skill, with the same download limits, scan and gate. skills.sh's search API is undocumented: any network or response-shape problem is a warning and the other sources still answer.

### Install security scan

Every install runs the heuristic scanner (`src/skills/hub/skill-security-scanner.ts`) before anything is copied: local folders (CLI, `POST /api/skills/install`, sidecar `skill_install`), GitHub taps and ClawHub. A local folder is first copied (symlinks as links, never followed) into a private temp folder; that copy is scanned and that same copy is installed, so the folder cannot change between the scan and the copy. Hub and ClawHub installs scan the extracted files on disk. Every regular file is read, whatever its name, because a script can source any other file of the skill; text is read as UTF-8 or UTF-16 (with or without a BOM). Files are never skipped for size: up to 4 MiB a file is scanned whole; a bigger one has its first and last 512 KiB scanned and adds an `oversized-file` finding. A binary file adds `unscanned-binary`. Both are `dangerous` for something that runs (under `scripts/` or `bin/`, a script extension, or a `#!` line) and `caution` for docs and data. Past 64 MiB for one skill, an unreadable file and a symlink that points outside the skill are `dangerous` `unscanned-file` findings; a symlink inside the skill adds nothing, its target is scanned as its own file. PowerShell download-and-run (`irm … | iex`, `iex (New-Object Net.WebClient).DownloadString(…)`) is `dangerous` like `curl | sh`. ClawHub's own verdict is merged in: `malicious` is `dangerous`, `suspicious` and `unknown` (no scan result) are `caution`.

The verdict gates the install (`enforceScanGate`):

- `ok` installs.
- `caution` needs an explicit yes. The CLI asks `[y/N]` in a terminal; `--yes` answers it for scripts; without a terminal and without `--yes` the install is refused. The HTTP route answers 428 `needs_confirmation` with the findings and a `scanId`, and installs on a retry with `confirm: "<scanId>"`; the sidecar fails the request unless `confirm` is the id its error named. The id is a hash of the verdict and findings, so a yes covers only the findings that were shown: if the folder changed, the retry is refused with the new id. The TUI shows its confirm modal.
- `dangerous` is refused unless `--acknowledge-risk` (HTTP/sidecar `acknowledgeRisk: "<scanId>"`); `--yes` and `confirm` do not override it.

The scan is a tripwire, not a sandbox: a clean verdict does not prove a skill is safe.

### Hub skill lock and updates

A skill installed from a GitHub tap or ClawHub gets a `.atomic-skill-lock.json` file in its folder: the source, the identifier, the exact version that was downloaded and scanned (GitHub: the commit the download was pinned to, plus the git tree sha of the skill folder; ClawHub: the registry version, also pinned for the download and the registry verdict), the scan id and verdict, and a sha256 digest of every file in the folder (the lock file itself excluded). A lock file shipped inside a download or a local folder is dropped; local installs never get one, so `skill update` leaves them and the starter skills alone.

`skill update --check` asks each source for its latest version and prints what is outdated. `skill update` stages each outdated skill in a temp folder and runs the same scan and gate as `skill install`; a refused scan keeps the installed version, and a `dangerous` verdict still needs `--acknowledge-risk`. A third-party skill is never replaced without the person agreeing: in a terminal, `skill update` prints the version change (current -> new) and the scan verdict with its findings and asks `[y/N]` before the installed copy is touched; `--yes` is the explicit opt-in that skips the question; without a terminal and without `--yes` it only reports what has an update and replaces nothing. A skill whose files no longer match the digest was changed by hand: it is reported and never overwritten (reinstall with `--force` to discard the changes). Before the swap the previous copy is moved to `skill-backups/<name>/` next to the skills folder (never inside it, where it would load as a second skill) and put back if the swap fails; `skill update --rollback <name>` swaps it back later. Nothing checks for or installs updates in the background.

## Agent tools

- `skill.view({ name })` reads `SKILL.md`, strips the frontmatter, and stores the skill body in `session.loadedSkills`. A repeated `skill.view` for the same skill does not grow the prompt (cached for the session). Read-only, no approval required.
- `skill.run_script({ skill, script, args?, timeoutMs? })` executes `scripts/<script>`. Only scripts listed in `requires_scripts` are allowed; any path outside `scripts/` is rejected. Always **dangerous**: routed through the approval gate, with a preview that includes the skill name, script path, arguments and the names in `env_keys`.

Extensions (`.ts`, `.js`, `.mjs`, `.cjs`) are executed via `node`, `.sh` via `bash`, everything else is run directly (shebang/executable file).

## History, usage and the curator

Global skills (`<stateDir>/skills/`) keep a history (ATO-580, [curator](../curator/index.ts)):

- `skill.view` and `skill.run_script` count a use in `<stateDir>/skills-usage.json` (use count, last use).
- Before the agent changes a skill folder with `os.fs.write`, `edit`, `patch`, `move`, `trash` or `restore`, the folder is copied to `<stateDir>/skills-history/<name>/<version>/` (10 versions kept per skill) and the change is appended to `<stateDir>/skills-history/changes.jsonl` (who, what, when). A folder the agent created is recorded as agent-learned. `skill uninstall` is saved the same way. Shell commands are not tracked.
- The curator only considers agent-learned skills: never starters, hub, plugin or hand-written ones, and never one a recurring task names. Unused for 14 days it is marked stale; for 30 days it is moved to `<stateDir>/skills-archive/` (never deleted). The automatic pass is off by default (`ATOMIC_AGENT_SKILL_CURATOR=1` turns it on at boot, at most once a week); `skill curate` runs it by hand and `skill restore` undoes it.

## Self-learning

After a turn of at least `skills.selfLearning.minSteps` model steps (default 10) that ended on a reply, one background model call reviews it (ATO-67, [learning](../learning/index.ts), wired in [runtime-experience-review.ts](../../runtime/composition/runtime-experience-review.ts)). It answers with one JSON decision: `none` (the usual answer), `create` a new focused skill, or `patch` a skill the turn loaded or ran whose steps proved wrong or missing. Only skills in the global folder that are not starters, hub installs, plugin, shared or project skills can be patched; a new skill must take a name no skill (or archived skill) uses. Turns from the terminal (`cli`, `tui`), the desktop (sidecar, or HTTP with the desktop answer channel) and editors over ACP save what they learned live. Scheduler and fusion-worker turns are never reviewed. Every other turn is reviewed but only into a draft that waits for the owner (decided 18.11): a turn that read outside content (a web page, search results, an MCP answer, an HTTP body, the inbox, another chat: the approval gate's taint from `untrustedOutput` / `externalSource` tools), a chat channel turn (Telegram, Discord, Slack and the rest) and a plain HTTP caller's turn. Incognito, `skill eval`, budget-stopped and stopped turns are not reviewed, nor a turn that edited a skill itself; one review runs at a time. In the review prompt the steps and the reply sit between data markers with an instruction never to follow what they say.

A draft lives in `<stateDir>/skills-pending/<id>/` (`SKILL.md` plus `draft.json`: id, `create` or `patch`, the skill, the outside sources and origin, the time, and for a patch a sha256 of the target `SKILL.md`). That folder is outside the loaded skills tree, so a draft is never loaded or offered to the model. The linter and the scanner below run before a draft is kept; a refused one is not kept at all. At most 20 drafts are kept, the oldest dropped first. `/learn` and `skill learned` list them first, marked "Pending review"; `skill list --json` lists them too with `"status": "pending"` and a `draftId` (the tab-separated `skill list` the desktop reads today stays installed skills only). `/learn approve <id>` (`skill learned approve <id>`) runs the linter and scanner again and then writes the skill exactly like an auto-save below, under the same id, so `/learn undo <id>` works on it; a patch is refused when its target changed since the draft was made, and the message says so. `/learn discard <id>` deletes the draft. This is how Claude Code holds a project's `.mcp.json` servers until the user approves them, and OpenClaw's skill workshop keeps proposals in its approval mode.

Every write passes the linter ([skill-lint.ts](../learning/skill-lint.ts)): valid frontmatter whose `name` equals the folder, a one-line description of at most 300 characters, a body that says something, at most 16 KiB and 500 body lines, no `requires_scripts`, `env_keys` or `dangerous`, and nothing that looks like a key or token. Then the hub's security scanner ([skill-security-scanner.ts](../hub/skill-security-scanner.ts)) runs on the SKILL.md, and anything but a clean verdict is refused: `dangerous` (remote exec, exfiltration, destructive commands) and `caution` (network fetches like `curl`/`wget`, credential paths, `eval`, injection phrasing) alike, since nobody confirms an auto-saved skill. The previous version is saved in the history first (the same snapshot as above) and the change is appended to `<stateDir>/skills-history/learned.jsonl` with a short id. `/learn` in the TUI and `skill learned` list them; `/learn undo <id>` (`skill learned undo <id>`) archives a created skill or restores the version saved before a patch, and only the newest live change of a skill can be undone. `skills.selfLearning.enabled: false` turns it off. A desktop "Learned" panel with Undo, and Approve/Discard for drafts, is not built yet.

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
