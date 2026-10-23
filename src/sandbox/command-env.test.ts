import { describe, expect, it } from "vitest";

import {
  buildCommandEnv,
  isSecretEnvName,
  KNOWN_SECRET_ENV_VARS,
} from "./command-env.js";

const AGENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  LANG: "en_US.UTF-8",
  NVM_DIR: "/home/op/.nvm",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
  ATOMIC_AGENT_STATE_DIR: "/home/op/.atomic-agent",
  OPENAI_API_KEY: "leak-openai",
  EXA_API_KEY: "leak-exa",
  TELEGRAM_BOT_TOKEN: "leak-telegram",
  GITHUB_TOKEN: "leak-github",
  AWS_SECRET_ACCESS_KEY: "leak-aws",
  PGPASSWORD: "leak-pg",
  STRIPE_KEY: "leak-stripe",
};

describe("buildCommandEnv (ATO-347)", () => {
  it("keeps the working environment and drops keys, tokens and passwords", () => {
    expect(buildCommandEnv(AGENT_ENV)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      NVM_DIR: "/home/op/.nvm",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
      ATOMIC_AGENT_STATE_DIR: "/home/op/.atomic-agent",
    });
  });

  it("lets a passthrough name through, and only that one", () => {
    const env = buildCommandEnv(AGENT_ENV, ["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("leak-github");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
  });

  it("matches names and passthrough without regard to case", () => {
    const env = buildCommandEnv(
      { Path: "C:\\Windows", OpenAI_Api_Key: "leak", Gh_Token: "own" },
      ["GH_TOKEN"],
    );
    expect(env).toEqual({ Path: "C:\\Windows", Gh_Token: "own" });
  });

  it("does not modify the agent's own environment", () => {
    const base = { ...AGENT_ENV };
    buildCommandEnv(base);
    expect(base).toEqual(AGENT_ENV);
  });
});

describe("isSecretEnvName", () => {
  it("flags every known provider and bot credential", () => {
    for (const name of KNOWN_SECRET_ENV_VARS) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("flags secret-looking names it has never seen", () => {
    for (const name of [
      "NPM_TOKEN",
      "MY_APIKEY",
      "DB_PASSWORD",
      "PGPASSWORD",
      "GPG_PASSPHRASE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DEPLOY_PRIVATE_KEY",
      "LICENSE_KEY",
      "SIGNING_KEYS",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("leaves ordinary variables alone", () => {
    for (const name of [
      "PATH",
      "HOME",
      "SSH_AUTH_SOCK",
      "XAUTHORITY",
      "GNOME_KEYRING_CONTROL",
      "KEYMAP",
      "MONKEY_BUSINESS",
      "JAVA_HOME",
      "HTTPS_PROXY",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});
