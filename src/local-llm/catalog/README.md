# Model catalog, Hugging Face references and GGUF metadata

Status: current
Owner: src/local-llm/catalog/

This area owns model identity/definitions, Hugging Face lookup and bounded GGUF metadata interpretation. Read the inherited [local-llm instructions](../AGENTS.md). [Public exports](../index.ts) remain at the root; [backend-paths.ts](../backend-paths.ts) owns persisted asset paths. Source-directory moves do not rename models, jobs or data on disk.

## Sources and state

- [models-catalog.ts](models-catalog.ts) owns curated chat/embedding definitions, defaults and custom model IDs. Config supplies the existing process-local custom-model list; persistence stays with config. Preserve identity walls and catalog order because other callers resolve models and capabilities through these definitions.
- [huggingface-ref.ts](huggingface-ref.ts) parses repository/revision/file references; [huggingface-api.ts](huggingface-api.ts) owns API/token requests and cancellation; [huggingface-resolve.ts](huggingface-resolve.ts) builds offered file choices. [huggingface-fit.ts](huggingface-fit.ts) classifies shards/projectors/MTP/full-precision files and RAM warnings, while [huggingface-model-def.ts](huggingface-model-def.ts) creates custom definitions. Warning is distinct from rejecting a file.
- [huggingface-endpoint.ts](huggingface-endpoint.ts) owns normalized configured/environment endpoint resolution and request-time canonical URL rewriting. Stored catalog/download URLs stay canonical; config pushes the established endpoint default, and [downloads](../downloads/README.md) reuse the same resolver rather than copying a setting.
- [gguf-metadata.ts](gguf-metadata.ts) reads bounded header metadata, owns prefix-reuse cache/interpretation and supplies KV layout information. It reads metadata rather than loading tensor weights. Its dependency on [server context sizing](../server/context-size.ts) is type-only. Preserve byte/array limits, cache reset and architecture decisions. [gguf-metadata.fixtures.ts](gguf-metadata.fixtures.ts) encodes synthetic test data and is not a production metadata reader.

The root [chat-templates.ts](../chat-templates.ts) intentionally remains separate: development asset resolution depends on source depth and SEA uses the executable asset layout. Catalog metadata can name template assets without owning that resolver. Existing template tests do not establish real package asset coverage when no catalog entry supplies an override.

## Validation

Run `npx vitest run src/local-llm/catalog` and affected config custom-model/endpoint, LLM profile-manager/invariants, CLI model handlers and TUI onboarding/local-model selection seams. Adjacent suites cover curated definitions, references, endpoint rewrite, file-fit/choices and synthetic GGUF bounds/metadata; API/model-definition helpers have no separate individual suites. Use synthetic files and mocked network responses. No actual HF request, model download or hardware capacity validation is implied. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check` after shared integration.
