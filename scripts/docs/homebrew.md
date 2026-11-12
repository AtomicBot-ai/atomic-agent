# Homebrew

Status: current
Owner: scripts/

```sh
brew install atomicbot-ai/tap/atag                 # CLI: commands atag and atomic-agent
brew install --cask atomicbot-ai/tap/atomic-agent  # desktop app
```

Both live in the tap `AtomicBot-ai/homebrew-tap` (`Formula/atag.rb`, `Casks/atomic-agent.rb`). Nothing in the tap is edited by hand: `.github/workflows/homebrew.yml` rewrites the file whenever a stable release is published on GitHub.

## The formula `atag` (CLI)

Made from a `vX.Y.Z` release by `scripts/homebrew.ts` (rendering in `scripts/homebrew-packaging.ts`). It installs the same `atomic-agent-darwin-<arch>.tar.gz` bundle install.sh fetches, whole, under the keg's `libexec`, because the runtime resolves `grammars/`, `vendor/`, `starter-skills/` and `node_modules/` next to the binary, and links `bin/atag` and `bin/atomic-agent` to it. One `url`/`sha256` per architecture the release has: Apple silicon today, Intel too once the release builds `darwin-x64` (the formula then drops `depends_on arch: :arm64` by itself). macOS only: Linux has the deb, rpm and AUR packages.

`atag update` knows a Homebrew copy by its path (`Cellar/atag/`, `src/update/install-source.ts`) and answers with `brew upgrade atag`.

## The cask `atomic-agent` (desktop)

Made from a `desktop-vX.Y.Z` release's `SHA256SUMS.txt`: the `Atomic-Agent-<version>-<arch>.dmg` of each architecture present. `auto_updates true`, because the app updates itself from the same release (electron-updater); `brew upgrade` leaves it to the app unless run with `--greedy`. `brew uninstall --zap` removes the app's Library folders but never `~/.atomic-agent`, which the CLI shares.

## When it runs

`release: published` (the same event the desktop's update feed goes out on), or by hand: `gh workflow run homebrew.yml -f tag=vX.Y.Z`. Drafts and pre-releases are skipped, and a run for a version older than the tap's is a no-op, so re-running is safe.

## One-time setup (by hand)

1. Create the public repository `AtomicBot-ai/homebrew-tap` with a README in its first commit (the workflow checks it out, so it cannot be empty). Brew finds it as `atomicbot-ai/tap`.
2. Create a fine-grained token with access to that repository only, permission Contents: read and write. Save it in AtomicBot-ai/atomic-agent as the secret `HOMEBREW_TAP_TOKEN`.
3. Fill the tap from the current releases: `gh workflow run homebrew.yml -f tag=<latest vX.Y.Z>` and `gh workflow run homebrew.yml -f tag=<latest desktop-vX.Y.Z>`.
4. Check on a Mac: `brew install atomicbot-ai/tap/atag && atag --version`, `brew install --cask atomicbot-ai/tap/atomic-agent`, and `brew audit --strict --online atomicbot-ai/tap/atag`.
