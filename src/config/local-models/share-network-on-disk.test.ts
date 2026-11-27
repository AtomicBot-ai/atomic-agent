import { describe, expect, it } from "vitest";

import { withoutStaleShareNetwork } from "./share-network-on-disk.js";

/** ATO-2483: a raw config write never keeps the network choice behind an off. */
describe("withoutStaleShareNetwork", () => {
  it("drops shareNetwork while share is off, absent or a false string", () => {
    for (const share of [false, undefined, "false", "off"]) {
      const out = withoutStaleShareNetwork({ localModels: { managed: { share, shareNetwork: true, sharePort: 9100 } } });
      expect(out).toEqual({ localModels: { managed: { share, sharePort: 9100 } } });
    }
  });

  it("keeps it while sharing is on, and leaves a tree without it untouched", () => {
    const on = { localModels: { managed: { share: true, shareNetwork: true } } };
    expect(withoutStaleShareNetwork(on)).toBe(on);
    const asText = { localModels: { managed: { share: "true", shareNetwork: true } } };
    expect(withoutStaleShareNetwork(asText)).toBe(asText);
    const plain = { localModels: { url: "http://127.0.0.1:9931" } };
    expect(withoutStaleShareNetwork(plain)).toBe(plain);
    expect(withoutStaleShareNetwork({})).toEqual({});
  });
});
