# Plugin marketplaces

Status: current
Owner: src/plugins/

A marketplace is a list of plugins and where to get each one, in the Claude Code format: `.claude-plugin/marketplace.json` in a git repo or a folder. oh-my-pi's `.omp-plugin/marketplace.json` has the same shape and is read too.

## Commands

| Command | What it does |
|---|---|
| `plugin marketplace add <source> [--ref <branch or tag>]` | Fetches the marketplace, reads its `name`, records it. `<source>` is `owner/repo` (GitHub), an https or ssh git URL, a local folder, or an https URL of a bare `marketplace.json`. |
| `plugin marketplace list` | Name, source, pinned commit, plugin count, last fetch. |
| `plugin marketplace show <name>` | The plugins it lists; ones that cannot be installed say why. |
| `plugin marketplace update [name]` | Fetches again (all marketplaces when no name). A failed fetch keeps the old copy. |
| `plugin marketplace remove <name>` | Forgets it and deletes its checkout. Plugins installed from it stay installed. |
| `plugin install <plugin>@<marketplace>` | Installs from that marketplace. A bare `<plugin>` works when exactly one marketplace lists it. An existing folder path still means a local install. |
| `plugin update <plugin> [--force]` | Refreshes the plugin's marketplace, then reinstalls when the commit changed. A plugin installed from a folder is copied again. |

## Files

- `<stateDir>/plugins/marketplaces.json`: per marketplace `name`, `source`, `ref`, `sha` (commit the checkout is pinned to), `manifestPath`, `addedAt`, `fetchedAt`.
- `<stateDir>/plugins/marketplaces/<name>/`: shallow checkout, or the downloaded JSON for a URL marketplace. A local-folder marketplace is read in place and never written to.
- Installed records get `source: { kind: "marketplace", marketplace, entry, url, ref, sha }`; `sha` is the commit the plugin files came from.

## Entry sources

| `source` in the entry | Installed from |
|---|---|
| `"./plugins/x"` (string) | That folder inside the marketplace. `metadata.pluginRoot` is prepended to names without `./`. Needs a git or folder marketplace. |
| `{ "source": "github", "repo": "o/r", "ref"?, "sha"?, "path"? }` | `https://github.com/o/r.git` |
| `{ "source": "url" \| "git" \| "git-subdir", "url", "ref"?, "sha"?, "path"? }` | That git URL (https or ssh only), sub-folder `path` |
| `npm`, `pip`, `command`, anything else | Listed, never installed. `command` would run a program to produce the plugin. |

With `strict: false`, or when the plugin folder has no `plugin.json`, the entry's `skills`, `commands`, `agents`, `hooks`, `mcpServers` fields are written into a `plugin.json` in the private work copy before staging.

## Safety

- Fetching never runs code: `git` runs with `core.hooksPath=/dev/null`, `core.symlinks=false`, `protocol.file` and `protocol.ext` off, no submodules, no LFS, `GIT_TERMINAL_PROMPT=0`. Nothing is built or installed.
- Git URLs must be https, `ssh://` or `user@host:path`; anything starting with `-` is refused.
- Paths from an entry must stay inside the marketplace or the cloned repo, symlinks included.
- Every install goes through `reviewAndCommit`: the staged copy is handed to a `PluginReview` before it replaces anything. Throwing cancels and the old copy stays. The CLI passes the install-safety review: [install-safety.md](install-safety.md).

