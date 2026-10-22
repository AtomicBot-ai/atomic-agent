import { describe, expect, it } from "vitest";

import { buildMcpStdioEnv, MCP_INHERITED_ENV_VARS } from "./mcp-stdio-env.js";

const AGENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  LANG: "en_US.UTF-8",
  OPENAI_API_KEY: "leak-openai",
  EXA_API_KEY: "leak-exa",
  TELEGRAM_BOT_TOKEN: "leak-telegram",
  ANTHROPIC_API_KEY: "leak-anthropic",
  ATOMIC_AGENT_STATE_DIR: "/home/op/.atomic-agent",
};

describe("buildMcpStdioEnv (ATO-346)", () => {
  it("passes service variables and never provider keys or bot tokens", () => {
    const env = buildMcpStdioEnv(undefined, AGENT_ENV);
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("EXA_API_KEY");
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
  });

  it("adds the server's own env, which wins on collision", () => {
    const env = buildMcpStdioEnv(
      { GITHUB_PERSONAL_ACCESS_TOKEN: "own-token", PATH: "/opt/bin" },
      AGENT_ENV,
    );
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("own-token");
    expect(env.PATH).toBe("/opt/bin");
    expect(env.HOME).toBe("/home/op");
  });

  it("forwards a key only when the server's config names it", () => {
    const env = buildMcpStdioEnv({ EXA_API_KEY: "for-this-server" }, AGENT_ENV);
    expect(env.EXA_API_KEY).toBe("for-this-server");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("matches Windows names without regard to case, keeping their spelling", () => {
    const env = buildMcpStdioEnv(undefined, {
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      APPDATA: "C:\\Users\\op\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\op",
      TEMP: "C:\\Users\\op\\AppData\\Local\\Temp",
      https_proxy: "http://proxy:3128",
      OpenAI_Api_Key: "leak",
    });
    expect(env).toEqual({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      APPDATA: "C:\\Users\\op\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\op",
      TEMP: "C:\\Users\\op\\AppData\\Local\\Temp",
      https_proxy: "http://proxy:3128",
    });
  });

  it("skips exported shell functions and undefined values", () => {
    const env = buildMcpStdioEnv(undefined, {
      PATH: "/bin",
      SHELL: "() { evil; }",
      HOME: undefined,
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("keeps the list free of credential-shaped names", () => {
    for (const name of MCP_INHERITED_ENV_VARS) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
    }
  });
});
