import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { createInitialLocalModelsPanelState } from "./local-models-panel-state.js";
import type { LocalModelsPanelState } from "./local-models-panel-state.js";
import { LocalModelsPanel } from "./local-models-panel.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function frame(panel: LocalModelsPanelState): string {
  const { lastFrame } = render(<LocalModelsPanel panel={panel} maxRows={40} />);
  return strip(lastFrame() ?? "");
}

/**
 * ATO-852: a server that answers `/health` but rejects the session's key
 * was drawn as "alive but /health unreachable", which reads like a wait.
 * The fix is a restart, so the panel says so.
 */
describe("LocalModelsPanel daemon lines", () => {
  const base = createInitialLocalModelsPanelState();

  it("says key rejected for the chat daemon when its key is refused", () => {
    const out = frame({
      ...base,
      daemon: { running: true, healthy: false, loading: false, authMismatch: true, pid: 4321, port: 19091 },
    });
    expect(out).toContain("key rejected: restart the model (pid 4321)");
    expect(out).not.toContain("/health unreachable");
  });

  it("says key rejected for the embedding daemon when its key is refused", () => {
    const out = frame({
      ...base,
      embeddingDaemon: {
        enabled: true,
        running: true,
        healthy: false,
        loading: false,
        authMismatch: true,
        pid: 4322,
        port: 19092,
        activeModelId: null,
      },
    });
    expect(out).toContain("embeddings ! key rejected: restart the model (pid 4322)");
  });

  it("keeps the unreachable wording when the key is not the problem", () => {
    const out = frame({
      ...base,
      daemon: { running: true, healthy: false, loading: false, pid: 4321, port: 19091 },
    });
    expect(out).toContain("pid 4321 alive but /health unreachable");
    expect(out).not.toContain("key rejected");
  });
});
