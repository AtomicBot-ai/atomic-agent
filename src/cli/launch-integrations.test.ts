import { describe, expect, it } from "vitest";

import {
  findLaunchIntegration,
  LAUNCH_TOKEN_ENV,
  openCodeConfig,
  tomlString,
  type LaunchTarget,
} from "./launch-integrations.js";

const target = (over: Partial<LaunchTarget> = {}): LaunchTarget => ({
  baseUrl: "http://127.0.0.1:41234",
  token: "secret-key",
  model: "atomic-agent",
  modelGiven: false,
  extraArgs: [],
  ...over,
});

function integration(name: string) {
  const found = findLaunchIntegration(name);
  if (!found) throw new Error(`no integration ${name}`);
  return found;
}

describe("launch integrations (ATO-2172)", () => {
  it("finds integrations by id and alias, case-insensitively", () => {
    expect(integration("Claude").id).toBe("claude");
    expect(integration("claude-code").id).toBe("claude");
    expect(findLaunchIntegration("gemini")).toBeNull();
  });

  it("claude: base URL without /v1, key as auth token, shell API key cleared", () => {
    const plan = integration("claude").build(target({ extraArgs: ["--continue"] }));
    expect(plan.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41234",
      ANTHROPIC_AUTH_TOKEN: "secret-key",
      ANTHROPIC_API_KEY: "",
    });
    expect(plan.args).toEqual(["--continue"]);
    expect(plan.secretEnv).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
  });

  it("claude: --model sets the main and the small model", () => {
    const plan = integration("claude").build(target({ model: "qwen3-coder", modelGiven: true }));
    expect(plan.env.ANTHROPIC_MODEL).toBe("qwen3-coder");
    expect(plan.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("qwen3-coder");
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen3-coder");
  });

  it("codex: a responses-API provider through -c overrides; the key only in the env", () => {
    const plan = integration("codex").build(target({ extraArgs: ["exec", "fix it"] }));
    expect(plan.args).toEqual([
      "-c", 'model_provider="atomic"',
      "-c", 'model_providers.atomic.name="Atomic Agent"',
      "-c", 'model_providers.atomic.base_url="http://127.0.0.1:41234/v1"',
      "-c", `model_providers.atomic.env_key="${LAUNCH_TOKEN_ENV}"`,
      "-c", 'model_providers.atomic.wire_api="responses"',
      "-m", "atomic-agent",
      "exec", "fix it",
    ]);
    expect(plan.env).toEqual({ [LAUNCH_TOKEN_ENV]: "secret-key" });
    expect(plan.args.join(" ")).not.toContain("secret-key");
  });

  it("opencode: inline config pointing at /v1, key referenced from the env", () => {
    const plan = integration("opencode").build(target({ model: "local" }));
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT as string);
    expect(config.model).toBe("atomic/local");
    expect(config.provider.atomic.options).toEqual({
      baseURL: "http://127.0.0.1:41234/v1",
      apiKey: `{env:${LAUNCH_TOKEN_ENV}}`,
    });
    expect(config.provider.atomic.npm).toBe("@ai-sdk/openai-compatible");
    expect(plan.env.OPENCODE_CONFIG_CONTENT).not.toContain("secret-key");
    expect(plan.env[LAUNCH_TOKEN_ENV]).toBe("secret-key");
    expect(openCodeConfig(target())).toContain('"atomic-agent"');
  });

  it("quotes TOML strings", () => {
    expect(tomlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });

  it("qwen: OPENAI_* env with the key, --model and --auth-type openai unless given (ATO-2449)", () => {
    const plan = integration("qwen-code").build(target({ model: "qwen-local" }));
    expect(plan.env).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:41234/v1",
      OPENAI_API_KEY: "secret-key",
      OPENAI_MODEL: "qwen-local",
    });
    expect(plan.args).toEqual(["--model", "qwen-local", "--auth-type", "openai"]);
    expect(plan.secretEnv).toEqual(["OPENAI_API_KEY"]);
    const own = integration("qwen").build(target({ extraArgs: ["-m", "x", "--auth-type=qwen-oauth", "-p", "hi"] }));
    expect(own.args).toEqual(["-m", "x", "--auth-type=qwen-oauth", "-p", "hi"]);
  });

  it("cline: saves the openai provider with `cline auth` first, then runs it; the key is only in that step (ATO-2449)", () => {
    const plan = integration("cline").build(target({ model: "qwen-local", extraArgs: ["fix the tests"] }));
    expect(plan.setup).toEqual([
      ["auth", "-p", "openai", "-k", "secret-key", "-b", "http://127.0.0.1:41234/v1", "-m", "qwen-local"],
    ]);
    expect(plan.secretArgs).toEqual(["secret-key"]);
    expect(plan.args).toEqual(["-P", "openai", "-m", "qwen-local", "fix the tests"]);
    expect(plan.args.join(" ")).not.toContain("secret-key");
  });

  it("gemini is not offered: Gemini CLI speaks only the Gemini API (ATO-2449)", () => {
    expect(findLaunchIntegration("gemini")).toBeNull();
  });
});
