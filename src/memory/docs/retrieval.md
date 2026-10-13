# Memory retrieval and prompt context

Status: current
Owner: src/memory/

## Read path

MemoryStore owns bounded SQLite notes and FTS5 recall. The context provider retrieves notes and an index before the turn's steps, filters index entries already recalled, and can expand linked neighbors without duplicating note ids. Optional vector recall is gated by embedding configuration; unavailable optional components must retain the intended fallback. Every embed call names its purpose: `document` when a note is written, `query` for recall, `similarity` for the rewriter's embedding gate. A model with task prompts in its catalog entry (EmbeddingGemma 2) gets the matching prefix; other models receive the text unchanged. A model served by Atomic Core's embedding module is reached through Core's control API and attached only when Core reports it on with the catalog's dimension.

Vectors are keyed by note and model, and recall reads only the attached model's vectors. Hybrid recall (`recallHybridAsync`) blends BM25 with cosine. The context provider's auto-recall and the `memory.notes.recall` tool use it (same output shape as before); the TUI memory search and lessons/procedures recall stay keyword-only. Keyword hits are ranked among themselves by BM25 normalised within the hit set (the strongest scores 1) blended with cosine, and keep their slots. Notes found by meaning alone (no shared word, another language) only fill the slots left, best cosine first, when cosine reaches the model's floor (catalog `minCosine`, default 0.35) and is within 0.15 of the query's best cosine; none when `vectorWeight` is 0. They pass the same working-dir and tag filters as the keyword query; archived notes stay reachable, as they are by keyword. The notes recall tool falls back to keyword recall on any error from the vector side. Recall scans every vector of the model up to `memory.embeddings.bruteForceCeiling` (default 2000); above it, the newest that many plus the keyword hits' vectors, and the overflow is counted. The runtime attaches embeddings with the configured weights and ceiling.

The backfill embeds, newest first, every note with content that has none for the attached model (after a model switch, or when embeddings are turned on over existing notes), through the same writer and `document` purpose as a new note. The runtime runs it in the background after the embedding client is attached, unless `memory.embeddings.backfill` is false: one embed at a time, small batches, a start delay, aborted at shutdown. A model that stops answering ends the run quietly and the next boot resumes it. `atomic-agent memory reindex` runs the same backfill in the foreground through the same client; `--prune` then deletes other models' vectors once every note has one for the attached model. Old vectors are otherwise kept, so switching back needs no re-embed.

The query rewriter is enabled by default and heuristic-gated. Its sub-call uses separate runner/slot/provider posture; it must not change the main turn's sticky provider. Index and recalled previews are bounded prompt slices, not a dump of the durable store.

Profile rendering selects pinned/contextual facts. Lessons and procedures have separate retrieval and token budgets. Prompt assembly owns their ordering; profile/lessons/procedures come after conversation, while memory-index/recalled precede it. Do not use the archived v1 order.

## Sources and tests

- [Store](../memory-store.ts), [context provider](../memory-context-provider.ts), [profile](../profile-store.ts), [renderer](../notes-renderer.ts).
- [Query rewriting](../retrieve/index.ts), [embeddings](../embeddings/index.ts), [embedding backfill](../embeddings/embedding-backfill.ts), [model connection](../embeddings/memory-embedding-connection.ts), [links](../links/index.ts).
- [Backfill tests](../embeddings/embedding-backfill.test.ts), [`memory reindex`](../../cli/memory-command.ts).
- [Store tests](../memory-store.test.ts), [context tests](../memory-context-provider.test.ts), [prompt assembly](../../prompt/docs/assembly.md).
