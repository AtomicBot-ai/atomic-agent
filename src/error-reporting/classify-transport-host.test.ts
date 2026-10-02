import { describe, expect, it } from "vitest";

import {
  DEFAULT_AIMLAPI_BASE,
} from "../llm/provider/aimlapi/aimlapi-provider.js";
import { DEFAULT_GEMINI_BASE } from "../llm/provider/gemini/gemini-provider.js";
import {
  DEFAULT_OPENROUTER_BASE,
} from "../llm/provider/openrouter/openrouter-provider.js";
import { PROVIDER_PRESETS } from "../llm/provider/presets/provider-presets.js";
import {
  OPENAI_COMPAT_DEFAULT_BASE_URL,
} from "../tui/providers/providers-model-options.js";
import {
  classifyTransportHost,
  KNOWN_CLOUD_HOSTS,
} from "./classify-transport-host.js";

describe("classifyTransportHost", () => {
  it.each([
    "http://localhost:8080/completion",
    "http://LOCALHOST:1234",
    "http://llama.localhost:8080",
    "http://127.0.0.1:8095/v1/chat/completions",
    "http://127.10.0.3",
    "http://[::1]:8080",
    "http://0.0.0.0:11434",
  ])("%s is localhost", (url) => {
    expect(classifyTransportHost(url)).toBe("localhost");
  });

  it.each([
    "http://10.0.0.5:8080",
    "http://172.16.4.2",
    "http://172.31.255.1",
    "http://192.168.1.20:1234",
    "http://169.254.10.10",
    "http://gpu-box:8080",
    "http://studio.local:1234",
    "http://nas.lan",
    "http://llm.corp.internal/v1",
    "http://box.home.arpa",
    "http://[fd12:3456::1]:8080",
    "http://[fe80::1]",
  ])("%s is private", (url) => {
    expect(classifyTransportHost(url)).toBe("private");
  });

  it.each([
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.anthropic.com/v1",
    "https://api.groq.com/openai/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    "https://api.openai.com/v1",
  ])("%s is known_cloud", (url) => {
    expect(classifyTransportHost(url)).toBe("known_cloud");
  });

  it.each([
    "https://llm.acme-corp.com/v1",
    "http://172.32.0.1",
    "http://8.8.8.8",
    "https://evil-openrouter.ai.example.com",
  ])("%s is other", (url) => {
    expect(classifyTransportHost(url)).toBe("other");
  });

  it("returns undefined for an unparseable url", () => {
    expect(classifyTransportHost("not a url")).toBeUndefined();
  });

  it("knows every non-local preset host and every built-in provider host", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.local === true) continue;
      expect(KNOWN_CLOUD_HOSTS.has(new URL(preset.baseUrl).hostname)).toBe(
        true,
      );
    }
    for (const base of [
      DEFAULT_OPENROUTER_BASE,
      DEFAULT_AIMLAPI_BASE,
      DEFAULT_GEMINI_BASE,
      OPENAI_COMPAT_DEFAULT_BASE_URL,
    ]) {
      expect(KNOWN_CLOUD_HOSTS.has(new URL(base).hostname)).toBe(true);
    }
  });

  it("never lists a local preset host as cloud", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.local === true)) {
      expect(classifyTransportHost(preset.baseUrl)).toBe("localhost");
    }
  });
});
