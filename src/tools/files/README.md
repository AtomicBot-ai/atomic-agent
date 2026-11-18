# My files index

Status: current
Owner: src/tools/files/

The agent side of "My files" (ATO-1621, epic ATO-980): the folders the person chooses, indexed in the background, searched by the read-only `files.search` tool, managed over `/api/files/*` ([routes](../../http/route-files.ts)). The runtime owns one [FileIndex](file-index.ts) ([composition](../../runtime/composition/runtime-file-index.ts)); the desktop codes to the same route shapes ([types](file-index-types.ts)).

## Pieces

- [Schema](file-index-schema.ts): its own SQLite file, `<stateDir>/files-index.sqlite` (`folders`, `files` with mtime/size/status, `chunks` with PDF page or time offset, `chunks_fts` FTS5, optional `chunk_vectors` per embedding model). Deleting the file loses only the index.
- [Store](file-index-store.ts) and [vector store](file-vector-store.ts): rows are removed child first, so the FTS triggers see every delete. A folder that contains added ones takes them in.
- [Folder checks](folder-validation.ts): `not_absolute`, `too_broad` (disk root, home, `/Users`, system folders, the agent's state dir), `not_found`, `not_a_directory`, `already_added`, `inside_added`.
- [Walker](file-walker.ts): `os.fs.glob`'s default ignores, hidden files and folders, no symlinks, a size cap (larger files count as skipped) and a file cap per folder.
- [Text](file-text.ts): `os.fs.read_document`'s extractors (exported from [read-document](../os/read-document/read-document.ts)); PDF output is split on its `--- page N ---` dividers so each chunk keeps its page. Scanned PDFs are skipped (no OCR yet). Photos and audio go through [media-text](../os/media-text/media-text.ts) only when `media.enabled` is set; the runtime has no switch for it yet, so they are skipped.
- [Chunker](file-chunker.ts): about 1000 characters, cut at a paragraph, line, sentence or word, never across a page.
- [Indexer](file-indexer.ts): one serial queue; a pass walks every folder (new or changed by mtime/size become pending, vanished files go), reads pending files one at a time, then embeds chunks the current model lacks. `stop()` aborts the file in hand, which stays pending. Status counts: done when `!running && indexed + failed + skipped === found`.
- [Search](file-search.ts): FTS5 terms (the session search's quoting, AND then OR), blended with cosine over chunk vectors when memory embeddings are on, using memory recall's weights, floor and gap (`memory/embeddings/hybrid-recall.ts`). Embeddings come from the model memory has attached now, and only when it runs on this machine.
- [Citation](file-cite.ts): `[report.pdf, p. 12](file:///…/report.pdf#page=12)`, `[call.m4a, 1:23](file:///…/call.m4a#t=83)`, `[notes.md](file:///…/notes.md)`; the path is RFC 8089 percent-encoded, with parentheses and brackets escaped for markdown.
- [Tool](files-search-tool.ts): `files.search { query, folder?, topK? }`, resource class `pure_read`, rare tier, framed as untrusted output. A `folder` argument goes through the read scope like any read (`read-scope-targets.ts`); without it the search covers only the folders the person added.

## Not yet

OCR of scanned PDFs, timestamps in transcripts, a setting for photos and audio, a file watcher (changes are picked up on the next pass: boot, or a folder added), `sqlite-vec`, reranking.

## Validation

`npx vitest run src/tools/files src/http/route-files.test.ts src/tools/tool-contract-conformance.test.ts`.
