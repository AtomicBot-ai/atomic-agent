import { describe, expect, it } from "vitest";

import { SESSION_LLM_METADATA_KEY } from "../session/session-llm.js";
import {
  harness,
  spokenTo,
  type StoredSession,
} from "./rail-session-harness.js";

/**
 * A `+ new` the operator never types into must leave nothing behind.
 * It used to write its row on the spot, and the rail hides a row with no
 * first prompt — so the thread was invisible, there was no row to press
 * `x` on, and nothing could ever delete it. The TUI now mints its
 * sessions deferred (`persist: false`) and the first turn writes the row.
 */
describe("rail session list — deferred allocation", () => {
  it("writes no row for a `+ new` nobody types into", () => {
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    expect(stored.map((s) => s.id)).toEqual(["s-old"]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-old"]);
  });

  it("leaves the store empty when the TUI quits on an untouched session", async () => {
    const stored: StoredSession[] = [];
    const { orchestrator } = harness(stored);
    try {
      orchestrator.start();
      orchestrator.newSession();
      orchestrator.quit();
    } finally {
      await orchestrator.shutdown();
    }
    // Nothing on the quit path saves a session, so the whole launch is
    // as if it never happened — which is the point.
    expect(stored).toEqual([]);
  });

  it("drops the untouched session when the operator switches away", () => {
    // Dropping it is correct: it holds no words. What must not happen is
    // a throw on the way out, or a stand-in left behind for a session
    // that no longer exists anywhere.
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, rail, actions } = harness(stored);
    orchestrator.newSession();
    expect(() => orchestrator.switchSession("s-old")).not.toThrow();
    expect(stored.map((s) => s.id)).toEqual(["s-old"]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-old"]);
    const switched = actions.filter((a) => a.type === "session_switched");
    expect(switched.at(-1)).toMatchObject({ sessionId: "s-old" });
  });

  it("keeps the row the operator's model pick writes for a deferred session", () => {
    // Picking a provider/model before typing is a deliberate act on this
    // thread, and the stamp has to survive switching away from it — so
    // it saves, and `SessionStore.save` INSERTs the row that is not
    // there yet.
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, bus } = harness(stored);
    orchestrator.newSession();
    bus.emit({
      type: "providers_select_chat_model",
      providerId: "local-llama",
      modelId: "qwen3-30b",
    });
    const fresh = stored.find((s) => s.id === "s-new-1");
    expect(fresh?.metadata[SESSION_LLM_METADATA_KEY]).toEqual({
      providerId: "local-llama",
      chatModel: "qwen3-30b",
    });
  });
});
