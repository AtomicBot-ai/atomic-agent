import { afterEach, describe, expect, it } from "vitest";

import { resetOfflineNetworkForTests, setOfflineNetwork } from "../../llm/offline-network.js";
import { EMPTY_DOMAIN_POLICY } from "./browser-domain-policy.js";
import { gateBrowserUrl, offlineBrowserRefusal } from "./gate-browser-url.js";

const ctx = { sessionId: "s1", signal: new AbortController().signal };
const dangerous = { approvals: {} as never, approvalRequired: false };

describe("browser tools in offline mode (ATO-1084)", () => {
  afterEach(() => resetOfflineNetworkForTests());

  it("refuses a remote page and lets local ones through", async () => {
    setOfflineNetwork(true);
    const refused = await gateBrowserUrl(
      dangerous, EMPTY_DOMAIN_POLICY, "browser.navigate", "https://example.com/", ctx,
    );
    expect(refused?.status).toBe("error");
    expect(refused?.output).toContain("offline mode: example.com blocked");
    expect(refused?.details.reason).toBe("offline_mode");
    expect(
      await gateBrowserUrl(dangerous, EMPTY_DOMAIN_POLICY, "browser.navigate", "http://localhost:3000/", ctx),
    ).toBeNull();
    expect(offlineBrowserRefusal("browser.navigate", "about:blank")).toBeNull();
    expect(offlineBrowserRefusal("browser.navigate", "file:///tmp/a.html")).toBeNull();
    expect(offlineBrowserRefusal("browser.navigate", "view-source:https://example.com")).not.toBeNull();
  });

  it("changes nothing while offline mode is off", () => {
    expect(offlineBrowserRefusal("browser.navigate", "https://example.com/")).toBeNull();
  });
});
