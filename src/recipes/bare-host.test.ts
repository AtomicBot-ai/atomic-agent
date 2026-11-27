import { describe, expect, it } from "vitest";

import { findBareHost, hasBareHost } from "./bare-host.js";

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
