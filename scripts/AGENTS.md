# Build, packaging and document checks

Scope: scripts/. Inherit root instructions; read [README.md](README.md).

- Preserve Node SEA ESM framing, external native dependencies and per-platform asset paths. llama-server/model/browser binaries are separate assets, not silently bundled inference dependencies.
- Release/signing/upload scripts have external effects. Use local build checks for a change; do not publish or upload during a documentation check.
- Document checking is offline, read-only except temporary fixtures in its self-test; do not fetch external links or rewrite documentation automatically.
- Read docs/bundling.md for packaging changes. Keep Windows fileURLToPath behavior, native addon handling and signing failure checks.

Checks: npm run docs:check; npm run docs:check -- --self-test; npx tsc -p tsconfig.scripts.json --noEmit for TypeScript script edits. Build/bundle only for a relevant packaging change.
