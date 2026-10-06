# Stage 03a MCP acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. The MCP slice of [plan 03](../plans/03-tui-organization.md) is verified; the whole TUI organization stage remains in progress. [The feature guide](../../src/tui/mcp/README.md) is the current navigation entry.

## Owners and mechanical moves

Five MCP views moved unchanged from tui/components to tui/mcp. State/actions/reducer/keys/orchestrator were already in that feature. DebugPane points to the new panel. Shared persistence and its 34-test suite moved from tui/persist-mcp-server to config/mcp-server-commands; TUI and HTTP now import that owner directly. Config uses concrete modules, not its own index. Old paths and forwarding modules are absent.

The exact HTTP-to-TUI allowance was removed from import-exceptions.json. imports:check reports 1345 production modules, 4847 local edges, zero runtime SCCs and zero ownership exceptions. Existing HTTP and CLI-composition rules remain enabled; no policy was weakened to make the move pass.

An AST comparison against the source snapshot before this slice confirmed identical declarations in all seven moved source/test files after excluding import paths and comments. Type-erased executable output in HTTP route-mcp, DebugPane and MCP orchestrator is also identical. Prompt literals, config versions/defaults, SDK/transport operations, state/actions and runtime bootstrap are unchanged.

The orchestrator's local type-only dependency contract now derives six manager methods and refreshMcp from AgentRuntime; its bus uses the existing typed emitter's subscribe/emit surface. Full AgentRuntime and existing callers remain assignable, as confirmed by production lint. This test seam does not change global runtime or callback shapes and avoids casting an incomplete runtime fixture.

## Behavior and verification

Eleven new checks were added before relocation, using real config files in temporary state and typed mocks rather than real server processes:

- Orchestrator (6): persistence precedes live add, successful runtime refresh, persisted/live-connect partial success, duplicate config refusal, removal plus detail close when live disconnect fails, same-server toggle/restart busy guard including release after failure, and one refresh interval with detail updates/cancellation. Related behaviors share six cases.
- Panel (5): real Ink layout/hit testing selects then activates through the keyboard route; keyboard Enter opens the same detail; remove confirmation retains its target after a cursor change; busy confirmation consumes submit; add-modal input falls through to the actual MultiLineEditor, submits the buffer and closes on Escape.

Async tests wait for the observable completed panel snapshot, rather than a fixed number of microtasks. No manager process or model is launched by these new tests. Shared callback fixtures include every required member and use the actual TuiState/manager contract.

An initial test type check caught the new panel fixture's inferred mutable row array, which could not accept production's readonly rows. The fixture was corrected to explicit TuiState; no new allowance or suppression was added. Final typecheck:tests reports 2366 roots, 105 test TSX, 947 existing diagnostics and no new errors. The debt ledger is byte-identical to the starting snapshot; moving the clean persistence test required no fingerprint migration.

- Before moves: 4 MCP files, 45 tests pass, including 11 new cases.
- After moves: 7 focused files, 134 tests pass (MCP/config, app keys and DebugPane budget).
- Final new-test check: 2 files, 11 tests pass after replacing the async fixture wait with completed-snapshot observation.
- Final full test:ci: 1041 files pass, 12436 tests pass, 4 existing platform/GC cases skip, exit 0. HTTP route-mcp's five tests pass, covering enable/disable/restart, missing server and authentication.
- Production lint, imports:check, 25 import self-tests, docs:check and its 11 self-tests, quarantine/workflow validation, source comparison and git diff --check pass.

The completed full run uses authorized local loopback listeners, which the default sandbox blocks. Hosted GitHub CI and the separate optional-canvas installation were not executed here. No dependency/lockfile version changed. Existing operator review directories/notes remain untouched.

## Limits and next slice

The 947 diagnostics elsewhere remain debt. Real terminal/platform combinations and external MCP servers were not manually exercised. Existing add/remove modal wording still mentions restart even though successful orchestrator operations apply live; this mechanical slice preserves that copy and does not claim it was corrected. Bus subscription ownership is unchanged; the timer test proves interval cancellation only.

The remaining feature views still live partly in components/. After this acceptance, [plan 03b](../plans/03b-provider-ui.md) specifies providers/LLM presentation ownership and the six existing diagnostics in the seven tests to be moved. Onboarding, local-models UI and the other panels remain planned. This MCP acceptance is not completion of stage 03 as a whole.
