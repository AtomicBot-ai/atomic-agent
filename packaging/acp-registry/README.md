# ACP registry entry

Zed and JetBrains list agents from the [ACP registry](https://github.com/agentclientprotocol/registry) (Agent Client Protocol). This folder holds what our entry there needs besides the release itself: `icon.svg` (16x16, `currentColor`, as the registry requires). The entry's `agent.json` is generated per release by [`scripts/acp-registry.ts`](../../scripts/acp-registry.ts) from the release archives' sha256 digests; its fields and the registry's offline checks are in [`scripts/acp-registry-manifest.ts`](../../scripts/acp-registry-manifest.ts).

## Before it can be submitted

The registry's CI launches the agent with the entry's command (`<archive>/atomic-agent acp`) and sends ACP `initialize`. The answer must list `authMethods` with at least one method of type `agent` or `terminal`. atomic-agent has no ACP server yet (ATO-543), so an entry submitted today would fail that check. Submit only after a release that ships `atomic-agent acp`.

## Generate and check the entry

```sh
gh release download vX.Y.Z -R AtomicBot-ai/atomic-agent -p '*.sha256' -D bundle
npx tsx scripts/acp-registry.ts manifest --version X.Y.Z --archives bundle
# writes dist/acp-registry/atomic-agent/agent.json and icon.svg, then checks them
npx tsx scripts/acp-registry.ts check --dir dist/acp-registry/atomic-agent
```

Only the platforms whose digest is present are listed (today: macOS Apple Silicon, Linux x64 and arm64, Windows x64). The `.deb` / `.rpm` packages are not used: the registry takes archives only.

## Submit (a public pull request, needs an explicit go-ahead)

1. Fork `agentclientprotocol/registry` and copy `dist/acp-registry/atomic-agent/` to the fork's root as `atomic-agent/`.
2. In the fork, run the registry's own checks: `uv run --with jsonschema .github/workflows/build_registry.py` and `python3 .github/workflows/verify_agents.py --auth-check --agent atomic-agent`.
3. Open the pull request against `agentclientprotocol/registry` `main`.

After it is merged, the registry picks up new GitHub releases by itself (hourly). It reads the repository's latest release, so the desktop app's `desktop-v*` releases must not be marked "Latest" or the entry would point at the wrong assets; check this before submitting.
