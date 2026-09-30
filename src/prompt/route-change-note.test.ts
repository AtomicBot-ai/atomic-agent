import { describe, expect, it } from "vitest";
import type { SessionRoute } from "../session/session-route.js";
import { renderRouteChangeNote } from "./route-change-note.js";

const deepseek: SessionRoute = {
  mode: "cloud",
  main: { providerId: "aimlapi", model: "deepseek/deepseek-v4-flash" },
  worker: null,
};

describe("renderRouteChangeNote", () => {
  it("says nothing when the route is unchanged", () => {
    expect(
      renderRouteChangeNote(deepseek, { ...deepseek }, { vision: false }),
    ).toBeNull();
  });

  it("names the new and the previous model on a model switch within one provider", () => {
    const sonnet: SessionRoute = {
      ...deepseek,
      main: { providerId: "aimlapi", model: "anthropic/claude-sonnet-5" },
    };
    expect(renderRouteChangeNote(deepseek, sonnet, { vision: true })).toBe(
      "[route changed] You are now running as anthropic/claude-sonnet-5 on aimlapi (previously deepseek/deepseek-v4-flash on aimlapi). Capabilities now: reads images: yes. Tool refusals and limitations stated earlier in this conversation that were tied to the previous model no longer apply — re-check by calling the tool.",
    );
  });

  it("names both providers and the run mode on a local → cloud switch", () => {
    const local: SessionRoute = {
      mode: "local",
      main: { providerId: "local-llama", model: "qwen-3.5-4b" },
      worker: null,
    };
    const note = renderRouteChangeNote(local, deepseek, { vision: false })!;
    expect(note).toContain(
      "You are now running as deepseek/deepseek-v4-flash on aimlapi (previously qwen-3.5-4b on local-llama).",
    );
    expect(note).toContain("Run mode: cloud (previously local).");
    expect(note).toContain("reads images: no.");
  });

  it("falls back to the provider id when no model is configured, and says unknown vision as such", () => {
    const bare: SessionRoute = {
      mode: "local",
      main: { providerId: "local-llama", model: null },
      worker: null,
    };
    const note = renderRouteChangeNote(deepseek, bare, { vision: null })!;
    expect(note).toContain(
      "You are now running as local-llama (previously deepseek/deepseek-v4-flash on aimlapi).",
    );
    expect(note).toContain("reads images: unknown.");
  });

  it("names both fusion legs when the worker changed", () => {
    const fusionA: SessionRoute = {
      mode: "fusion",
      main: { providerId: "aimlapi", model: "anthropic/claude-sonnet-5" },
      worker: { providerId: "local-llama", model: "qwen-3.5-4b" },
    };
    const fusionB: SessionRoute = {
      ...fusionA,
      worker: { providerId: "local-llama", model: "qwen-3.5-9b" },
    };
    const note = renderRouteChangeNote(fusionA, fusionB, { vision: true })!;
    expect(note).toContain(
      "You are still running as anthropic/claude-sonnet-5 on aimlapi.",
    );
    expect(note).toContain(
      "Fusion workers now run as qwen-3.5-9b on local-llama (previously qwen-3.5-4b on local-llama).",
    );
    expect(note).not.toContain("Run mode:");
  });

  it("announces the worker leg when fusion is switched on", () => {
    const fusion: SessionRoute = {
      mode: "fusion",
      main: deepseek.main,
      worker: { providerId: "local-llama", model: "qwen-3.5-4b" },
    };
    const note = renderRouteChangeNote(deepseek, fusion, { vision: false })!;
    expect(note).toContain("Run mode: fusion (previously cloud).");
    expect(note).toContain(
      "Fusion workers now run as qwen-3.5-4b on local-llama (previously none).",
    );
  });
});
