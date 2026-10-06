# Stage 01 acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Plan 01](../plans/01-reliable-checks.md) is verified; test-type debt remains explicit rather than being declared fixed in full.

## Coverage and reviewed debt

tsconfig.test.json now selects every src TS/TSX root and uses repository rootDir for imported scripts. The initial full-program capture contained 970 diagnostics after removing TS6059 through that corrected noEmit scope, compared with the earlier 971 hypothetical full-TSX measurement. It included 2359 roots and all 104 test.tsx files.

The remaining [ledger](test-type-debt.json) contains 947 diagnostics grouped into 550 fingerprints with multiplicity. All are in test files; there are no production-source allowances. MCP's 23 diagnostics were removed and its area now has zero allowances. Review inspected paths, TS codes, repeated messages and the missing-field/mock-signature cases; this snapshot does not prove the runtime semantics of every indebted fixture. Effective strict settings and compiler version 5.9.3 are pinned in the ledger.

The checker rejects new fingerprints/counts, omitted source roots, compiler/options drift and stale resolved entries. Its reduction mode cannot accept growth. Eleven temporary-fixture self-tests passed: original debt, overwrite refusal, new TSX error, an identical repeated fingerprint with count=2, line shifts, valid new TSX, lost coverage, weakened settings, stale allowances, reduction and compiler migration. Fixtures were removed.

## Behavioral tests and CI

- Production lint passed.
- MCP: 11 files, 148 tests passed. Required metadata and typed CompletionRequest spies were restored; complete timing fields replace a cast. Budget fallback is still tested for zero and malformed input missing SDK-required maxTokens.
- Former quarantine: both files passed together, 9 tests, exit 0. Sidecar logic is unchanged. Auto-update keeps the real orchestrator and mocks the paired daemon creation boundary; checked-backend success and exactly-one start are now asserted.
- Full `npm run test:ci`: 1039 files passed, 12425 tests passed, 4 skipped, exit 0. Skips are existing platform/GC conditions in openai-stream-abort.test.ts, archive-safety.test.ts and expand-home.test.ts; neither former quarantine file is excluded.
- Quarantine registry/CI checks and eight temporary-fixture self-tests passed, including unowned/missing/duplicate paths, exact active exclusions, release, scope/reproduction and workflow bypasses.
- docs:check and its eleven self-tests passed; git diff --check passed.

The PR workflow now uses the same registry runner as local test:ci and runs the type-debt gate plus both checker self-tests. No new dependency or lockfile change was needed. The optional-canvas matrix leg was documented, not reinstalled/repeated locally; hosted GitHub Actions have not been run in this task.

## Environment limitations encountered

The installed better-sqlite3 addon initially targeted ABI 147 while pinned Node 25.7 uses ABI 141. Rebuilding that existing addon offline against cached Node headers repaired the local setup; package versions and the lockfile stayed unchanged.

The first full suite in the restricted sandbox was interrupted: loopback servers failed with listen EPERM and caused timeouts. Its output is not evidence of passing behavior. The completed full run was authorized with local-server permissions. Unit-test daemon creation remains mocked and no model was downloaded.

## Source scope and practical limits

Against the original HEAD, executable TS token changes are confined to six test files: the stage-00 defaults-routing exception, four MCP fixtures and the auto-update test. Production TS changes remain documentation comments. No runtime API, algorithm, prompt literal or config default changed.

The remaining 947 diagnostics still reduce trust in their existing fixtures; the gate prevents growth, not all debt. Identical file/code/message/span/multiplicity cannot distinguish every semantic replacement, and suppression/removal of tests still needs review. Production lint and behavioral tests remain mandatory. See [local CI](local-ci.md) for exact commands and safe debt reduction.
