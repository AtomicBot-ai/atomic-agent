# CLI frontend

Status: current
Owner: src/cli/

Owns command parsing and terminal entry points. User turns enter runtime.runTurn; preserve exit semantics, state-dir selection and separation from release scripts.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Skill list/show/enable/disable accept `--workspace <dir>` for cloud project scope; `skill project on|off --workspace <dir>` controls all project sources. Without the flag enable/disable remain global. See [cloud skill controls](../skills/docs/cloud-workspace.md).

`config get --with-sha256` prints `{"sha256": "<hex>", "config": {...}}`: the normalised config and the lowercase sha256 of the raw `config.json` bytes it was parsed from, from one read (the empty-string hash when the file is missing). `config set - --expect-sha256 <hex>` writes the stdin payload only while the file still hashes to `<hex>`; otherwise it writes nothing, prints exactly `config changed since it was read` to stderr and exits 3. Without the flag `set -` is unchanged. This is the compare-and-swap the desktop uses since it shares the terminal agent's state dir (ATO-416); see [config-sha256.ts](config-sha256.ts).

Checks: `npx vitest run src/cli` when tests are present; `npm run lint`; `npm run docs:check`.
