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

  it("drops it when the write turns sharing on from off: a stale network choice never comes back", () => {
    const tree = { localModels: { managed: { share: true, shareNetwork: true } } };
    for (const share of [false, undefined, "false"]) {
      expect(withoutStaleShareNetwork(tree, { localModels: { managed: { share, shareNetwork: true } } })).toEqual({ localModels: { managed: { share: true } } });
    }
    expect(withoutStaleShareNetwork(tree, {})).toEqual({ localModels: { managed: { share: true } } });
    // Already on before the write: the choice stays.
    expect(withoutStaleShareNetwork(tree, { localModels: { managed: { share: true, shareNetwork: true } } })).toBe(tree);
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
