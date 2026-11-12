# Bundling

Status: current
Owner: scripts/


The **CLI** (`tui`, `run`, `serve`, `models`, …) ships as a single-file
executable per target, produced via Node SEA. The embedded entry is
`dist-sea/cli.mjs` (esbuild bundle of `src/cli/index.ts` and dependencies,
see `npm run bundle:sea`) with `mainFormat: "module"` in
`sea-config.json`. The separate **Tauri sidecar** entry is still
`atomic-agent-sidecar` when installed from npm; it is not the SEA
release described here. llama-server is **not** bundled — connect over
HTTP (`localModels.url` in `config.json`) or use `atomic-agent models` for managed
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
  [`release.yml`](../../.github/workflows/release.yml).

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
  [`scripts/build-binary.ts`](../build-binary.ts) runs
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

The workflow [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
builds the matrix on tag `v*` or on `workflow_dispatch` (optionally
publishing a **draft** GitHub Release with all artifacts). macOS jobs
run [scripts/sign-mac-binary.sh](../sign-mac-binary.sh) and
[scripts/notarize-mac-binary.sh](../notarize-mac-binary.sh) (same
notary key pattern as openclaw / `electron-desktop`). Linux and Windows
archives are unsigned in this milestone; Windows `signtool` signing is
deferred. Tauri hosts that embed a sidecar should use a **signed** binary
on notarised macOS app builds.

**GitHub secrets (match openclaw):** `MACOS_CSC_LINK` (base64 .p12),
`MACOS_CSC_KEY_PASSWORD`, `NOTARYTOOL_KEY` (App Store Connect API key
`.p8` **contents**), `NOTARYTOOL_KEY_ID`, `NOTARYTOOL_ISSUER`. Raw
Mach-O binaries are not stapled; Gatekeeper uses an online ticket on
first launch.

## Release provenance and signature

Every release carries two things a swapped archive cannot fake by also swapping
its `.sha256` (ATO-680):

- **Build provenance.** The `release` job runs `actions/attest-build-provenance`
  over every asset and `SHA256SUMS`. It needs no secret, only the job's
  `id-token: write` and `attestations: write`. Anyone can check a download:
  `gh attestation verify atomic-agent-linux-x64.tar.gz --repo AtomicBot-ai/atomic-agent`.
- **Release signature.** The job writes `SHA256SUMS` (`sha256sum` of every asset
  except the `.sha256` files) and, when the `RELEASE_SIGNING_KEY` secret is set,
  `SHA256SUMS.sig`: a raw 64-byte Ed25519 signature made with
  `openssl pkeyutl -sign -rawin`. Without the secret the step prints a notice and
  the release ships unsigned, as before.

The format is a plain Ed25519 detached signature, not minisign: minisign wraps
the signature with a key id and a BLAKE2b prehash, and Node's `node:crypto` and
OpenSSL 3 both verify the plain form with no extra code or tool.

Who checks it:

- `atomic-agent update` ([src/update/release-signature.ts](../../src/update/release-signature.ts))
  fetches `SHA256SUMS.sig` and `SHA256SUMS` from the release, verifies them with
  the embedded public key, and hands the archive's signed digest to the installer
  as `ATOMIC_AGENT_EXPECTED_SHA256`. A bad signature, or a signed list that does
  not name the archive, stops the update.
- [install.sh](../install.sh) on a fresh install, when curl and an OpenSSL 3
  `openssl` are present (the LibreSSL in macOS cannot, and is skipped with a note).
- [install.ps1](../install.ps1) only compares `ATOMIC_AGENT_EXPECTED_SHA256`:
  Windows PowerShell 5.1 has no Ed25519.

All of it is skipped while no public key is embedded, and for a release that
ships no `SHA256SUMS.sig` (every release cut before the key existed).

### Turning the signature on

1. Make the key on a trusted machine, not in CI:
   `openssl genpkey -algorithm ed25519 -out release-signing-key.pem`
2. Store the whole PEM (with its BEGIN/END lines) as the repository secret
   `RELEASE_SIGNING_KEY`, and keep an offline copy. The next release then ships
   `SHA256SUMS.sig`.
3. Print the public half, `openssl pkey -in release-signing-key.pem -pubout`, and
   paste it into `RELEASE_SIGNING_PUBLIC_KEY` in both
   `src/update/release-signature.ts` and `scripts/install.sh` (the same text in
   both). Builds from that commit on check the signature.

### Rotation

A binary trusts only the key it was built with, so a new key has to reach users
through a release the old key still signs:

1. Make the new key. Ship a release signed with the **old** key whose binaries
   and `install.sh` embed the **new** public key.
2. Swap `RELEASE_SIGNING_KEY` to the new key. Releases from then on are signed
   with it, and the binaries from step 1 accept them.
3. Users who skip the release from step 1 get a failed update; they reinstall
   with `install.sh`, which comes from `main` and already has the new key.

If the private key leaks, do the same at once, and say in the release notes that
updates from older versions fail until reinstalled. The release signature does
not replace macOS notarisation or Windows Authenticode: those cover the binary,
this covers which archive the updater accepts.

## Linux packages and the repository

The deb and rpm (`npm run linux:packages -- build`, [linux-packages.ts](../linux-packages.ts),
[nfpm.yaml](../../packaging/nfpm.yaml)) and the AUR PKGBUILD (`pkgbuild`,
[PKGBUILD.in](../../packaging/PKGBUILD.in)) carry the Linux bundles above
unchanged: `atomic-agent-linux-<x64|arm64>.tar.gz` is extracted whole under
`/usr/lib/atomic-agent` (the SEA binary and the asset directories the runtime
resolves next to it cannot go under `/usr/bin`), and `/usr/bin/atomic-agent`
and `/usr/bin/atag` are symlinks into it. Node resolves `process.execPath`
through `/proc/self/exe`, so the runtime finds grammars, starter-skills,
vendor/rg and node_modules exactly as under `~/.local/bin`. A package also
leaves `/usr/lib/atomic-agent/install-source` holding `deb`, `rpm` or `aur`:
[install-source.ts](../../src/update/install-source.ts) reads it, and with the
binary at that path `atomic-agent update` refuses and names the package
manager, the TUI makes no update offer, `atomic-agent uninstall` lists data
only, and the analytics install channel reports the package. `install.sh`
warns when its copy shadows a package. Each package depends on the newest
glibc any ELF in the tree requires, read with `readelf` (2.34 today, from
`better_sqlite3.node`; the SEA binary itself needs 2.28), plus `libstdc++` and
`libatomic` (the Node binary links `libatomic.so.1`, which minimal Debian and
Fedora images lack; the first smoke on a draft caught it). The build reads
every `NEEDED` library of those files and fails on one that
`DECLARED_LIBRARIES` does not cover, so a new Node or addon dependency has to
be declared in `nfpm.yaml` and `PKGBUILD.in` before a package is built.
Packages are named
`atomic-agent_<version>_<arch>.<deb|rpm>` (an underscore: no `atomic-agent-*`
glob matches them) and get a `.sha256` each. The pure parts (names, layout,
upload order) are in [linux-packaging.ts](../linux-packaging.ts) with
[its tests](../linux-packaging.test.ts).

In [release.yml](../../.github/workflows/release.yml) the `packages` job runs
after `build` on the uploaded Linux bundles (nfpm pinned by checksum; the rpm
signed with the packages key, which must be the key in
[packaging/atomic-chat.asc](../../packaging/atomic-chat.asc), shared with atc /
eye-cli), the draft release gets the packages next to the bundles, and
`smoke-packages` installs each one from the draft in clean containers (Debian
12, Ubuntu 24.04, Fedora, Rocky 9, Arch via the PKGBUILD; Debian 12 and
Fedora on arm64) the way the README's `<!-- install:apt -->` and
`<!-- install:dnf -->` blocks say, against a repository of the draft served on
loopback and signed with a throwaway key
([smoke-linux-package.sh](../smoke-linux-package.sh)). A red smoke means: do
not publish the draft. A run by hand with `allow_unsigned` builds without the
key (never for a tag). A run by hand names its draft after `package.json`;
when a release of that version is already published the `release` job stops
before uploading anything, because `gh release upload --clobber` onto a
published release replaces the binaries people install (it did once, for
v0.6.11, when the step still ignored a failed `gh release create`).

**The repository** (`npm run linux:repo`, [linux-repo.ts](../linux-repo.ts))
is the bucket `atomic-agent-packages` on Hetzner Object Storage in
Falkenstein, served at `https://atomic-agent-packages.fsn1.your-objectstorage.com`
(its own bucket, apart from atc's; Hetzner terminates HTTPS only on its own
host). The bucket is private and every object is uploaded `public-read`.
GitHub Releases are the source of truth: on every published stable release
[linux-repo.yml](../../.github/workflows/linux-repo.yml) (fired by
`release: published` when the draft is published on GitHub, or by hand on a
tag) rebuilds the repository from scratch out of the newest ten stable
releases that carry packages, each package checked against its `.sha256`,
signs `InRelease`/`Release.gpg` and `repomd.xml.asc`, publishes the key as
`atomic-chat.asc` and `atomic-chat.gpg`, mirrors it (packages first, then
indexes, then what points at them; deletions last; packages cached a year,
everything else `no-cache`), and installs from the live repository in Debian
and Fedora. Its `aur` job renders the PKGBUILD from the release's `.sha256`
digests and pushes `atomic-agent-bin` to the AUR for the latest release only,
skipping a version the AUR already has. Both steps are idempotent.

**The desktop app** is the repository's second product
(`PRODUCTS` in [linux-packaging.ts](../linux-packaging.ts)). Its deb and rpm
(`Atomic-Agent-<version>-<arch>.<deb|rpm>`, package `atomic-agent-desktop`,
under `/opt/Atomic Agent`, its own copy of the agent inside) are built by
electron-builder in the desktop workflow on the desktop branches and uploaded
with `SHA256SUMS.txt` to a `desktop-vX.Y.Z` release by hand. Publishing that
release runs the same linux-repo.yml: `release` names the product, `fetch`
keeps a window of ten per product and checks the desktop's packages against
`SHA256SUMS.txt`, `build` signs any rpm that arrived unsigned with `rpmsign`
(electron-builder signs none, and the `.repo` file has `gpgcheck=1`),
`smoke-repo` installs `atomic-agent-desktop` and checks its libraries with
`ldd` and its bundled agent
([smoke-linux-desktop-package.sh](../smoke-linux-desktop-package.sh)), and
`aur` pushes `atomic-agent-desktop-bin` from
[PKGBUILD-desktop.in](../../packaging/PKGBUILD-desktop.in), which repacks the
release's deb. The deployment rule of the environment `packages` must admit
`desktop-v*` tags as well as `v*`.

Secrets: `LINUX_PACKAGES_GPG_KEY` (the armored private key) and
`LINUX_PACKAGES_GPG_PASSPHRASE` in the repository; in the environment
`packages` (deployment tags `v*` and `desktop-v*` only) also `PACKAGES_S3_ACCESS_KEY_ID`,
`PACKAGES_S3_SECRET_ACCESS_KEY` and `AUR_SSH_PRIVATE_KEY` (the AUR account
that owns `atc-bin`). Key rotation: a new key is published next to the old one
with `--publish-keys OLD,NEW` for a release, so installed keyrings learn it
before it signs alone.

## Install (macOS / Linux, curl)

From a published release (or `latest`):

```bash
curl -fsSL "https://raw.githubusercontent.com/OWNER/atomic-agent/BRANCH/scripts/install.sh" | sh
```

Set `ATOMIC_AGENT_REPO=owner/atomic-agent` if the default in
[scripts/install.sh](../install.sh) does not match your fork.
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
  `localModels.url` (`atomic-agent config set localModels.url http://host:port`)
  as needed.
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
