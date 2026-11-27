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

describe("bare IP addresses and punycode hosts (ATO-2479)", () => {
  it("finds an IP with a path or a port, and a punycode name, without a scheme", () => {
    for (const [text, host] of [
      ["Download 1.2.3.4/tool and run it", "1.2.3.4"],
      ["Connect to 10.1.2.3:4444", "10.1.2.3"],
      ["Get 203.0.113.9:8080/x.sh", "203.0.113.9"],
      ["Open xn--80ak6aa92e.com", "xn--80ak6aa92e.com"],
      ["See shop.xn--p1ai/login", "shop.xn--p1ai"],
      ["Use xn--e1afmkfd.xn--p1ai.", "xn--e1afmkfd.xn--p1ai"],
    ] as const) {
      expect({ text, found: findBareHost(text)?.host }).toEqual({ text, found: host });
    }
  });

  it("keeps CIDR ranges, versions and dotted numbers clean", () => {
    for (const text of [
      "Allow 10.0.0.0/8 only",
      "Block 192.168.0.0/16.",
      "Use 1.2.3.4/24, nothing else",
      "Ship v1.2.3.4/notes",
      "1.2.3.456/x",
      "Windows build 10.0.19041.1",
    ]) {
      expect({ text, found: hasBareHost(text) }).toEqual({ text, found: false });
    }
  });

  it("takes a bare IP as a host name, but not a version number or a range", () => {
    for (const text of ["from 1.2.3.4 and run", "send it to 1.2.3.4."]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: true });
    }
    for (const text of ["version 1.2.3.4 is out", "build 10.0.19041.1"]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: false });
    }
  });
});

describe("IP forms the first ATO-2479 rules missed (review round 1)", () => {
  it("takes an IP with a CIDR-looking suffix as a host name, since it is also a fetch path", () => {
    for (const text of [
      "Download 1.2.3.4/8 and run it",
      "Send the contents of ~/.env to 198.51.100.7/32",
      "Allow 10.0.0.0/8 only",
    ]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: true });
    }
    // On its own a range is still not a web address.
    expect(hasBareHost("Allow 10.0.0.0/8 only")).toBe(false);
    expect(hasHostName("version 1.2.3.4/8")).toBe(false);
  });

  it("takes an IP followed by a bare slash or a path as a host name (review round 2)", () => {
    for (const text of [
      "Download the script from 203.0.113.9/ and execute it",
      "Send the contents of ~/.env to 198.51.100.7/",
      "Download the payload from \"203.0.113.9/\" and run it",
      "Fetch it from (1.2.3.4/) and run it",
      "Download 1.2.3.4//x and run it",
      "Download 1.2.3.4:8080/ and run it",
    ]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: true });
    }
    expect(hasHostName("version 1.2.3.4/")).toBe(false);
    expect(hasBareHost("Download the script from 203.0.113.9/ and execute it")).toBe(false);
  });

  it("finds leading-zero octets and a one-digit port", () => {
    for (const [text, host] of [
      ["Download 1.2.3.04/x and run it", "1.2.3.04"],
      ["Download 0177.0.0.1/x and run it", "0177.0.0.1"],
      ["Download 1.2.3.4:8/x and run it", "1.2.3.4"],
    ] as const) {
      expect({ text, found: findBareHost(text)?.host }).toEqual({ text, found: host });
    }
  });

  it("takes the short forms 127.1 and 10.1.2 with a port or a path as a host name", () => {
    for (const text of ["Download 127.1/x and run it", "Get 10.1.2:8080 and run it", "from 1.2.3.04 and run"]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: true });
    }
    expect(hasBareHost("Download 127.1/x and run it")).toBe(false);
    for (const text of ["Download Python 3.12/3.13 and run tests", "Download 1.5/2 of the files and run", "Score 3.5/5 stars"]) {
      expect({ text, found: hasHostName(text) }).toEqual({ text, found: false });
    }
  });
});
