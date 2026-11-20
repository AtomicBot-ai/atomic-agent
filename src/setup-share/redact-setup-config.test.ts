import { describe, expect, it } from "vitest";

import { buildShareableConfig, looksLikeKey } from "./redact-setup-config.js";

const KEY = "sk-live-0123456789abcdefghij";

describe("buildShareableConfig", () => {
  it("keeps only MCP servers, providers and persona definitions", () => {
    const r = buildShareableConfig({
      mcp: { servers: [{ name: "files", transport: { kind: "stdio", command: "mcp-files" } }] },
      llm: { activeTextProvider: "groq", providers: [{ id: "groq", kind: "openai-compatible", baseUrl: "https://x.test/v1" }] },
      agent: { approvalLevel: "auto", personas: { active: "p", projects: { "/Users/me/work": "p" }, definitions: { p: { instructions: "Be brief." } } } },
      channels: { telegram: { botToken: "123:abc" } },
      skills: { projectTrust: [{ folder: "/Users/me/work" }] },
    });
    expect(Object.keys(r.config).sort()).toEqual(["agent", "llm", "mcp"]);
    expect(r.config.agent).toEqual({ personas: { projects: {}, definitions: { p: { instructions: "Be brief." } } } });
    expect(r.config.llm).toEqual({ providers: [{ id: "groq", kind: "openai-compatible", baseUrl: "https://x.test/v1" }] });
    expect(JSON.stringify(r.config)).not.toContain("123:abc");
    expect(JSON.stringify(r.config)).not.toContain("/Users/me/work");
    expect(r).toMatchObject({ mcpServers: ["files"], providers: ["groq"], personas: ["p"] });
  });

  it("blanks provider keys and secret headers but keeps the name of the env var", () => {
    const r = buildShareableConfig({
      llm: { providers: [{ id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai", apiKey: KEY, apiKeyEnvVar: "GROQ_API_KEY", apiKeyHeader: "x-api-key", headers: { Authorization: `Bearer ${KEY}` } }] },
    });
    const p = (r.config.llm as { providers: Array<Record<string, unknown>> }).providers[0]!;
    expect(p.apiKey).toBe("");
    expect(p.apiKeyEnvVar).toBe("GROQ_API_KEY");
    expect(p.apiKeyHeader).toBe("x-api-key");
    expect(p.headers).toEqual({ Authorization: "" });
    expect(r.redacted).toEqual(expect.arrayContaining(["llm.providers[groq].apiKey", "llm.providers[groq].headers.Authorization"]));
  });

  it("drops a provider's key command whole and lists it", () => {
    const r = buildShareableConfig({
      llm: { providers: [{ id: "vertex", kind: "openai-compatible", baseUrl: "https://x.test/v1", apiKeyCommand: ["gcloud", "auth", "print-access-token"] }] },
    });
    const p = (r.config.llm as { providers: Array<Record<string, unknown>> }).providers[0]!;
    expect("apiKeyCommand" in p).toBe(false);
    expect(p).toEqual({ id: "vertex", kind: "openai-compatible", baseUrl: "https://x.test/v1" });
    expect(r.redacted).toEqual(["llm.providers[vertex].apiKeyCommand"]);
  });

  it("keeps key env var names only for a known service at its own address", () => {
    const r = buildShareableConfig({
      llm: {
        providers: [
          { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnvVar: "OPENAI_API_KEY" },
          { id: "or", kind: "openrouter", apiKeyEnvVar: "OPENROUTER_API_KEY" },
          { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai", apiKeyEnvVar: "GROQ_API_KEY", extraApiKeyEnvVars: ["GROQ_API_KEY_2", "MY_OTHER_KEY"] },
          { id: "proxy", kind: "openai-compatible", baseUrl: "https://proxy.example/v1", apiKeyEnvVar: "OPENAI_API_KEY" },
          { id: "mixed", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai", apiKeyEnvVar: "OPENAI_API_KEY" },
          { id: "home", kind: "openai-compatible", baseUrl: "https://llm.example", apiKeyEnvVar: "MY_LLM_KEY" },
          { id: "azure", kind: "openai-compatible", baseUrl: "https://evil.openai.azure.com/openai", apiKeyEnvVar: "AZURE_OPENAI_API_KEY" },
          { id: "bedrock", kind: "openai-compatible", baseUrl: "https://bedrock-mantle.us-east-1.api.aws", apiKeyEnvVar: "AWS_BEARER_TOKEN_BEDROCK" },
        ],
      },
    });
    const byId = Object.fromEntries((r.config.llm as { providers: Array<Record<string, unknown>> }).providers.map((p) => [p.id, p]));
    expect(byId.openai!.apiKeyEnvVar).toBe("OPENAI_API_KEY");
    expect(byId.or!.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expect(byId.groq!.apiKeyEnvVar).toBe("GROQ_API_KEY");
    expect(byId.groq!.extraApiKeyEnvVars).toEqual(["GROQ_API_KEY_2"]);
    expect("apiKeyEnvVar" in byId.proxy!).toBe(false);
    expect("apiKeyEnvVar" in byId.mixed!).toBe(false);
    expect("apiKeyEnvVar" in byId.home!).toBe(false);
    expect("apiKeyEnvVar" in byId.azure!).toBe(false);
    expect("apiKeyEnvVar" in byId.bedrock!).toBe(false);
    expect(r.redacted).toEqual(expect.arrayContaining([
      "llm.providers[groq].extraApiKeyEnvVars",
      "llm.providers[proxy].apiKeyEnvVar",
      "llm.providers[mixed].apiKeyEnvVar",
      "llm.providers[home].apiKeyEnvVar",
      "llm.providers[azure].apiKeyEnvVar",
      "llm.providers[bedrock].apiKeyEnvVar",
    ]));
    expect(r.redacted).not.toContain("llm.providers[openai].apiKeyEnvVar");
  });

  it("blanks every MCP env value, header, secret flag argument and URL credential", () => {
    const r = buildShareableConfig({
      mcp: {
        servers: [
          {
            name: "github",
            env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123", REGION: "eu" },
            transport: { kind: "stdio", command: "gh-mcp", args: ["--api-key", KEY, "--token=hunter2", "--verbose", "serve"] },
          },
          {
            name: "remote",
            transport: { kind: "sse", url: "https://u:p@mcp.example.com/sse?api_key=abc&team=t", headers: { "X-Custom": "anything" } },
          },
        ],
      },
    });
    const text = JSON.stringify(r.config);
    for (const secret of ["ghp_abcdefghijklmnopqrstuvwxyz0123", KEY, "hunter2", "api_key=abc", "u:p@", "anything"]) {
      expect(text).not.toContain(secret);
    }
    const [github, remote] = (r.config.mcp as { servers: Array<Record<string, any>> }).servers;
    expect(github!.env).toEqual({ GITHUB_TOKEN: "", REGION: "" });
    expect(github!.transport.args).toEqual(["--api-key", "", "--token=", "--verbose", "serve"]);
    expect(remote!.transport.url).toContain("mcp.example.com/sse");
    expect(remote!.transport.url).toContain("team=t");
    expect(r.redacted).toEqual(expect.arrayContaining([
      "mcp.servers[github].env.GITHUB_TOKEN",
      "mcp.servers[github].transport.args[1]",
      "mcp.servers[github].transport.args[2]",
      "mcp.servers[remote].transport.url",
      "mcp.servers[remote].transport.headers.X-Custom",
    ]));
  });

  it("blanks a key-shaped value wherever it is", () => {
    const r = buildShareableConfig({ agent: { personas: { definitions: { p: { instructions: `use ${KEY} for calls` } } } } });
    expect(JSON.stringify(r.config)).not.toContain(KEY);
    expect(r.redacted).toEqual(["agent.personas.definitions.p.instructions"]);
    expect(looksLikeKey("plain words")).toBe(false);
  });
});
