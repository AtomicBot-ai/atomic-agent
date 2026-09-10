import { describe, expect, it } from "vitest";

import {
  COMPOSIO_API_KEY_ENV,
  resolveComposioApiKey,
} from "./resolve-composio-key.js";

describe("resolveComposioApiKey", () => {
  it("reads the default env var", () => {
    expect(
      resolveComposioApiKey({ env: { [COMPOSIO_API_KEY_ENV]: "ak_1" } }),
    ).toBe("ak_1");
  });

  it("honours a custom env var name from config", () => {
    expect(
      resolveComposioApiKey({
        apiKeyEnv: "MY_COMPOSIO",
        env: { MY_COMPOSIO: "ak_2", [COMPOSIO_API_KEY_ENV]: "ak_wrong" },
      }),
    ).toBe("ak_2");
  });

  it("trims surrounding whitespace from a pasted key", () => {
    expect(
      resolveComposioApiKey({ env: { [COMPOSIO_API_KEY_ENV]: "  ak_3\n" } }),
    ).toBe("ak_3");
  });

  it("treats an unset var as unconfigured", () => {
    expect(resolveComposioApiKey({ env: {} })).toBeUndefined();
  });

  it("treats an empty or whitespace-only var as unconfigured", () => {
    // A blank value is how clearing the key lands in .env; it must read
    // as "no key" rather than as an empty key that fails at connect.
    expect(
      resolveComposioApiKey({ env: { [COMPOSIO_API_KEY_ENV]: "" } }),
    ).toBeUndefined();
    expect(
      resolveComposioApiKey({ env: { [COMPOSIO_API_KEY_ENV]: "   " } }),
    ).toBeUndefined();
  });

  it("falls back to the default name when config passes an empty one", () => {
    expect(
      resolveComposioApiKey({
        apiKeyEnv: "",
        env: { [COMPOSIO_API_KEY_ENV]: "ak_4" },
      }),
    ).toBe("ak_4");
  });
});
