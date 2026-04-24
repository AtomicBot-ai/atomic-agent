# Bundling

The **CLI** (`tui`, `run`, `serve`, `models`, …) ships as a single-file
executable per target, produced via Node SEA (`dist/cli/index.js` in
`sea-config.json`). The separate **Tauri sidecar** entry is still
`atomic-agent-sidecar` when installed from npm; it is not the SEA
release described here. llama-server is **not** bundled — connect over
HTTP (`ATOMIC_AGENT_LLAMA_URL`) or use `atomic-agent models` for managed
local runtimes. Neither Chrome/Edge nor Playwright browser binaries are
bundled; `playwright-core` attaches to the already-installed system
browser.

## Target matrix

| Slug           | Platform | Arch   | Runner (GH)        | Archive  |
|----------------|----------|--------|--------------------|----------|
| `darwin-arm64` | darwin   | arm64  | `macos-14`         | `tar.gz` |
| `darwin-x64`   | darwin   | x64    | `macos-13`         | `tar.gz` |
| `linux-x64`    | linux    | x64    | `ubuntu-22.04`     | `tar.gz` |
| `linux-arm64`  | linux    | arm64  | `ubuntu-24.04-arm` | `tar.gz` |
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

The output lands at `bundle/atomic-agent-<slug>.<ext>` and
`bundle/atomic-agent-<slug>.<ext>.sha256` (for `shasum -a 256 -c`).

## Release (CI)

The workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
builds the matrix on tag `v*` or on `workflow_dispatch` (optionally
publishing a **draft** GitHub Release with all artifacts). macOS jobs
run [scripts/sign-mac-binary.sh](../scripts/sign-mac-binary.sh) and
[scripts/notarize-mac-binary.sh](../scripts/notarize-mac-binary.sh) (same
notary key pattern as openclaw / `electron-desktop`). Linux and Windows
archives are unsigned in this milestone; Windows `signtool` signing is
deferred. Tauri hosts that embed a sidecar should use a **signed** binary
on notarised macOS app builds.

**GitHub secrets (match openclaw):** `MACOS_CSC_LINK` (base64 .p12),
`MACOS_CSC_KEY_PASSWORD`, `NOTARYTOOL_KEY` (App Store Connect API key
`.p8` **contents**), `NOTARYTOOL_KEY_ID`, `NOTARYTOOL_ISSUER`. Raw
Mach-O binaries are not stapled; Gatekeeper uses an online ticket on
first launch.

## Install (macOS / Linux, curl)

From a published release (or `latest`):

```bash
curl -fsSL "https://raw.githubusercontent.com/OWNER/atomic-agent/BRANCH/scripts/install.sh" | sh
```

Set `ATOMIC_AGENT_REPO=owner/atomic-agent` if the default in
[scripts/install.sh](../scripts/install.sh) does not match your fork.
Optional: `ATOMIC_AGENT_VERSION`, `ATOMIC_AGENT_INSTALL_DIR`.

## Signing / notarisation (local / manual)

On macOS you can run the same shell scripts the workflow uses, or produce
an unsigned binary with `npm run bundle:build-binary` and
`npm run bundle:package` only. Windows code signing is not automated here.

## What the bundle contains

```
atomic-agent[.exe]            # SEA binary (CLI entry)
grammars/tool-call.gbnf      # GBNF for structured tool-call decoding
vendor/rg[.exe]              # pinned ripgrep for os.fs.grep (sibling of binary)
prebuilds/…                  # better-sqlite3 native prebuilds for the target
README.txt                   # short runtime note
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

## Bundled diff / watch tools

`os.fs.diff` / `os.fs.patch` / `os.fs.watch` add two pure-JS runtime
dependencies:

| Library | Purpose | Approx. size |
|---|---|---|
| `diff` (jsdiff 9.x) | Unified-diff generation + patch application, ships its own types | ~100 KB |
| `chokidar` 5.x | Cross-platform recursive fs watcher | ~120 KB |

Net incremental cost: **~220 KB**. `os.fs.hash` uses the built-in
`crypto` module (zero cost). Git tools (`os.git.*`) shell out to the
system `git`, so they add no bundle weight — but the host must have
`git` on `PATH`. Process tools (`os.proc.*`) rely on `ps`/`tasklist`,
which are standard OS utilities and need no bundling.

## Runtime requirements (documented in README.txt)

- **External llama-server (or managed mode).** Set
  `ATOMIC_AGENT_LLAMA_URL=http://host:port` as needed.
- **Google Chrome or Microsoft Edge installed** on the host. We use the
  system browser via `playwright-core` (`channel: chrome|msedge`).
- **macOS:** Accessibility + Screen Recording permissions must be granted
  to the `atomic-agent` binary for window-management and reliable keyboard
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
