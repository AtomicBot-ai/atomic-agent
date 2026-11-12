import { describe, expect, it } from "vitest";

import { redactForShare } from "./chat-export-redact.js";

const ctx = {
  homeDir: "/Users/nadya",
  workingDir: "/Users/nadya/work/shop",
  knownSecrets: [],
};

function clean(text: string, extra: Partial<typeof ctx> = {}): string {
  return redactForShare(text, { ...ctx, ...extra }).text;
}

describe("redactForShare", () => {
  it("keeps the tail of a path inside the project and hides the folder", () => {
    expect(clean("I changed /Users/nadya/work/shop/src/cart.ts")).toBe(
      "I changed <project>/src/cart.ts",
    );
  });

  it("does not let the project prefix eat a sibling folder", () => {
    expect(clean("see /Users/nadya/work/shop-2/a.ts")).toBe("see [path]");
  });

  it("hides home, tilde, other absolute and Windows paths entirely", () => {
    expect(clean("saved to /Users/nadya/Documents/taxes.pdf")).toBe("saved to [path]");
    expect(clean("open ~/Desktop/notes.md")).toBe("open [path]");
    expect(clean("mounted /Volumes/ClientName/q3/report.xlsx")).toBe("mounted [path]");
    expect(clean("at C:\\Users\\nadya\\file.txt now")).toBe("at [path] now");
    expect(clean("share \\\\fileserver\\team\\plan.docx")).toBe("share [path]");
  });

  it("leaves URLs, relative paths and dates alone", () => {
    const text = "see https://github.com/AtomicBot-ai/atomic-agent and src/a/b.ts on 12/11/2026";
    expect(clean(text)).toBe(text);
  });

  it("masks key shapes and secret-named values", () => {
    const out = clean(
      "key sk-ant-abcdefghijklmnopqrstuvwxyz012345 and ghp_abcdefghijklmnopqrstuvwxyz0123 and password=hunter2hunter2",
    );
    expect(out).not.toContain("sk-ant-abcdefghijklmnop");
    expect(out).not.toContain("ghp_abcdefghijklmnop");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("[secret]");
  });

  it("masks the exact values of the agent's own keys", () => {
    const out = redactForShare("my token is plainvalue123456 ok", {
      ...ctx,
      knownSecrets: [{ label: "OPENROUTER_API_KEY", value: "plainvalue123456" }],
    });
    expect(out.text).toBe("my token is [secret] ok");
    expect(out.counts.secrets).toBe(1);
  });

  it("masks a Telegram bot token and credentials in a URL", () => {
    const out = clean(
      "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq and https://bob:pa55word@example.com/x",
    );
    expect(out).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq");
    expect(out).not.toContain("pa55word");
  });

  it("hides emails, public IPs and URL query strings, keeps loopback", () => {
    const out = clean(
      "mail nadya@example.com, host 10.1.2.3, local 127.0.0.1, link https://x.com/a?token=abc&u=1",
    );
    expect(out).toBe("mail [email], host [ip], local 127.0.0.1, link https://x.com/a?…");
  });

  it("drops reasoning blocks that leaked into a reply", () => {
    const out = redactForShare("<think>the user lives at /Users/nadya</think>Done.", ctx);
    expect(out.text).toBe("Done.");
    expect(out.counts.reasoning).toBe(1);
  });

  it("counts what it replaced", () => {
    const out = redactForShare("/etc/app/conf and a@b.io", ctx);
    expect(out.counts).toMatchObject({ paths: 1, personal: 1, secrets: 0 });
  });

  it("does not treat the home folder as the project", () => {
    expect(clean("/Users/nadya/x/y.txt", { workingDir: "/Users/nadya" })).toBe("[path]");
  });
});
