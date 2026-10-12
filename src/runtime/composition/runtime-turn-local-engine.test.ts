import { expect, it } from "vitest";
import * as configuration from "../../config/index.js";
import { resolveTurnLocalEngine } from "./runtime-turn-service.js";

it("names the engine of a local turn for message_sent, and none for a cloud one", () => {
  const config = configuration.loadConfig();
  config.localModels.mode = "managed";
  config.localModels.managed.engine = "atomic-core";
  expect(resolveTurnLocalEngine(config, "local-llama")).toBe("atomic-core");
  config.localModels.managed.engine = "llama-server";
  expect(resolveTurnLocalEngine(config, "local-llama")).toBe("llama-server");
  config.localModels.mode = "external";
  expect(resolveTurnLocalEngine(config, "local-llama")).toBe("external");
  config.llm = { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server" }, { id: "openrouter", kind: "openrouter", model: "x" }] } as never;
  expect(resolveTurnLocalEngine(config, "openrouter")).toBeUndefined();
});
