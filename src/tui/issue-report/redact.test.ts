import { describe, expect, it } from "vitest";

import {
  mapStrings,
  maskSecrets,
  redactPaths,
  redactPersonal,
  scrubText,
} from "./redact.js";

const CTX = {
  homeDir: "/Users/valerii",
  workingDir: "/Users/valerii/work/proj",
};

describe("maskSecrets", () => {
  it("masks every token shape we know about", () => {
    const text = [
      `ghp_${"A".repeat(36)}`,
      `github_pat_${"B".repeat(22)}_${"c".repeat(59)}`,
      `sk-${"x".repeat(40)}`,
      `sk-ant-${"y".repeat(40)}`,
      `xoxb-${"1".repeat(12)}-abc`,
      "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "AKIAABCDEFGHIJKLMNOP",
      `Authorization: Bearer ${"z".repeat(30)}`,
      `api_key=${"k".repeat(20)}`,
      `"token": "${"t".repeat(20)}"`,
      "https://user:hunter2@host.io/x",
    ].join("\n");
    const out = maskSecrets(text);
    expect(out).not.toMatch(
      /ghp_A|github_pat_B|sk-x|sk-ant-y|xoxb-1|AKIAABC|zzzzzz|kkkkkk|tttttt/,
    );
    expect(out).toContain("Authorization: Bearer <redacted>");
    expect(out).toContain("api_key=<redacted>");
    expect(out).toContain('"token": "<redacted>');
    expect(out).toContain("https://<redacted>@host.io/x");
    expect(out).not.toContain("hunter2");
  });

  it("leaves ordinary prose and short words alone", () => {
    const text = "The token field was empty; secret sauce is fine.";
    expect(maskSecrets(text)).toBe(text);
  });
});

describe("redactPersonal", () => {
  it("replaces the working dir, the home dir and other homes", () => {
    const out = redactPersonal(
      "at /Users/valerii/work/proj/src/a.ts and /Users/valerii/.config and /home/bob/x and C:\\Users\\Ann\\y",
      CTX,
    );
    expect(out).toBe("at <cwd>/src/a.ts and ~/.config and ~/x and ~\\y");
  });

  it("does not let the cwd prefix eat a sibling directory", () => {
    expect(
      redactPersonal(
        "/Users/valerii/work/proj-2/x and /Users/valerii/work/proj",
        CTX,
      ),
    ).toBe("<cwd>-2/x and <cwd>".replace("<cwd>-2/x", "~/work/proj-2/x"));
  });

  it("masks the JSON-escaped Windows home too", () => {
    expect(redactPersonal(String.raw`{"p":"C:\\Users\\Ann\\y"}`, CTX)).toBe(
      String.raw`{"p":"~\\y"}`,
    );
  });

  it("masks emails and non-loopback IPs, keeps loopback", () => {
    const out = redactPersonal(
      "mail me@example.com from 10.1.2.3 or 127.0.0.1",
      CTX,
    );
    expect(out).toBe("mail <email> from <ip> or 127.0.0.1");
  });

  it("drops URL query strings but keeps the path", () => {
    expect(redactPersonal("see https://x.io/a/b?key=1&u=me", CTX)).toBe(
      "see https://x.io/a/b?<query>",
    );
  });

  it("does not treat a one-character home dir as a pattern", () => {
    expect(redactPersonal("a/b/c", { homeDir: "/" })).toBe("a/b/c");
  });
});

describe("scrubText and mapStrings", () => {
  it("runs both passes and walks nested values including keys", () => {
    const value = {
      "/Users/valerii/k": [`ghp_${"A".repeat(36)}`, { deep: "me@x.io" }],
      n: 1,
      b: true,
    };
    expect(mapStrings(value, (s) => scrubText(s, CTX))).toEqual({
      "~/k": ["<token>", { deep: "<email>" }],
      n: 1,
      b: true,
    });
  });
});

describe("redactPaths", () => {
  it("masks absolute paths the home and cwd rules cannot know about", () => {
    const out = redactPaths(
      scrubText(
        "boom /opt/x/y at <cwd>/src/a.ts and ~/.cfg/x and https://x.io/a/b and /Volumes/Client/x.txt and /z",
        CTX,
      ),
    );
    expect(out).toBe(
      "boom <path> at <cwd>/src/a.ts and ~/.cfg/x and https://x.io/a/b and <path> and /z",
    );
  });
});
