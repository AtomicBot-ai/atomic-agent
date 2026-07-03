# Bundling

The **CLI** (`tui`, `run`, `serve`, `models`, …) ships as a single-file
executable per target, produced via Node SEA. The embedded entry is
`dist-sea/cli.mjs` (esbuild bundle of `src/cli/index.ts` and dependencies,
see `npm run bundle:sea`) with `mainFormat: "module"` in
`sea-config.json`. The separate **Tauri sidecar** entry is still
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

## Build-time Node requirement

SEA embeds the build-time Node binary, so its feature set is decided at
build time, not on the end user's machine. `"mainFormat": "module"` (the
flag that makes SEA treat `dist-sea/cli.mjs` as ESM) landed in
**Node 25.7.0** ([#61813](https://github.com/nodejs/node/pull/61813)).
Earlier Nodes (including 24.x LTS until the backport lands) run the ESM
bundle as CommonJS and crash with `SyntaxError: Cannot use import
statement outside a module`.

- `npm ci`, `npm run build`, `npm test` — work on **Node ≥ 22.x**.
- `npm run bundle:build-binary` — requires **Node ≥ 25.7**. The script
  verifies `process.versions.node` and exits fast with a clear message.
- CI pins `node-version: "25.x"` in
  [`release.yml`](../.github/workflows/release.yml).

Local setup: `nvm install 25 && nvm use 25` before `npm run
bundle:build-binary`.

## Per-target build (runs on the target host)

1. Install deps for the target platform:
   ```bash
   npm ci --omit=dev
   ```
2. Build the TypeScript output:
   ```bash
   npm run build
   ```
3. Bundle the CLI for SEA (single ESM file with `createRequire` banner for
   mixed CJS dependencies; `better-sqlite3` stays external):
   ```bash
   npm run bundle:sea
   ```
4. Fetch runtime assets (downloads the pinned `ripgrep` binary for the
   current host; pass `--all` to prefetch every target):
   ```bash
   npm run bundle:fetch-assets
   # or, to prefetch the full matrix:
   npx tsx scripts/fetch-assets.ts --all
   ```
5. Produce the SEA binary:
   ```bash
   npm run bundle:build-binary
   ```
6. Package the bundle:
   ```bash
   npm run bundle:package
   ```

The output lands at `bundle/atomic-agent-<slug>.<ext>` and
`bundle/atomic-agent-<slug>.<ext>.sha256` (for `shasum -a 256 -c`).

## Troubleshooting: `killed` in zsh (macOS)

- **#1 cause on Apple Silicon:** `postject` rewrites the Mach-O, which
  invalidates the ad-hoc code signature Node ships with. The kernel then
  kills the process at launch with SIGKILL and an empty `killed` line.
  [`scripts/build-binary.ts`](../scripts/build-binary.ts) runs
  `codesign --sign - --force` after injection to restore launchability;
  CI later replaces that ad-hoc signature with the Developer ID one. If
  you hit `killed`, first verify the binary is signed:
  ```bash
  codesign -dv ./bundle/darwin-arm64/atomic-agent
  # Format=Mach-O thin (arm64)  Signature=adhoc  ← expected
  ```
- `xattr -l` showing **`com.apple.provenance` only** is **not** quarantine.
  Blocking downloads use **`com.apple.quarantine`**. `provenance` alone does
  not explain a silent `killed`.
- Compare: if **`node dist-sea/cli.mjs --help`** works but
  **`./bundle/.../atomic-agent`** is killed, the problem is the SEA binary
  path (signing, Node version, SEA config), not the JS sources. If both
  fail, debug the bundle first.
- For jetsam / real OOM, check **Console** (or `log show --predicate
  'eventMessage contains "Jetsam"'`) around the run time.

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

## Tauri sidecar binary

The Tauri host embeds the agent as a **sidecar** child process speaking the
NDJSON protocol over stdin/stdout (see [SIDECAR.md](SIDECAR.md)). It reuses the
same SEA pipeline as the CLI, but embeds the sidecar entry
(`src/sidecar/main.ts` → `dist-sea/sidecar.mjs`) and follows Tauri's
`externalBin` naming: `src-tauri/binaries/atomic-agent-sidecar-<rustTriple>[.exe]`.

```bash
npm run build              # produces dist/
npm run bundle:sidecar-sea # esbuild → dist-sea/sidecar.mjs
npm run bundle:tauri-sidecar # SEA blob + postject → src-tauri/binaries/
```

The Rust target triple per host is the `rustTriple` field of
[`scripts/bundle-targets.ts`](../scripts/bundle-targets.ts)
(e.g. `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`,
`x86_64-pc-windows-msvc`). SEA has no cross-compilation — build on each target
host, exactly like the CLI binary. Reference it from `tauri.conf.json` as
`externalBin: ["binaries/atomic-agent-sidecar"]`; Tauri appends the host triple
automatically. The Rust shell / `tauri.conf.json` themselves live in the Tauri
app repo and are out of scope here.

The protocol request/event types are exported from the package root
(`src/sidecar/index.ts`) so the Tauri front-end can import them as the single
source of truth for the wire contract.

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
  `./.atomic-agent/skills/`. The redistributable ships a `starter-skills/`
  tree next to the binary; each boot the runtime replaces matching names
  under the global skills dir so starter packs stay current (project-local
  skills are unchanged).

## Non-goals

- **No llama-server download.** The agent connects to a server the user
  already runs.
- **No Chromium download.** `playwright-core` is used without
  `npx playwright install`; the user supplies the browser.
- **No cross-compilation.** Node SEA is strictly per-host; CI fan-out
  handles the matrix.
- **No arbitrary user skill corpus in the bundle.** Only the small
  built-in `starter-skills/` templates ship; operators still own
  long-lived skill edits under stateDir.
