# Tool discovery, schemas and guards

Status: current
Owner: src/tools/

## Definition and dispatch

ToolRegistry owns explicit definitions and invocation. A new tool must be registered, described in the prompt catalog, assigned an argsJsonSchema and resource class, and validated by its runtime parser. Text and JSON schemas remain distinct representations; a canonical owner groups their shipped values without inventing a schema generator.

[The 14 core filesystem contracts](../os/fs/docs/contracts.md) own descriptor, wire schema, definition metadata and class without imports. Pure parsers share those owners; IO/path-policy validation stays in execution. Consumers select projections explicitly, preserving serialized order and text. [Global conformance](../tool-contract-conformance.test.ts) joins real static registrations before Map replacement with descriptor/schema/class inventories. It proves canonical agreement for these 14 tools, and presence/format plus actual taxonomy lookup for the other built-ins. Independent fixtures detect missing, orphan, duplicate and changed canonical facets; there is no catalog-wide generator.

Every descriptor name is unique, with no exemption: the three old Git duplicates were removed by ATO-1296 ([follow-up](../../../docs/proposals/tool-catalog-deduplication.md)). Static registrations have no duplicate exemption either. ToolRegistry replacement remains intentional for read-scope decoration and dynamic MCP lifecycle, each tested separately.

Both reply and finish have static descriptors and schemas. The native adapter supplies terminal wire overrides and may include them beyond a role's visible catalog. Conditional registration (browser/memory/tasks/vision/screen), descriptor-only availability (web/email/GitHub/fusion/image/video), four static MCP meta tools and server-qualified external schemas have explicit owners in the conformance tests. Do not infer roles or batching permission from readonly metadata.

The hash wire enum advertises lowercase algorithms; runtime replay/direct invocation retains uppercase algorithm normalization and null defaults. Encoding is case-sensitive and empty paths fail at runtime. Shared metadata does not turn JSON Schema into a replacement for domain/security validators.

Roles builder/orchestrator/full shape prompt descriptions, native schemas and grammar membership. A rare or out-of-role tool can be loaded through tool.view; its description belongs outside the stable prefix (local tail or cloud context update). A session load does not authorize bypassing dispatch policy. Static catalog order affects prompt bytes.

`ToolContext.modelMode` is resolved from the serving inference link. The registry preserves complete obtained text in cloud results; local compressor and batch caps remain unchanged. Browser cloud snapshots omit presentation clipping/noise filtering, MCP projectors omit text caps, and web fetch omits its default character preview cap while respecting an explicit requested cap. Process capture, transport/body limits, file ranges, timeouts, approvals and read scope remain enforced at their existing boundaries. This does not fetch an entire filesystem or memory database automatically. [The compressor](../../compressor/README.md) and [cloud seam tests](../../agent/cloud-context-seam.test.ts) describe the output path.

## Guards and file safety

Unknown argument and control-marker guards act before dispatch. A few alias shapes small models send are read as the canonical form instead (`argument-aliases.ts`, today only `os.fs.move` `paths`/`sources`/`src`/`source` with `destination`/`dest`/`target`): the registry rewrites them before any wrapper sees the call and the result ends with a one-line note (recorded calls keep the alias keys; their readers go through `canonicalArgs`); an alias beside a canonical key is still refused, and the schema stays canonical. On the way back, a tool that sets `untrustedOutput` (web fetch and search, `os.http.request`, MCP tools, MCP resources and prompts, `browser.navigate`, `browser.read_aria`, `browser.tabs`, `browser.extract`) gets its summary framed as external data by `ToolRegistry.invoke`: a framing line, then the text inside a `<<<UNTRUSTED EXTERNAL CONTENT nonce>>>` … `<<<END UNTRUSTED EXTERNAL CONTENT nonce>>>` fence, chat-template markers neutralised, copies of the nonce removed and fake fences defused (`untrusted-text.ts`, shared with the risk reviewer; ATO-1378). The browser page in `### world` is framed the same way when rendered, and a page too long for the section is cut inside the fence so the closing marker stays. The nonce is an HMAC of the text under a key made at start-up: the same text gives the same bytes in one process, and a page cannot predict it. Read-scope uses working-directory and user-named roots. Declared input files have replacement protections and a restore path; workers cannot decide to replace the user's declared inputs. Shell commands that outlive the default timeout can become detached jobs; explicit wait/kill/jobs have different intent.

Reply attachments are validated regular files, resolved to absolute paths, deduplicated and bounded before a reply succeeds. Consumers use result paths and deliver the same optional attachment field across TUI, sidecar and chat channels.

## Sources and tests

- [Registry](../tool-registry.ts), [roles](../tool-roles.ts), [resource classes](../../agent/tool-resource-class.ts), [batch contract](../../agent/docs/batching.md).
- [Descriptors](../../prompt/tool-descriptors.ts), [JSON schemas](../../prompt/default-tool-args-schemas.ts), [strict wire rules](../../llm/docs/profiles.md).
- [Roles tests](../tool-roles.test.ts), [schema coverage](../../prompt/default-tool-args-schemas.test.ts), [reply](../conversation/reply.ts), [reply tests](../conversation/reply.test.ts).
