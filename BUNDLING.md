# Bundling

The sidecar ships as a single-file executable per target, produced via
Node SEA. llama-server is **not** bundled — operators run it separately
and the sidecar connects over HTTP (`ATOMIC_AGENT_LLAMA_URL`).
Neither Chrome/Edge nor Playwright browser binaries are bundled;
`playwright-core` attaches to the already-installed system browser.

## Target matrix

| Slug           | Platform | Arch   | Runner (GH)        | Archive  |
|----------------|----------|--------|--------------------|----------|
| `darwin-arm64` | darwin   | arm64  | `macos-14`         | `tar.gz` |
| `darwin-x64`   | darwin   | x64    | `macos-13`         | `tar.gz` |
| `linux-x64`    | linux    | x64    | `ubuntu-22.04`     | `tar.gz` |
| `linux-arm64`  | linux    | arm64  | `ubuntu-22.04-arm` | `tar.gz` |
| `win32-x64`    | win32    | x64    | `windows-2022`     | `zip`    |

Run `npm run bundle:matrix -- --json` to get the JSON input for a GitHub
Actions matrix strategy.

## Per-target build (runs on the target host)

1. Install deps for the target platform:
   ```bash
   npm ci --omit=dev
   ```
2. Build the TypeScript output:
   ```bash
   npm run build
   ```
3. Fetch runtime assets (downloads the pinned `ripgrep` binary for the
   current host; pass `--all` to prefetch every target):
   ```bash
   npm run bundle:fetch-assets
   # or, to prefetch the full matrix:
   npx tsx scripts/fetch-assets.ts --all
   ```
4. Produce the SEA binary:
   ```bash
   npm run bundle:build-binary
   ```
5. Package the bundle:
   ```bash
   npm run bundle:package
   ```

The output lands at `bundle/atomic-agent-<slug>.<ext>`.

## Signing / notarisation

These scripts stop at the unsigned artefact. Wire `codesign` + `notarytool`
on macOS and `signtool` on Windows in CI before distribution — Tauri
will refuse to spawn an unsigned sidecar on notarised builds.

## What the bundle contains

```
atomic-agent-sidecar[.exe]    # SEA binary, entry point
grammars/tool-call.gbnf       # GBNF for structured tool-call decoding
vendor/rg[.exe]               # pinned ripgrep for os.fs.grep (sidecar file)
README.txt                    # short runtime note
```

## Bundled ripgrep

`os.fs.grep` relies on a pinned ripgrep build so the agent works zero-setup
once the archive is extracted.

- **Version:** pinned in `scripts/fetch-assets.ts` via `RIPGREP_VERSION`.
  Bump that constant (and re-run `npm run bundle:fetch-assets --all`) to
  refresh.
- **Location:** copied by `scripts/package-bundle.ts` to
  `<bundle>/vendor/rg[.exe]` next to the SEA binary. The runtime resolver
  (`src/runtime/ripgrep-resolver.ts`) discovers it via
  `<dirname(process.execPath)>/vendor/rg[.exe]`.
- **Override:** set `ATOMIC_AGENT_RG_PATH=/path/to/rg` to point the agent
  at a different binary without repackaging.
- **Size impact:** roughly +5 MB per target. The binary is stripped and
  stored alongside the SEA rather than embedded inside it, because Node
  SEA asset extraction + `chmod +x` out of a temp dir is fragile across
  platforms.
- **Not committed:** downloaded binaries land under `assets/ripgrep/`,
  which is git-ignored.

## Bundled document extractors

`os.fs.read_document` bundles several pure-JS libraries for PDF/DOCX/XLSX/
RTF/ODT/PPTX/DOC extraction. These are regular `dependencies` resolved by
Node SEA's builtin module resolution, not sidecar binaries:

| Library | Purpose | Approx. size |
|---|---|---|
| `pdfjs-dist` (legacy build) | PDF text layer | ~1.8 MB |
| `mammoth` | DOCX → markdown | ~250 KB |
| `exceljs` | XLSX parsing | ~850 KB |
| `jszip` | ODT/PPTX unzip | ~100 KB |
| `fast-xml-parser` | ODT/PPTX XML parsing | ~200 KB |
| `word-extractor` | Legacy .doc (OLE2) | ~100 KB |

Net cost to the SEA: roughly +3 MB. RTF is handled by a custom pure-JS
parser in-tree (no dep). Test fixtures live under
`src/tools/os/test-fixtures/` and are regenerated via
`npm run fixtures:generate` (uses devDeps `pdfkit`, `docx`).

## Bundled archive tools

`os.fs.archive.*` shares `jszip` with `read_document` and adds one
dependency:

| Library | Purpose | Approx. size |
|---|---|---|
| `tar-stream` | Streaming tar / tar.gz read + write | ~50 KB |

`gz` is handled by the built-in `zlib`. Net incremental cost of the
archive tools: **~50 KB** (plus the already-bundled jszip).

## Runtime requirements (documented in README.txt)

- **External llama-server.** Set `ATOMIC_AGENT_LLAMA_URL=http://host:port`
  before launching the sidecar.
- **Google Chrome or Microsoft Edge installed** on the host. We use the
  system browser via `playwright-core` (`channel: chrome|msedge`).
- **macOS:** Accessibility + Screen Recording permissions must be granted
  to the sidecar binary for window-management and reliable keyboard
  automation. Users grant this the first time the tool is used.
- **Linux:** `wmctrl` needed for `os.window.*`; `xdg-open`/`pbpaste`
  equivalents are consumed by `clipboardy` where applicable.
- **Skills** live under `$ATOMIC_AGENT_STATE_DIR/skills/` and
  `./.atomic-agent/skills/`. They are runtime artefacts authored by the
  user and are never bundled.

## Non-goals

- **No llama-server download.** The agent connects to a server the user
  already runs.
- **No Chromium download.** `playwright-core` is used without
  `npx playwright install`; the user supplies the browser.
- **No cross-compilation.** Node SEA is strictly per-host; CI fan-out
  handles the matrix.
- **No starter skills in the bundle.** Skill format is open; see
  `SKILLS.md`.
