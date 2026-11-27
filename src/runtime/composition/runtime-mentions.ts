import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { getStateSecretDirectories, getStateSecretPaths } from "../../config/index.js";
import { createMentionServices, type MentionServices } from "../../mentions/index.js";
import type { LspPoolRef } from "../../tools/os/index.js";

/**
 * The runtime's `@` mention services (ATO-2472). The language-server
 * pool is the one registerOsTools builds for the tools (`tools.lsp`),
 * handed back through `lspPoolRef`, so `@problems` reads the servers the
 * agent's edits already started. The agent's key and trust files, and
 * every file in its sign-in folders (ATO-2496), are never inlined.
 */
export function createRuntimeMentions(config: Pick<AtomicAgentConfig, "paths">): {
  lspPoolRef: LspPoolRef;
  mentions: MentionServices;
} {
  const lspPoolRef: LspPoolRef = {};
  const mentions = createMentionServices({
    lspPool: () => lspPoolRef.pool ?? null,
    protectedFiles: getStateSecretPaths(config.paths),
    protectedFolders: getStateSecretDirectories(config.paths.stateDir),
  });
  return { lspPoolRef, mentions };
}
