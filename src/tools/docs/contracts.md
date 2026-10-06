# Tool discovery, schemas and guards

Status: current
Owner: src/tools/

## Definition and dispatch

ToolRegistry owns explicit definitions and invocation. A new tool must be registered, described in the prompt catalog, assigned an argsJsonSchema and resource class, and validated by its runtime parser. Text and JSON schemas remain distinct representations; a canonical owner groups their shipped values without inventing a schema generator.

[The 13 core filesystem contracts](../os/fs/docs/contracts.md) own descriptor, wire schema, definition metadata and class without imports. Pure parsers share those owners; IO/path-policy validation stays in execution. Consumers select projections explicitly, preserving serialized order and text. [Global conformance](../tool-contract-conformance.test.ts) joins real static registrations before Map replacement with descriptor/schema/class inventories. It proves canonical agreement for these 13 tools, and presence/format plus actual taxonomy lookup for the other built-ins. Independent fixtures detect missing, orphan, duplicate and changed canonical facets; there is no catalog-wide generator.

The catalog currently has 88 entries for 85 names. Three pre-existing Git descriptor duplicates are frozen by exact positions and full ordered fingerprints in that test. New, changed or removed exceptions fail. [Their separate behavioral follow-up](../../../docs/proposals/tool-catalog-deduplication.md) explains why removing them would change prompt bytes and discovery. Static registrations have no duplicate exemption. ToolRegistry replacement remains intentional for read-scope decoration and dynamic MCP lifecycle, each tested separately.

Both reply and finish have static descriptors and schemas. The native adapter supplies terminal wire overrides and may include them beyond a role's visible catalog. Conditional registration (browser/memory/tasks/vision), descriptor-only availability (web/email/GitHub/fusion), four static MCP meta tools and server-qualified external schemas have explicit owners in the conformance tests. Do not infer roles or batching permission from readonly metadata.

The hash wire enum advertises lowercase algorithms; runtime replay/direct invocation retains uppercase algorithm normalization and null defaults. Encoding is case-sensitive and empty paths fail at runtime. Shared metadata does not turn JSON Schema into a replacement for domain/security validators.

Roles builder/orchestrator/full shape prompt descriptions, native schemas and grammar membership. A rare or out-of-role tool can be loaded through tool.view; loaded-tools belongs in the tail. A session load does not authorize bypassing dispatch policy. Static catalog order affects prompt bytes.

## Guards and file safety

Unknown argument and control-marker guards act before dispatch. Read-scope uses working-directory and user-named roots. Declared input files have replacement protections and a restore path; workers cannot decide to replace the user's declared inputs. Shell commands that outlive the default timeout can become detached jobs; explicit wait/kill/jobs have different intent.

Reply attachments are validated regular files, resolved to absolute paths, deduplicated and bounded before a reply succeeds. Consumers use result paths and deliver the same optional attachment field across TUI, sidecar and chat channels.

## Sources and tests

- [Registry](../tool-registry.ts), [roles](../tool-roles.ts), [resource classes](../../agent/tool-resource-class.ts), [batch contract](../../agent/docs/batching.md).
- [Descriptors](../../prompt/tool-descriptors.ts), [JSON schemas](../../prompt/default-tool-args-schemas.ts), [strict wire rules](../../llm/docs/profiles.md).
- [Roles tests](../tool-roles.test.ts), [schema coverage](../../prompt/default-tool-args-schemas.test.ts), [reply](../conversation/reply.ts), [reply tests](../conversation/reply.test.ts).
