# Build and maintenance scripts

Status: current
Owner: scripts/

Read [AGENTS.md](AGENTS.md) before script changes. [Bundling](docs/bundling.md) owns SEA/assets/signing/release details. [Document checker](check-docs.mjs) is offline and validates active documentation; its self-test uses temporary fixtures. TypeScript script checks use tsconfig.scripts.json; production lint excludes scripts. Do not invoke release/signing/upload scripts merely to check documentation.

[Test types](check-test-types.mjs) reject new diagnostics against the explicit ledger; [self-test](check-test-types.selftest.mjs) uses temporary fixtures. [Test runner](run-tests.mjs) shares the quarantine registry with CI; [registry self-test](run-tests.selftest.mjs) verifies exclusions and workflow checks. See [local verification](../docs/testing/local-ci.md).

[Import checker](check-imports.mjs) resolves production dependencies with TypeScript, checks ownership even for type-only imports, and rejects runtime cycles. [Self-test](check-imports.selftest.mjs) uses disposable projects. [Boundary policy](../docs/architecture/import-boundaries.md) records scope and limitations.

[Offline process smoke](smoke-e2e.mjs): after `npm run build`, run `npm run smoke:e2e` (optional `-- --output /tmp/atomic-e2e-report`). It starts actual built CLI/sidecar processes, a loopback scripted LLM server and disposable state/workspaces. Assertions cover tools, approvals, streaming, repair, FIFO, steering, cancellation, persistence and clean exit. No credentials or model downloads are needed. It requires permission to bind localhost. See [the smoke report](../docs/testing/e2e-smoke.md) for the separately performed CLI, native provider and PTY checks and the limits of canned completions.
