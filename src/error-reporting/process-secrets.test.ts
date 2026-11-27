import { afterEach, describe, expect, it } from "vitest";

import { clearProcessSecretsForTests, processSecrets, registerProcessSecret } from "./process-secrets.js";
import { maskSecrets } from "./secret-detector.js";

afterEach(() => clearProcessSecretsForTests());

describe("process secrets (ATO-1705)", () => {
  it("returns what was registered, one value per label", () => {
    registerProcessSecret("serve-api-key", "first0value1234");
    registerProcessSecret("serve-api-key", "9f3c2a7e5b1d8c4a6e0f2b9d7c5a3e1f");
    expect(processSecrets()).toEqual([{ label: "serve-api-key", value: "9f3c2a7e5b1d8c4a6e0f2b9d7c5a3e1f" }]);
  });

  it("ignores an empty value", () => {
    registerProcessSecret("serve-api-key", "");
    expect(processSecrets()).toEqual([]);
  });

  it("lets maskSecrets hide a key with no recognisable shape", () => {
    const key = "9f3c2a7e5b1d8c4a6e0f2b9d7c5a3e1f";
    registerProcessSecret("serve-api-key", key);
    const line = `node atag serve --port 51234 --api-key ${key}`;
    expect(maskSecrets(line)).toContain(key);
    expect(maskSecrets(line, processSecrets())).toBe(
      "node atag serve --port 51234 --api-key [redacted:serve-api-key]",
    );
  });
});
