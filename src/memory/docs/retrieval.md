# Memory retrieval and prompt context

Status: current
Owner: src/memory/

## Read path

MemoryStore owns bounded SQLite notes and FTS5 recall. The context provider retrieves notes and an index before the turn's steps, filters index entries already recalled, and can expand linked neighbors without duplicating note ids. Optional vector recall is gated by embedding configuration; unavailable optional components must retain the intended fallback.

The query rewriter is enabled by default and heuristic-gated. Its sub-call uses separate runner/slot/provider posture; it must not change the main turn's sticky provider. Index and recalled previews are bounded prompt slices, not a dump of the durable store.

Profile rendering selects pinned/contextual facts. Lessons and procedures have separate retrieval and token budgets. Prompt assembly owns their ordering; profile/lessons/procedures come after conversation, while memory-index/recalled precede it. Do not use the archived v1 order.

## Sources and tests

- [Store](../memory-store.ts), [context provider](../memory-context-provider.ts), [profile](../profile-store.ts), [renderer](../notes-renderer.ts).
- [Query rewriting](../retrieve/index.ts), [embeddings](../embeddings/index.ts), [links](../links/index.ts).
- [Store tests](../memory-store.test.ts), [context tests](../memory-context-provider.test.ts), [prompt assembly](../../prompt/docs/assembly.md).
