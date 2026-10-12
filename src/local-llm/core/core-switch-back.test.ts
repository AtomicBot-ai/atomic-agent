import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCore } from "./core-client.js";
import { loadCoreSession } from "./core-sessions.js";
import { CORE_SWITCH_BACK_HINT, CORE_VERSION, withSwitchBackHint } from "./core-state.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "core-hint-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("ends a failed Core start with the way back to llama-server", async () => {
  await expect(ensureCore(fixture(), CORE_VERSION)).rejects.toThrow(`not installed. Choose Update engine to install it. ${CORE_SWITCH_BACK_HINT}`);
});

it("ends a missing backend with the way back", async () => {
  await expect(loadCoreSession(fixture(), { role: "chat", modelId: "m", modelPath: "/m.gguf", port: 19092, args: [] }))
    .rejects.toThrow(CORE_SWITCH_BACK_HINT);
});

it("appends the hint once and leaves cancellation alone", () => {
  const err = new Error("Atomic Core did not become ready.");
  withSwitchBackHint(withSwitchBackHint(err));
  expect(err.message).toBe(`Atomic Core did not become ready. ${CORE_SWITCH_BACK_HINT}`);
  const abort = new AbortController();
  abort.abort();
  const cancelled = new Error("cancelled");
  expect((withSwitchBackHint(cancelled, abort.signal) as Error).message).toBe("cancelled");
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  expect((withSwitchBackHint(aborted) as Error).message).toBe("aborted");
  expect(withSwitchBackHint("plain")).toBe("plain");
});
