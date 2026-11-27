# Git tools and remote credentials

Status: current
Owner: src/tools/os/git/

Git read and remote-mutation operations have different resource/approval classes. Preserve subprocess argument handling, host/path validation, credential headers and scope of destructive operations. Credentials must not persist in remote URLs or tool summaries.

A model-supplied revision, range, remote, branch or URL that starts with `-` is refused before git runs ([git-arg-guard.ts](git-arg-guard.ts)); paths always go after `--`. Git would otherwise read the value as an option, such as `--output=<file>` on a read-only `show`.

Read [tool instructions](../../AGENTS.md), [Git API helpers](../../../github/README.md), [git registry](index.ts), and adjacent git tests. Remote fetch/pull/push/clone behavior must be checked separately from read-only status/diff/log.
