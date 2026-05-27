import { describe, expect, it } from "vitest";
import { shouldAutoApproveGogCommand } from "./gog-command-policy.js";

describe("shouldAutoApproveGogCommand", () => {
  it("auto-approves read-only Gmail commands with a narrow command surface", () => {
    expect(
      shouldAutoApproveGogCommand("gog", [
        "--json",
        "--no-input",
        "--account",
        "kalinalex91@gmail.com",
        "--wrap-untrusted",
        "--gmail-no-send",
        "--enable-commands",
        "gmail.search,gmail.get",
        "gmail",
        "search",
        "is:unread",
        "--max",
        "10",
      ]),
    ).toBe(true);
  });

  it("auto-approves auth list for account discovery", () => {
    expect(shouldAutoApproveGogCommand("gog", ["auth", "list"])).toBe(true);
  });

  it("does not auto-approve account mutation", () => {
    expect(
      shouldAutoApproveGogCommand("gog", ["auth", "add", "user@example.com"]),
    ).toBe(false);
  });

  it("does not auto-approve broad gog commands without --enable-commands", () => {
    expect(
      shouldAutoApproveGogCommand("gog", [
        "--json",
        "--no-input",
        "gmail",
        "search",
        "is:unread",
      ]),
    ).toBe(false);
  });

  it("does not auto-approve send-capable command surfaces", () => {
    expect(
      shouldAutoApproveGogCommand("gog", [
        "--json",
        "--no-input",
        "--enable-commands",
        "gmail.search,gmail.send",
        "gmail",
        "search",
        "is:unread",
      ]),
    ).toBe(false);
  });
});
