# Managed local model/server lifecycle

Scope: `src/local-llm/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep model/server assets external to the inference runtime. Preserve external versus managed modes, launch records, ownership checks and stopOnExit behavior.
- Download workers are detached processes; paths, resumable segments, paired GGUF/mmproj work and job status must survive restarts. Never replace a live job just because its UI was reopened.
- Preserve platform-specific backend selection and capabilities from actual GGUF/server metadata. Do not claim RAM/VRAM or throughput from invented measurements.

## Read when relevant

Read docs/lifecycle.md for daemon edits and docs/downloads.md for download edits; ../tui/AGENTS.md for their UI.

## Checks

Run `npx vitest run src/local-llm` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
