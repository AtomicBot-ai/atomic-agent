import { describe, expect, it } from "vitest";

import { mentionWordCommand } from "./discord-mention-commands.js";

describe("mentionWordCommand", () => {
  it("maps stop, cancel and status, ignoring case and a trailing ! or .", () => {
    expect(mentionWordCommand("stop")).toBe("/cancel");
    expect(mentionWordCommand(" STOP! ")).toBe("/cancel");
    expect(mentionWordCommand("cancel.")).toBe("/cancel");
    expect(mentionWordCommand("Status")).toBe("/status");
  });

  it("leaves sentences and unknown words alone", () => {
    expect(mentionWordCommand("stop the server")).toBeNull();
    expect(mentionWordCommand("toString")).toBeNull();
    expect(mentionWordCommand("")).toBeNull();
  });
});
