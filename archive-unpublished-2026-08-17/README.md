# Unpublished work archive — 2026-08-17

A snapshot of local work that never made it to a remote, archived here before the
working checkout it lived in was decommissioned. **Nothing here has been reviewed
or test-gated.** Treat it as a starting point, not as finished work.

Everything is based on `main@9d525ef` (v0.1.73) and
`feature/desktop-integration@0feef3b`, both of which are published in this repo —
so the bundle below restores cleanly against a normal clone.

## What's in the bundle

`atomic-agent-unpublished-2026-08-17.bundle` (140 KB) carries three branches:

| Branch | Contents |
|---|---|
| `valeryb/cli-download-ux-ato22-ato6` | One WIP commit, 72 files, +3244/-407. Local-model download UX, provider-registry role resolution, config plumbing (ATO-22 / ATO-6). Was an uncommitted working tree; committed as-is at archive time. |
| `fix/run-multiline-prompt` | 2 commits. `run` silently dropped piped stdin (adds `--prompt` / `--prompt-file`); `os.fs.grep` on a single file died with `spawn ENOTDIR`. |
| `merge/desktop-latest` | 3 commits on top of `feature/desktop-integration`: main (v0.1.73) merged in, the packaged Electron sidecar made to actually boot and ship its runtime, plus desktop onboarding and provider setup. 342 files under `apps/`. |

## Restoring it

These exact commands were run and verified on 2026-08-17:

```bash
git clone https://github.com/AtomicBot-ai/atomic-agent.git
cd atomic-agent
git checkout archive/unpublished-2026-08-17
git fetch archive-unpublished-2026-08-17/atomic-agent-unpublished-2026-08-17.bundle \
    'refs/heads/*:refs/heads/archived/*'
git branch --list 'archived/*'
git switch archived/valeryb/cli-download-ux-ato22-ato6
```

The bundle only carries the unpublished commits; its four prerequisite commits all
live on `main` and `feature/desktop-integration`, so the fetch must run inside a
clone of this repo (not an empty directory).

Sanity check before trusting it:

```bash
git bundle verify archive-unpublished-2026-08-17/atomic-agent-unpublished-2026-08-17.bundle
```

Note the branch name contains a slash, so `raw.githubusercontent.com/<owner>/<repo>/<branch>/...`
URLs are ambiguous and 404. To download the bundle without cloning, use the API:

```bash
curl -sS -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/AtomicBot-ai/atomic-agent/contents/archive-unpublished-2026-08-17/atomic-agent-unpublished-2026-08-17.bundle?ref=archive/unpublished-2026-08-17" \
  -o atomic-agent-unpublished-2026-08-17.bundle
```

## Patches

The `.patch` files are `git format-patch` output for the two smaller branches, kept
alongside the bundle so the diffs are readable in the GitHub UI without cloning.
Apply with `git am < file.patch`. The desktop branch's series (85 patches, 1.6 MB)
is not included — use the bundle for that one.

## Known caveats

- The desktop app needs **Node 25**; `apps/desktop/src/main/resolve-agent-node.ts`
  refuses anything older, and the SEA build needs `mainFormat: "module"`.
- `better-sqlite3` compiled under Node 22 does not error under Node 25 — it *hangs*
  when the profile store opens the DB, and the desktop shell then waits forever
  for a ready-ping that never comes, so no window is ever created. If bootstrap
  stalls right after `starter-skills: installed global skills`, run
  `npm rebuild better-sqlite3` under Node 25.
- The WIP branch was a dirty working tree, not a curated commit. Expect loose ends.
