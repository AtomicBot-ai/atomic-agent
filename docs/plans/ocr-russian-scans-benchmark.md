# OCR for scans in My files: tesseract.js against the vision model

Status: waiting for the measurement (second Mac)
Owner: src/tools/os/media-text/

## Question

My files reads a scanned PDF page with the vision model served on this computer ([vision OCR engine](../../src/tools/os/media-text/vision-ocr-engine.ts), ATO-2205, wired behind `vision.indexFiles` in ATO-2501). ATO-2502 adds [tesseract.js](../../src/tools/os/media-text/tesseract-ocr-engine.ts) as an offline engine that needs no model server. The [fallback](../../src/tools/os/media-text/fallback-ocr-engine.ts) uses the vision model first and tesseract.js only when no vision model is ready.

This measurement decides three things:

1. Does tesseract.js ship with the agent (a new runtime dependency), or does it stay optional?
2. When both are ready, which engine reads scans first?
3. Is the quality on Russian scans good enough to turn scans on by default once the engine is there?

Precedent: Paperless-ngx OCRs every scan with Tesseract locally (through OCRmyPDF), with `rus` among the language packs it installs on request. LM Studio and Open WebUI read documents with the loaded vision model instead. Both approaches exist; the numbers below decide between them for our users.

## Scan set

20 Russian scans, each a `<name>.pdf` with a `<name>.txt` beside it. The `.txt` is a hand-checked transcript of the same pages in reading order, one page after another. Page dividers, line breaks and runs of spaces do not count (the [metrics](../../eval/harness/ocr-metrics.ts) collapse whitespace), but letters, case, digits and punctuation do.

Suggested mix, so one kind of page does not decide the result:

- 6 typed office documents (contracts, acts, invoices), 300 dpi, black and white;
- 4 of the same at 150 dpi or as phone photos saved to PDF;
- 4 pages with tables (bank statements, price lists);
- 3 pages mixing Russian and English (product names, addresses, e-mail);
- 3 hard pages: a stamp or signature over text, a skewed page, faded print.

Keep the set out of the repository: real documents carry personal data. Store it on the second Mac only and name it in the result note by date, not by content.

## Procedure

On the second Mac (`mbp`), in a checkout of this branch:

1. `npm ci`
2. `npm i --no-save tesseract.js@7.0.0`. It does not change `package.json` or the lockfile.
3. Start a vision model on this computer. Use Atomic Core with the model users get by default for images, or `llama-server -m <model>.gguf --mmproj <mmproj>.gguf --port 19091`. Note the model name and quantisation.
4. Run `npm run eval:ocr -- --dir <scan folder> --vision-model <id> --download-data`. The first run prints the size of the `rus`+`eng` language data (about 5.6 MB) and fetches it into `~/.atomic-agent/models/tesseract/4.0.0_best_int/`. Without `--download-data`, nothing is fetched and the run stops with that size.
5. The script reads each file with each engine the way My files does: the same page pictures (the largest image on each page, at most 2000 px), the same prompt for the vision model, and at most 30 pages per file. It prints one line per file and a table, and writes `eval/reports/ocr/ocr-bench-<time>.json` and `.md` (ignored by git).
6. Run it a second time, so the timing does not include the first wasm compile or the model load. Keep the second run's table.

For each engine, the table reports CER and WER (lower is better, weighted by transcript length), how many files failed, and seconds per page. Also note the machine, the model, and the peak memory from Activity Monitor for each engine.

## Results

Waiting for the second-Mac run. No numbers have been measured yet.

| Engine | Files | Failed | Pages read | CER | WER | Seconds per page |
|---|---|---|---|---|---|---|
| tesseract-js | | | | | | |
| vision-model | | | | | | |

## Reading the result

- tesseract.js clearly wins on quality or comes close (within a few CER points) while being several times faster: ship it as a dependency (see packaging), offer the language data download in Settings > My files with its size, and consider putting it first.
- The vision model clearly wins: keep it first. tesseract.js stays an optional fallback, used only where someone installed it.
- Neither is good on the hard pages: try page rendering instead of the largest image (below) before deciding.

## Packaging impact of tesseract.js

Read from the published packages (npm and the tesseract.js sources, 28.11.2026). Nothing here was installed or built yet.

- `tesseract.js@7.0.0` is Apache-2.0 and 1.4 MB unpacked. It depends on `tesseract.js-core@^7.0.0`, which is 45.3 MB unpacked: several builds of the same WebAssembly engine (SIMD, relaxed SIMD, LSTM-only and full), of which a run loads one. The other dependencies are small: `bmp-js`, `idb-keyval`, `is-url`, `node-fetch`, `regenerator-runtime`, `wasm-feature-detect`, `zlibjs`, and `opencollective-postinstall` (a postinstall script). In total, about 47 MB in `node_modules`. Trimming it to the LSTM wasm builds would cut most of the core.
- In Node it runs in a `worker_threads` worker. It starts that worker from a script path inside its own package (`worker-script/node/index.js`) and loads the core with `require("tesseract.js-core/...")`. The single-file SEA binary cannot carry that, so the package has to sit beside the binary as a real folder, like `better-sqlite3` and `sqlite-vec` today (`external` in `scripts/bundle-sea.ts`). The engine already loads it through a variable specifier, as `sqlite-vec` does. Until it ships, a binary build answers "tesseract.js is not installed" and the fallback skips it.
- Language data is not in the package. By default tesseract.js downloads `<lang>.traineddata.gz` from jsDelivr on first use and caches it in the working folder. The engine turns both off: `langPath` points to a local folder, `cacheMethod: "none"`, and it refuses to run while a file is missing. [The data module](../../src/tools/os/media-text/tesseract-data.ts) downloads `4.0.0_best_int` only with explicit consent: `eng` is 2.95 MB and `rus` is 2.68 MB (`Content-Length` on 28.11.2026). The rule matches the whisper speech model in My files.
- There is no download button in the app yet. Both the button and the dependency wait for this measurement.

## Not covered yet

- A page is read from its largest image only. A scan stored as several strips, or as an image mask, loses the rest of the page. Rendering the page with `@napi-rs/canvas` when it is installed would read the whole page; that is a separate change.
- Photos in My files still go to the vision model only; tesseract.js reads scanned PDF pages.
