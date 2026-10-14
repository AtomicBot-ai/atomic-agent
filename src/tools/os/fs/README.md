# Filesystem tools and safety mechanisms

Status: current
Owner: src/tools/os/fs/

This area implements filesystem operations and the guards used by their mutations. Read the [tool instructions](../../AGENTS.md), [tool contracts](../../docs/contracts.md) and [OS composition guide](../README.md) before changing a dispatch contract. [The OS registry](../index.ts) constructs and registers these definitions; this directory has no separate registration barrel.

## Operations and entry points

- Read and discover: [read](fs-read.ts), [list](fs-list.ts), [glob](fs-glob.ts), [grep](fs-grep.ts), [hash](fs-hash.ts), [diff](fs-diff.ts) and [watch](fs-watch.ts). The [read-coverage contract](fs-read-coverage.ts) is shared with the agent's repeated-read detector: resolved identity, visible content digest and actual line coverage belong to the result, rather than being reconstructed from requested arguments. Glob walks in-process under a [walk budget](fs-walk-budget.ts) (wall clock and scanned entries) and returns partial results with a leading note when it runs out; its [pattern compiler](fs-glob-pattern.ts) lives beside it. Grep is bounded by ripgrep's own timeout instead, and [keeps the matches found before it](fs-grep-timeout.ts) with the same kind of leading note; its [argument parsing](fs-grep-args.ts), [ripgrep JSON parser](fs-grep-ripgrep-json.ts) and [result shaping](fs-grep-format.ts) live beside it.
- Mutate and recover: [write](fs-write.ts), [edit](fs-edit.ts), [patch](fs-patch.ts), [move](fs-move.ts), [trash](fs-trash.ts) and [restore](fs-restore.ts). Edit diff and patch preview helpers keep rendering/dry-run reporting beside the operation. Restore copies precede qualifying replacements; advisory parse/content warnings do not invent an atomic rollback.
- Move/rename: [the planner](fs-move-plan.ts) checks every item before the single approval (source present, no silent replacement, no folder into itself, no order-dependent batch), then [the move](fs-move.ts) renames in order with a copy-and-remove fallback across volumes and creates missing parent folders. A `to` ending in a separator, or naming an existing folder, means "inside it". Undo is the reversed move list in the result; a file replaced with `overwrite: true` is saved to the restore store first. Sources count as read targets for read scope, since a move could otherwise carry an outside file into the workspace, and a moved folder that holds the agent's config or `.env` is classified `trust_config`. Across volumes the copy lands under a temporary name beside the destination and is renamed into place, so a failed copy never touches the file being replaced. [Card and result wording](fs-move-text.ts) lives beside it.
- Locate a project: [location](fs-locate-project.ts) and [known sources](fs-locate-project-sources.ts) search the working directory and ancestors, recent session directories and direct children of configured project roots. Ambiguity remains an ambiguity; the operation does not crawl the whole disk. [Project test helpers](fs-locate-project-test-helpers.ts) are fixtures, not a runtime API.

[Archive](../archive/) and [document readers](../read-document/) retain separate owners. Path/home expansion remains shared in [expand-home](../expand-home.ts).

## Core operation contracts

Each of the 14 operations above has an import-free `fs-*-contract.ts` owner for definition metadata, descriptor, JSON schema and resource class. Execution, prompt and taxonomy select explicit projections at their existing positions. Role admissions, read targets and approval policy remain separate. [The contract guide](docs/contracts.md) maps pure parsers and the intentional contextual validation boundaries; adding an import to any contract fails the dependency check.

The advertised wire schema does not replace runtime validation. For example, hash accepts null defaults and uppercase algorithms while encoding remains case-sensitive. [The global conformance test](../../tool-contract-conformance.test.ts) checks real registrations before registry Map replacement, all 14 canonical projections and independent negative fixtures. [The runtime test](../../../runtime/tool-contract-composition.test.ts) distinguishes optional registration from metadata-preserving read-scope decoration. Archive and document-reader contracts remain separate owners.

## Guards, state and resources

[Approval scope](fs-approval-scope.ts) classifies destinations; [approval routing](fs-require-approval.ts) passes those facts to the injected approval gate. A write may be retargeted by the operator, so its guards must run against the destination actually approved. Trust-config paths are injected by the composition layer. Read-scope enforcement and agent batching policies remain outside these individual definitions.

[Input guard](fs-input-guard.ts) checks the original operator request and declared worker inputs before replacing a file. [DeclaredInputsRegistry](fs-declared-inputs.ts) owns the in-memory session-to-input map; the worker runner declares and clears its entries. [Replacement guard](fs-replace-guard.ts) distinguishes files created by this session from the user's files and announces saved or unsaved prior content. These mechanisms have different purposes and must not be substituted for approval.

[FileRestoreStore](fs-restore-store.ts) owns persisted copies and session-created paths; [manifest helpers](fs-restore-manifest.ts) own their disk records and writes. The registry injects the store under the state directory. Copies are shared by working directory, while the created set belongs to a session. Operations within one store serialize index updates; concurrent processes can still race on a manifest, so this is not a cross-process transaction system. Moving the source directory does not change any persisted path or format.

[Parse checks](fs-parse-check.ts) and [content checks](fs-content-check.ts) own advisory diagnostics and their conservative skip conditions. Read file handles close in the operation's cleanup; watch owns its bounded one-shot watcher and closes it after collection; grep runs through the injected command runner. Trash delegates to platform trash facilities, rather than silently becoming permanent deletion.

## Validation

Run `npx vitest run src/tools/os/fs` on temporary directories and mocks. Include `src/tools/os/os-tools.test.ts`, affected approval/declared-input/read-coverage seams and `src/agent/tool-resource-class.test.ts` when a shared contract changes. Then run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`; the [development guide](../../../../docs/development.md) explains the existing type debt. Unit tests do not establish native trash behavior on every platform or authorize mutations of personal files.
