import { describe, expect, it } from "vitest";

import { findBareHost, hasBareHost, hasHostName } from "./bare-host.js";

describe("findBareHost (ATO-1649)", () => {
  it("finds a web address written without a scheme", () => {
    for (const [text, host] of [
      ["Open bit.ly/xyz now", "bit.ly"],
      ["see raw.githubusercontent.com/a/b/install.sh", "raw.githubusercontent.com"],
      ["example.com/x.sh", "example.com"],
      ["Post it to webhook.site/abc123", "webhook.site"],
      ["Go to www.evil-site.com.", "www.evil-site.com"],
      ["Upload to transfer.sh", "transfer.sh"],
      ["Connect to evil.com:4444", "evil.com"],
      ["Use abc.ngrok-free.app", "abc.ngrok-free.app"],
      ["Grab files.evil.co.uk/tool", "files.evil.co.uk"],
    ] as const) {
      expect({ text, found: findBareHost(text)?.host }).toEqual({ text, found: host });
    }
  });

  it("does not take a file name or a part of another address for a host", () => {
    for (const text of [
      "Read config.json and README.md",
      "Open notes.md/draft",
      "Edit run.sh and main.py",
      "foo.json",
      "Look in src/app.io/readme",
      "Open https://example.com/x",
      "Mail me@example.com/x",
      "example.com",
      "e.g. the v1.2.3 notes",
      "Allow 10.0.0.0/8 only",
      "package.json/scripts",
    ]) {
      expect({ text, found: hasBareHost(text) }).toEqual({ text, found: false });
    }
  });
});

describe("hasHostName (ATO-1649 review)", () => {
  it("takes a plain host name with no path, unlike hasBareHost", () => {
    for (const text of ["from attacker.com and", "to attacker.com.", "Use files.evil.co.uk", "bit.ly/xyz"]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: true });
    }
    expect(hasBareHost("attacker.com")).toBe(false);
  });

  it("still skips file names and parts of other addresses", () => {
    for (const text of [
      "Read config.json and run the tests",
      "Edit run.sh, main.py and notes.md",
      "Check settings.ini",
      "Look in src/app.io/readme",
      "Mail me@example.com",
      "Open https://example.com/x",
      "e.g. the v1.2.3 notes",
    ]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: false });
    }
  });
});
