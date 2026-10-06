# Runtime grammar visibility and lifecycle follow-ups

Status: proposal
Owner: src/runtime/

[Stage 06](../plans/06-runtime-composition.md) preserves behavior while separating assembly. These findings require separate behavior changes and are not acceptance blockers for the mechanical extraction.

The public runtime.grammar property is a boot snapshot. MCP refresh updates the grammar read by AgentLoop, while the local profile manager has its own grammar state. Decide whether consumers need a live public grammar or an explicitly named snapshot; first inventory readers and add MCP add/remove plus model-profile tests. Converting the existing property to a getter changes its property descriptor and requires a deliberate compatibility decision.

Startup has no universal rollback. Failure after opening a store can leave that store open; factory-internal partial allocations also require cleanup at their own owner. Before adding rollback, distinguish owned connections from borrowed notes-store handles and process-wide deadline/error handlers. Test failures at every acquisition boundary with actual disposable resources rather than assuming a reverse list closes everything safely.

Normal shutdown starts scheduler stopping but closes session and memory stores before awaiting the scheduler and stopping consolidation. It does not guarantee all producers have settled before every store closes. A concurrent second shutdown returns immediately rather than waiting on the first completion. Any change must preserve interrupted-turn recording, cancelled-turn grace, channel ordering and task report ownership while explicitly testing the intended new contract.

Naming keeps its unref'd deadline timer after early completion. Provider shutdown has no registry-wide close operation. Address these only with a concrete resource or behavior requirement; do not imply they were fixed by moving construction into components. Current ownership and order remain documented in [runtime lifecycle](../../src/runtime/docs/lifecycle.md).
