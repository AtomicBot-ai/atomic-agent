import { describe, expect, it } from "vitest";
import { USER_CONFIG_VERSION, parseUserConfigFile } from "../config/config-schema.js";
import { childConfig, countTraceTokens } from "./agent-task-runner.js";

describe("agent task runner helpers", () => {
  it("writes a child config the schema accepts, in external mode on the loaded model", () => {
    const parsed = parseUserConfigFile(childConfig("http://127.0.0.1:9931"));
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.localModels.mode).toBe("external");
    expect(parsed.localModels.url).toBe("http://127.0.0.1:9931");
  });

  it("adds prompt and generated tokens from the trace", () => {
    const trace = [
      JSON.stringify({ type: "prompt_captured", tokens: { total: 1200 } }),
      JSON.stringify({ type: "llm_completion", timing: { predictedTokens: 80 } }),
      "not json",
      JSON.stringify({ type: "tool_invocation", tool: "os.fs.read" }),
      JSON.stringify({ type: "prompt_captured", tokens: { total: 1300 } }),
    ].join("\n");
    expect(countTraceTokens(trace)).toBe(2580);
    expect(countTraceTokens("")).toBeNull();
  });
});
