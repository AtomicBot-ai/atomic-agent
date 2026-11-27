import { describe, expect, it } from "vitest";

import { buildApiKeyCommandEnv } from "./api-key-command-env.js";

const AGENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  LANG: "en_US.UTF-8",
  PASSWORD_STORE_DIR: "/home/op/.password-store",
  // The agent's own provider and bot keys, loaded from <stateDir>/.env.
  OPENAI_API_KEY: "leak-openai",
  ANTHROPIC_API_KEY: "leak-anthropic",
  TELEGRAM_BOT_TOKEN: "leak-telegram",
  GH_TOKEN: "leak-gh",
  AWS_BEARER_TOKEN_BEDROCK: "leak-bedrock",
  MY_CORP_LLM_KEY: "leak-custom",
  // Sign-ins a credential helper needs.
  OP_SESSION_my: "op-session",
  OP_SERVICE_ACCOUNT_TOKEN: "op-sa",
  BW_SESSION: "bw-session",
  VAULT_TOKEN: "vault",
  AWS_PROFILE: "work",
  AWS_SESSION_TOKEN: "aws-session",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AZURE_CLIENT_SECRET: "azure",
  CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/home/op/token",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/op/sa.json",
};

describe("buildApiKeyCommandEnv (ATO-1716)", () => {
  it("drops the agent's other keys and keeps the working environment", () => {
    const env = buildApiKeyCommandEnv(AGENT_ENV);
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "GH_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "MY_CORP_LLM_KEY",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.PASSWORD_STORE_DIR).toBe("/home/op/.password-store");
  });

  it("keeps the sign-ins of password managers and cloud CLIs", () => {
    const env = buildApiKeyCommandEnv(AGENT_ENV);
    expect(env).toMatchObject({
      OP_SESSION_my: "op-session",
      OP_SERVICE_ACCOUNT_TOKEN: "op-sa",
      BW_SESSION: "bw-session",
      VAULT_TOKEN: "vault",
      AWS_PROFILE: "work",
      AWS_SESSION_TOKEN: "aws-session",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AZURE_CLIENT_SECRET: "azure",
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/home/op/token",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/op/sa.json",
    });
  });
});
