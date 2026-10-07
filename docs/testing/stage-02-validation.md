# Stage 02 acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Plan 02](../plans/02-dependency-boundaries.md) is verified. [Boundary ownership](../architecture/import-boundaries.md) records the final module owners and the deliberately limited rule set.

## Provider persistence

The former TUI persistence module and its 15-test suite moved to src/config/llm-provider-commands.ts and its adjacent test. Channels, providers, fallback and run-mode consumers, including test mock targets, now reference that owner. The module imports concrete config modules and has no UI dependency, including type dependencies. No compatibility forwarding module remains.

ProviderCredentialKind preserves the six accepted values and their existing dotenv mapping. The wizard's union is structurally identical, so calls need no runtime conversion or cast. Validation, trimming, credential permissions, immediate process.env updates, active-provider removal refusal, run-mode/fallback pin cleanup, model rollback and write/reset ordering are unchanged. Live hot-swap remains in the callers.

## UI dependencies

All three previously identified runtime SCCs are absent. Geometry and printable-input policy are independent shared modules; the generic list receives callbacks, while the provider adapter owns wizard routing and paste. Mouse callbacks still capture the displayed wizard and dispatch through the existing keyboard route. Wait/jump status and row count moved to onboarding selectors. Composer row contracts and common provider/loading selectors moved to an independent module used by both row builders.

An AST comparison against a source snapshot taken before stage 02 confirmed 33 relocated declarations are unchanged apart from the neutral credential type name. Another 111 declarations in edited callers/remaining owners are unchanged. The list extraction intentionally replaces wizard parameters with equivalent callbacks; render, keyboard and mouse tests cover that seam. Existing test edits are import/mock-target relocation and the relocated suite's name, without weaker assertions. The test-debt ledger is byte-identical to the stage-02 starting snapshot; no fingerprint migration or new allowance was necessary.

## Automated gates and tests

- imports:check: 1345 production modules, 4846 local edges, zero runtime SCCs, one reviewed ownership exception. All three original cycles are removed, with no cycle allowance.
- imports:self-test: 25 disposable fixtures pass, including TS/TSX .js resolution, static/dynamic/self cycles, missing type/runtime targets, mixed/type-only edges, domain/channel/HTTP boundaries, UI primitives, composition root, excluded tests, JSON and exception metadata/staleness.
- lint: zero production TypeScript errors. typecheck:tests: 2364 TS/TSX roots, 104 test TSX, 947 explicitly recorded diagnostics and no new errors.
- Focused provider/wizard runs: 4 files/66 tests and 21 files/318 tests pass. Focused onboarding/composer run: 12 files/167 tests pass.
- Full test:ci: 1039 files pass; 12425 tests pass and 4 existing platform/GC cases skip; exit 0. This includes Telegram and Discord model-command suites (36 and 35 tests), provider persistence, fallback/run-mode, daemon restart and route-adoption seams. No active quarantine exclusions.
- docs:check and 11 negative checks pass; type-debt self-test (11) and quarantine self-test (8) pass. The quarantine/workflow check and git diff --check pass. New scripts pass node --check.

Full-suite loopback servers require permissions outside the restricted sandbox; the completed run used those permissions. No actual model download or daemon was introduced by this work. The hosted GitHub workflow and optional-canvas installation leg were not run here. The default PR job now invokes both import checks; no dependency or lockfile version changed.

## Remaining boundaries and limitations

Preparing stage 03 revealed src/http/route-mcp.ts → src/tui/persist-mcp-server.ts, an existing shared MCP persistence dependency outside the stage-02 provider scope. It is now explicitly guarded by the HTTP rule and recorded as one exact edge owned by src/http/, with removal assigned to stage 03a. Other HTTP-to-TUI edges fail, and the checker fails when this allowance becomes stale. This is not a runtime cycle. The CLI entry-to-TUI entry composition edge is intentionally allowed and is not a ledger exception.

The checker handles static and literal dynamic local references, not computed targets, require() or plugin loading. Its ownership rules are explicit; zero unchecked violations does not claim all project boundaries are ideal. Existing test debt remains 947, and manual terminal behavior has not been revalidated on every platform. Broad TUI organization, MCP persistence movement, runtime assembly and provider SDK algorithms remain outside stage 02.

Subsequent state: [stage 03a](stage-03a-validation.md) removed the recorded MCP HTTP-to-TUI exception by moving persistence to config. The counts above describe stage 02 acceptance, not the later graph.
