# Scoop and winget

Status: current
Owner: scripts/

```powershell
scoop bucket add atomicbot https://github.com/AtomicBot-ai/scoop-bucket
scoop install atomicbot/atomic-agent        # CLI: atomic-agent and atag
winget install AtomicBot.AtomicAgent        # desktop app
winget install AtomicBot.AtomicAgent.CLI    # CLI: atomic-agent
```

`.github/workflows/windows-packages.yml` keeps both up to date when a stable release is published on GitHub (`release: published`); drafts and pre-releases are skipped. The manifests are rendered by `scripts/windows-packages.ts` (`scripts/windows-packaging.ts`) from the release's own checksums.

## Scoop (CLI only)

The bucket `AtomicBot-ai/scoop-bucket` holds `bucket/atomic-agent.json`: the release's `atomic-agent-win32-x64.zip` (the archive install.ps1 fetches) unpacked whole, because the runtime resolves `grammars\`, `vendor\`, `starter-skills\` and `node_modules\` next to the exe, with shims for `atomic-agent` and `atag`. The workflow rewrites it on every CLI release; `checkver` (the releases feed, `vX.Y.Z` tags only) and `autoupdate` (hash from the published `.sha256`) let Scoop's own tooling do the same. The desktop app is not in Scoop: Scoop would have to unpack the NSIS installer by hand and would fight the app's own updater. winget covers it.

## winget

| Id | From | Notes |
|---|---|---|
| `AtomicBot.AtomicAgent` | `Atomic-Agent-Setup-<v>-x64.exe`, `-arm64.exe` of a `desktop-vX.Y.Z` release | NSIS, per-user (`Scope: user`), silent with `/S`. The app keeps updating itself as before. |
| `AtomicBot.AtomicAgent.CLI` | `atomic-agent-win32-x64.zip` of a `vX.Y.Z` release | `zip` with a nested `portable` exe and `ArchiveBinariesDependOnPath: true`: winget puts the unpacked folder on PATH instead of a symlink in `WinGet\Links`, since through a symlink the exe would look for its folders beside the link. So the command is `atomic-agent`; `atag` would need an `atag.cmd` inside the release zip. |

A new package enters `microsoft/winget-pkgs` only after Microsoft's manual review, and `wingetcreate update` (MIT) works only on a package that is already there. So the workflow submits an update only for ids listed in the repository variable `WINGET_PACKAGES`; until then it renders the manifests, keeps them as the run's artifact, and logs a notice.

`atag update` knows a Scoop or winget copy by its path (`src/update/install-source.ts`) and answers with `scoop update atomic-agent` or `winget upgrade AtomicBot.AtomicAgent.CLI`.

## One-time setup (by hand)

Scoop:

1. Create the public repository `AtomicBot-ai/scoop-bucket` with a README in its first commit and an empty `bucket/` folder (a `.gitkeep` is enough).
2. Create a fine-grained token for that repository only, Contents: read and write; save it in AtomicBot-ai/atomic-agent as the secret `SCOOP_BUCKET_TOKEN`.
3. Fill it: `gh workflow run windows-packages.yml -f tag=<latest vX.Y.Z>`. Check on Windows: `scoop bucket add atomicbot https://github.com/AtomicBot-ai/scoop-bucket`, `scoop install atomicbot/atomic-agent`, `atag --version`.

winget:

1. Before submitting, test the manifests locally on a Windows machine: download the `winget-manifests-<tag>` artifact of a run, then `winget settings --enable LocalManifestFiles` (admin) and `winget install --manifest <dir>` for each package. For the CLI check that `atomic-agent --version` works in a new terminal and that a chat starts (this proves the exe finds `node_modules\` from where winget unpacked it).
2. Fork `microsoft/winget-pkgs` with the GitHub account that will open the pull requests, and create a classic token with `public_repo` for it. Save it as the secret `WINGET_TOKEN`.
3. First submission, once per package: `gh workflow run windows-packages.yml -f tag=<latest desktop-vX.Y.Z> -f winget_first_submission=true`, and the same with the latest `vX.Y.Z`. Each opens a pull request in winget-pkgs; answer the reviewers there if they ask anything.
4. When a pull request is merged, add its id to the repository variable `WINGET_PACKAGES` (Settings, Secrets and variables, Actions, Variables), for example `AtomicBot.AtomicAgent,AtomicBot.AtomicAgent.CLI`. From then on every release opens its update pull request by itself.
