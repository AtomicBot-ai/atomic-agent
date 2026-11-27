# My files index

Status: current
Owner: src/tools/files/

The agent side of "My files" (ATO-1621, epic ATO-980): the folders the person chooses, indexed in the background, searched by the read-only `files.search` tool, managed over `/api/files/*` ([routes](../../http/route-files.ts)). The runtime owns one [FileIndex](file-index.ts) ([composition](../../runtime/composition/runtime-file-index.ts)); the desktop codes to the same route shapes ([types](file-index-types.ts)).

## Pieces

- [Schema](file-index-schema.ts): its own SQLite file, `<stateDir>/files-index.sqlite` (`folders`, `files` with mtime/size/status, `chunks` with PDF page or time offset, `chunks_fts` FTS5, optional `chunk_vectors` per embedding model). Deleting the file loses only the index.
- [Store](file-index-store.ts) and [vector store](file-vector-store.ts): rows are removed child first, so the FTS triggers see every delete. A folder that contains added ones takes them in.
- [Folder checks](folder-validation.ts): `not_absolute`, `too_broad` (disk root, home, `/Users`, system folders, the agent's state dir), `not_found`, `not_a_directory`, `already_added`, `inside_added`.
- [Walker](file-walker.ts): `os.fs.glob`'s default ignores, hidden files and folders, no symlinks, a size cap (larger files count as skipped) and a file cap per folder. It reports folders it could not read and a walk cut at the cap; the indexer then keeps those files instead of treating them as deleted.
- [Text](file-text.ts): `os.fs.read_document`'s extractors (exported from [read-document](../os/read-document/read-document.ts)); PDF output is split on its `--- page N ---` dividers so each chunk keeps its page. Scanned PDFs are skipped (no OCR yet). Photos and audio go through [media-text](../os/media-text/media-text.ts) only when `media.enabled` is set; the runtime has no switch for it yet, so they are skipped.
- [Chunker](file-chunker.ts): about 1000 characters, cut at a paragraph, line, sentence or word, never across a page.
- [Indexer](file-indexer.ts): one serial queue; a pass walks every folder (new or changed by mtime/size become pending, vanished files go), reads pending files one at a time, then embeds chunks the current model lacks. `stop()` aborts the file in hand, which stays pending. Status counts: done when `!running && indexed + failed + skipped === found`.
- [Search](file-search.ts): FTS5 terms (the session search's quoting, AND then OR), blended with cosine over chunk vectors when memory embeddings are on, using memory recall's weights, floor and gap (`memory/embeddings/hybrid-recall.ts`). Embeddings come from the model memory has attached now, and only when it runs on this machine.
- [sqlite-vec](file-vec-extension.ts) (ATO-1052): not a runtime dependency; a pinned devDependency (ATO-1658) so `npm ci` and CI run the vec0 tests, which fail in CI when it does not load on a target it has a prebuilt for. The SEA bundle keeps it external. When the `sqlite-vec` package can be imported at runtime it is loaded into the index connection and a [vec0 mirror](file-vec-index.ts) (one table per model and dimension) picks the cosine candidates for whole-index searches; they are re-scored with the exact cosine from `chunk_vectors`, so a stale mirror row costs a slot, never a wrong score. The mirror is resynced when its row count differs from `chunk_vectors`. A missing package, a failed load or any vec0 error falls back to the bounded scan; a `folder`-scoped search always scans.
- [Reranker](file-rerank.ts) (ATO-1052): off by default. `ATOMIC_AGENT_RERANK_URL` naming a local server (llama-server `/v1/rerank` style; a remote URL is refused, file text stays local) re-orders a pool of up to 40 blended hits by their full chunk text, and the best `topK` are kept with the reranker's score. Any failure keeps the blended order.
- [Citation](file-cite.ts): `[report.pdf, p. 12](file:///…/report.pdf#page=12)`, `[call.m4a, 1:23](file:///…/call.m4a#t=83)`, `[notes.md](file:///…/notes.md)`; the path is RFC 8089 percent-encoded, with parentheses and brackets escaped for markdown.
- [Tool](files-search-tool.ts): `files.search { query, folder?, topK? }`, resource class `pure_read`, rare tier, framed as untrusted output. A `folder` argument goes through the read scope like any read (`read-scope-targets.ts`); without it the search covers only the folders the person added.

## Not yet

OCR of scanned PDFs, timestamps in transcripts, a setting for photos and audio, a file watcher (changes are picked up on the next pass: boot, or a folder added), reranking memory recall, a folder filter inside the vec0 query.

## Validation

`npx vitest run src/tools/files src/http/route-files.test.ts src/tools/tool-contract-conformance.test.ts`.
