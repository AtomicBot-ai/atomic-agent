import { expect, it } from "vitest";
import { coreDaemonEnv, isSecretEnvName } from "./core-env.js";

it("drops provider keys and secret-shaped variables", () => {
  const env = coreDaemonEnv({
    OPENAI_API_KEY: "sk-1", ANTHROPIC_API_KEY: "sk-2", OPENROUTER_API_KEY: "sk-3", OLLAMA_API_KEY: "k",
    Anthropic_Api_Key: "sk-4", AWS_SESSION_TOKEN: "t", DB_PASSWORD: "p", CLIENT_SECRET: "s",
    GOOGLE_APPLICATION_CREDENTIALS: "/c.json", SSH_AUTH_SOCK: "/sock", HF_TOKEN: "hf",
  });
  expect(env).toEqual({ ATOMIC_CORE_TELEMETRY: "off" });
});

it("keeps what Core needs to run and download backends", () => {
  const base = {
    PATH: "/usr/bin", HOME: "/home/u", TMPDIR: "/tmp", LANG: "en_US.UTF-8", LC_ALL: "C",
    HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u",
  };
  expect(coreDaemonEnv(base)).toEqual({ ...base, ATOMIC_CORE_TELEMETRY: "off" });
});

it("always disables Core telemetry", () => {
  expect(coreDaemonEnv({ ATOMIC_CORE_TELEMETRY: "on" }).ATOMIC_CORE_TELEMETRY).toBe("off");
  expect(isSecretEnvName("ATOMIC_CORE_TELEMETRY")).toBe(false);
});
