# Core filesystem operation contracts

Status: current
Owner: src/tools/os/fs/

## Responsibility and consumers

The 13 operations read/list/glob/grep/hash/diff/watch/write/edit/patch/trash/restore/locate_project each have an adjacent import-free `fs-*-contract.ts`. These own name, description, readonly, resourceClass, descriptor and argsJsonSchema. Execution selects definition metadata; prompt descriptor-A/schema map and agent taxonomy select their projections explicitly. Preserve positions, property/required/enum order, optional tier omission and exact model-facing strings. There is no generated registry or aggregate barrel.

[Hash](../fs-hash-contract.ts) was the prototype; the other twelve follow its shape. Archive and document extraction have separate execution/backend owners and are outside this canonical family. [OS composition](../../README.md) remains the sole registration recipe.

## Runtime argument boundaries

Pure argument types and parsers for [read](../fs-read-contract.ts), [list](../fs-list-contract.ts), [hash](../fs-hash-contract.ts), [diff](../fs-diff-contract.ts), [edit](../fs-edit-contract.ts), [write](../fs-write-contract.ts), [trash](../fs-trash-contract.ts) and [restore](../fs-restore-contract.ts) live with the contract. List execution imports the same extension normalizer and listing budget, rather than copying them. Diff execution passes its existing node:path.basename into the pure parser; invoke it at the original validation positions.

Five parsers remain in execution deliberately: [glob](../fs-glob.ts) and [grep](../fs-grep.ts) apply home/platform path policy; [locate_project](../fs-locate-project.ts) uses discovery normalization; [watch](../fs-watch.ts) awaits stat before reading options; [patch](../fs-patch.ts) reads a patch file before late options. Do not import these effects into a contract or capture option getters earlier. JSON Schema advertises the wire shape; it does not replace runtime coercion, contextual checks, approval, input protection or restoration.

Write retains eager path/content reads before validation and permissive mode fallback; trash retains coercion and array limits; restore validates path before consulting the injected store. Hash accepts null defaults and uppercase algorithms beyond its advertised lowercase enum. Existing error precedence and getter reads are observable behavior.

## Policies and resources

Role predicates, read-target mapping, approval categories and batch scheduling remain explicit at their current owners. Builder excludes trash and locate_project; orchestrator permits bounded project discovery. locate_project intentionally has no generic READ_TOOL_TARGETS entry. No metadata field grants permission to mutate or expand scope. Execution continues to own IO, handles/watchers, restore state and compressed results; the move changes no persisted path or format.

## Checks and limits

Run `npx vitest run src/tools/os/fs src/tools/tool-contract-conformance.test.ts src/runtime/tool-contract-composition.test.ts` with disposable fixtures. Include existing agent batching/read-coverage, roles/discovery, prompt and native-wire seam tests for interface changes. Run lint, test type debt gate, imports and docs checks. The dependency checker rejects all imports from any filesystem contract, including type-only, bare package and dynamic imports.

[Global conformance](../../../tool-contract-conformance.test.ts) records real static definitions before ToolRegistry's Map can hide duplicate registration, inventories the private schema map via test-only TypeScript AST and compares the 13 canonical projections. Negative fixtures mutate each facet independently. Other static families get presence/format and taxonomy checks, not a claim of canonical semantic agreement. [Runtime composition](../../../../runtime/tool-contract-composition.test.ts) separates native registration from read-scope replacements and checks feature switches. MCP external schema/replacement/resolver teardown is tested independently.

The three existing Git descriptor duplicates are narrowly frozen; [follow-up](../../../../../docs/proposals/tool-catalog-deduplication.md) describes the behavioral fix. Unit checks establish neither native trash behavior on every platform nor model-quality/performance gains. [Stage 05 acceptance](../../../../../docs/testing/stage-05-validation.md) records baseline comparisons and remaining debt.
