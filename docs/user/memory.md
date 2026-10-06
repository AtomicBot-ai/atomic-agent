# Using durable memory

Status: current
Owner: src/memory/

Memory is separate from the chat transcript. Profile facts, freeform notes, links, lessons and procedures live in bounded local stores. The prompt gets selected facts, recalled previews and indexes rather than the entire store.

Use the TUI Memory area to inspect/manage the stored channels. Notes can be recalled explicitly through memory tools; profile facts have history. Reflection can form facts/notes after turns, so it can be asynchronous rather than an immediate echo of the last message.

Current defaults enable profile, notes, reflection, recall/index injection and query rewriting. Embedding recall, typed-note extraction and segmented reflection are optional and disabled by default. Installed configuration can differ after overrides/migration; inspect your actual settings before diagnosing behavior.

Deleting a chat is not the same operation as deleting durable memory. Review what the selected memory operation changes. Do not store secrets as facts.

For implementation work read [memory](../../src/memory/README.md), [retrieval](../../src/memory/docs/retrieval.md), [formation](../../src/memory/docs/formation.md), and [configuration](../../src/config/docs/compatibility.md).
