import { describe, expect, it } from "vitest";
import { isLocalServerUrl } from "./local-server-url.js";

describe("isLocalServerUrl", () => {
  it("accepts loopback and private-network servers", () => {
    for (const url of ["http://localhost:8080/v1", "http://127.0.0.1:1234", "http://[::1]:8080", "http://10.0.0.5:8000",
      "http://172.20.1.2", "http://192.168.1.10:8080", "http://gpu-box:8080", "http://studio.local:1234", "http://[fd12::1]:8080"]) {
      expect(isLocalServerUrl(url)).toBe(true);
    }
  });

  it("rejects public endpoints and unparsable input", () => {
    for (const url of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://172.32.0.1", "http://8.8.8.8", "not a url", "", undefined]) {
      expect(isLocalServerUrl(url)).toBe(false);
    }
  });
});
