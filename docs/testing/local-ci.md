# Local verification and test debt

Status: current
Owner: repository maintainers

## Default-install PR gate

Use the lockfile and Node 25.7 (the pinned Volta and CI version). In the normal installation, the commands matching the standard PR job are:

```sh
npm ci
npm run docs:check
npm run docs:check -- --self-test
npm run imports:check
npm run imports:self-test
npm run lint
npm run typecheck:tests
npm run typecheck:tests:self-test
npm run quarantine:check
npm run quarantine:self-test
npm run test:ci
```

[Dependency checking](../architecture/import-boundaries.md) rejects ownership violations, unresolved local targets and runtime cycles, including type-only ownership dependencies. Production lint requires zero errors. Test typechecking covers every src TS/TSX root and the files it imports, including test.tsx files. It permits only the concrete diagnostics in [the debt ledger](test-type-debt.json); this is not a declaration that every test is type-correct. `typecheck:tests:raw` prints the entire debt and returns nonzero while errors remain. Scripts not imported into this program still have tsconfig.scripts.json; eval typechecking retains its separate configurations.

For an affected area use `npm run test:ci -- src/mcp/` or a precise existing file. This is a focused run, not equivalent to the full PR gate. Vitest transpilation alone does not validate test types.

## Debt policy

[The checker](../../scripts/check-test-types.mjs) uses the installed TypeScript parser and all pre-emit diagnostics. Each allowed record includes relative file, TS code, normalized message, source-span text and multiplicity. Line numbers provide navigation but do not authorize debt: line shifts preserve a record, a new message/span consumes a new record, and a second identical occurrence consumes another count. The ledger records compiler version, effective options and root inventory at its last capture/reduction. Coverage is checked independently against the current source tree, so a clean new TSX root is allowed and an omitted existing root fails.

After fixing an error, run `npm run typecheck:tests:reduce`; it refuses new diagnostics or changed compiler settings and removes only resolved allowances. Regular checking fails on stale allowances until they are removed. It never trades one error for a different error. Do not edit the ledger to accept new errors, suppress whole files, widen any or weaken strict options. Compiler upgrades/options migrations require a separately explained review; there is no automatic rebase command. The initial --capture mode refuses an existing ledger.

The remaining limitation is explicit: an existing error at an identical span with identical message and multiplicity remains allowed, and these fingerprints cannot prove runtime semantics. Production lint and behavioral tests remain required. Removing tests or adding suppression directives must still be reviewed; a smaller error count alone does not demonstrate a correct fix.

## Quarantine and returns

[The registry](quarantine.json) owns exact paths, subsystem owner, cause, reproduction, observed result and return condition. [The runner](../../scripts/run-tests.mjs) generates exclusions only from status=quarantined and supplies the same arguments to local and PR Vitest. Its --check mode validates targets/metadata and rejects a workflow with manual exclusions or a direct test-command bypass. The initial two records are released, so neither is excluded now. `npm run test:quarantine` reruns the recorded files, including released history.

Sidecar concurrency passes in the current source; the former third-inference comment is not an established current failure. Auto-update mocks paired process creation while exercising the actual orchestrator and asserting success/exactly-once behavior. An assertion count with unhandled errors or a nonzero exit is a failed run. Do not launch a real llama-server to reproduce unit-test quarantine.

## Optional-canvas PR job

The second PR matrix leg removes only @napi-rs/canvas and runs src/tools/os/read-document/. Reproduce it in a separate temporary checkout/install: npm ci, remove that one optional package there, confirm it is absent, and run `npm run test:ci -- src/tools/os/read-document/`. Do not remove optional dependencies from the normal working installation or use npm ci --omit=optional: that would remove Vitest's platform binary too. This leg does not repeat the standard type/debt check.

## Native addon compatibility

If better-sqlite3 reports NODE_MODULE_VERSION mismatch, tests have not reached the behavior under investigation. Use the project's pinned Node to install/rebuild that existing dependency, then rerun. During stage 01, the local addon was rebuilt offline against cached 25.7 headers; no package/lockfile version changed. Keep this setup repair separate from claims about test correctness.
