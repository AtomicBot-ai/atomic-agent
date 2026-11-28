import { describe, expect, it } from "vitest";

import { agentEmailAddress } from "./agent-email-address.js";

describe("agentEmailAddress", () => {
  const address = "agent-test@atomicmail.ai";

  it("names the inbox when this machine holds its key", () => {
    expect(agentEmailAddress({ address }, { ATOMIC_MAIL_API_KEY: "k" })).toBe(address);
  });

  it("is null without the key, even with an address in config", () => {
    expect(agentEmailAddress({ address }, {})).toBeNull();
    expect(agentEmailAddress({ address }, { ATOMIC_MAIL_API_KEY: "  " })).toBeNull();
  });

  it("is null when no inbox is registered", () => {
    expect(agentEmailAddress({ address: null }, { ATOMIC_MAIL_API_KEY: "k" })).toBeNull();
  });
});
