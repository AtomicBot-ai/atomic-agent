import { describe, expect, it } from "vitest";

import { parseImessageOptions } from "./imessage-options.js";

describe("parseImessageOptions", () => {
  it("defaults to `imsg` on PATH and direct chats only", () => {
    expect(parseImessageOptions({})).toEqual({ ok: true, value: { binary: "imsg", allowGroups: false } });
  });

  it("reads a custom binary and allowGroups, ignoring unknown keys", () => {
    expect(parseImessageOptions({ binary: " /opt/homebrew/bin/imsg ", allowGroups: true, future: 1 })).toEqual({
      ok: true,
      value: { binary: "/opt/homebrew/bin/imsg", allowGroups: true },
    });
  });

  it("rejects wrong types instead of guessing", () => {
    expect(parseImessageOptions({ binary: "" }).ok).toBe(false);
    expect(parseImessageOptions({ binary: 3 }).ok).toBe(false);
    expect(parseImessageOptions({ allowGroups: "yes" }).ok).toBe(false);
  });
});
