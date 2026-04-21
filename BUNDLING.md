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
3. Fetch runtime assets (currently a no-op; hook kept for future browser/profile seeds):
   ```bash
   npm run bundle:fetch-assets
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
README.txt                    # short runtime note
```

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
