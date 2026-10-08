import { rmSync } from "node:fs";
import { getDaemonStatus, getEmbeddingDaemonStatus } from "./server/daemon-lifecycle.js";
import { readCoreSession, coreSessionPath } from "./core/core-state.js";
import { withCoreOperation } from "./core/core-operation.js";

/** Selection never stops a model or starts a download. Both frontends use this guard. */
export async function selectManagedEngine(dataDir: string, chatPort: number, embeddingPort: number, persist: () => void): Promise<void> {
  const chat = await getDaemonStatus(dataDir, chatPort);
  const embedding = await getEmbeddingDaemonStatus(dataDir, embeddingPort);
  await withCoreOperation(dataDir, async () => {
    if (chat.running || embedding.running || readCoreSession(dataDir, "chat") || readCoreSession(dataDir, "embedding")) throw new Error("Stop local models before changing engines.");
    for (const role of ["chat", "embedding"] as const) rmSync(coreSessionPath(dataDir, role), { force: true });
    persist();
  });
}
