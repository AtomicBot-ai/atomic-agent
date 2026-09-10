import { describe, expect, it } from "vitest";

import { atomicMailIntegration } from "./atomic-mail-integration.js";
import { presentFieldKeys } from "./integration-secrets.js";

function status(present: string[], state?: string) {
  return atomicMailIntegration.status({
    presentFields: new Set(present),
    configured: present.includes("apiKey") && present.includes("ownerEmail"),
    channelStates: new Map(state ? [["atomic-mail", state]] : []),
  });
}

describe("atomicMailIntegration", () => {
  it("walks the operator from no inbox to a verified owner", () => {
    expect(status([])).toMatchObject({
      level: "not_configured",
      detail: "no inbox yet — press r",
    });
    expect(status(["apiKey", "address"])).toMatchObject({
      level: "configured",
      detail: "inbox ready — add your e-mail",
    });
    expect(
      status(["apiKey", "address", "ownerEmail"], "pending"),
    ).toMatchObject({ level: "configured" });
    expect(
      status(["apiKey", "address", "ownerEmail"], "verified"),
    ).toMatchObject({ level: "connected", detail: "owner verified" });
  });

  it("offers register only before there is a key, resend only once there is an address to send to", () => {
    const actions = atomicMailIntegration.actions!;
    const ctx = (present: string[]) => ({
      presentFields: new Set(present),
      configured: false,
    });
    expect(actions.find((a) => a.id === "register")!.available!(ctx([]))).toBe(
      true,
    );
    expect(
      actions.find((a) => a.id === "register")!.available!(ctx(["apiKey"])),
    ).toBe(false);
    expect(
      actions.find((a) => a.id === "resend")!.available!(ctx(["apiKey"])),
    ).toBe(false);
    expect(
      actions.find((a) => a.id === "resend")!.available!(
        ctx(["apiKey", "ownerEmail"]),
      ),
    ).toBe(true);
  });

  it("reads the address from config, the key from the env, and never stores the code", () => {
    const present = presentFieldKeys(
      atomicMailIntegration,
      { ATOMIC_MAIL_API_KEY: "k" },
      { atomicMail: { address: "atag-1@atomicmail.ai", ownerEmail: "v@x.io" } },
    );
    expect([...present].sort()).toEqual(["address", "apiKey", "ownerEmail"]);
    const code = atomicMailIntegration.fields.find(
      (f) => f.key === "verificationCode",
    )!;
    expect(code.store).toBe("transient");
    expect(code.validate!("482913")).toBeUndefined();
    expect(code.validate!("482-913")).toBeUndefined();
    expect(code.validate!("48291")).toMatch(/Six digits/);
    const owner = atomicMailIntegration.fields.find(
      (f) => f.key === "ownerEmail",
    )!;
    expect(owner.validate!("not an address")).toMatch(/e-mail/);
    expect(
      atomicMailIntegration.fields.find((f) => f.key === "address")!.readonly,
    ).toBe(true);
  });
});
