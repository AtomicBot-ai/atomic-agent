# PR integration validation

Status: verified
Owner: repository maintainers

The completed eight-stage reorganization was committed as `18876092`, based on `cce6262c`. Before opening its PR, `origin/main` had advanced through six commits to `a8afe9638`. Integration keeps those upstream behaviors in the extracted owners: approval batch barriers and declined-call memory, stopped-turn transcript markers, grounded profile names, interrupted task recovery and bounded task shutdown, trace route stamping, pure prompt preview, local fallback availability, fusion slot release/watchdog, HTTP keepalive, and Windows backend/shell support.

Pure coding-mode policy now belongs to `src/approval/coding-mode.ts`; the TUI path re-exports it for compatibility and HTTP consumes the shared owner. Upstream tool descriptions are projected through the existing canonical contracts. Fresh upstream guide snapshots are preserved in [the archive](../archive/2026-10-06/README.md). New improvements proposed after the reorganization are outside this PR.

## Checks after integration

- Production `lint` and `build` passed on Node 25.7.0.
- Documentation and dependency checks passed: 246 active Markdown files, 19 instruction files, maximum instruction chain 8093/24576 bytes; 1451 production modules, 5440 local edges, zero runtime cycles or exceptions.
- Document self-test passed all 11 checks; import self-test passed all 242 fixtures. Quarantine registry: zero active, two released.
- Process smoke passed all 13 scenarios using the built CLI/sidecar, real filesystem tools and SQLite, and a scripted loopback HTTP/SSE model. [Report](evidence/pr-integration/report.json), [console](evidence/pr-integration/smoke.log), [protocol](evidence/pr-integration/sidecar.ndjson), [stderr](evidence/pr-integration/sidecar.stderr.log). The backend proves protocol/execution behavior, not live-model quality.
- Test type coverage: 2543 source roots, 106 test TSX; affected upstream fixtures were completed without suppressions. The non-growing ledger decreased from 848 to 777 existing diagnostics; no new errors.
- Initial full run: 1110 suites passed, 13452 tests passed, four existing skips. A new upstream approval test had stale filesystem/shell imports; a download progress test depended on wall-clock timing under load. These failures are recorded here rather than hidden; the final rerun is recorded below.

Final full rerun passed all 1112 suites: 13463 tests passed, four existing skips. Production lint remained green. Type-checker self-test passed 11 checks; quarantine self-test passed eight checks. [Full-run log](evidence/pr-integration/full-tests.log).

Stage acceptance and comparative-agent evidence in the [roadmap](../plans/project-reorganization.md) describe the pre-integration snapshot. The checks here establish the integrated version. Real Windows execution and live-model quality were not rerun during PR preparation.
