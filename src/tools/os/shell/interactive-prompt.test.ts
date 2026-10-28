import { describe, expect, it } from "vitest";

import {
  detectInteractivePrompt,
  formatInteractiveHandoff,
} from "./interactive-prompt.js";

describe("detectInteractivePrompt (ATO-1252)", () => {
  it("reads a device-code sign-in with its link and code", () => {
    const out =
      "! First copy your one-time code: WDJB-MJHT\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
    expect(detectInteractivePrompt(out, "running")).toEqual({
      kind: "sign_in",
      need: expect.stringContaining("sign in"),
      url: "https://github.com/login/device",
      code: "WDJB-MJHT",
    });
  });

  it("reads a browser consent page the command waits on", () => {
    const out =
      "Opening browser for authorization: https://accounts.google.com/o/oauth2/auth?client_id=x\nWaiting for the callback...";
    const found = detectInteractivePrompt(out, "running");
    expect(found?.kind).toBe("sign_in");
    expect(found?.url).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it("does not read a dev server's local URL as a sign-in", () => {
    const vite = "  VITE v5.0.0  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose";
    expect(detectInteractivePrompt(vite, "running")).toBeNull();
    const jupyter = "To access the server, open this file in a browser:\n    file:///home/u/.local/share/jupyter/runtime/jpserver-1-open.html";
    expect(detectInteractivePrompt(jupyter, "running")).toBeNull();
  });

  it("reads a password or a yes/no question only on the last line", () => {
    expect(detectInteractivePrompt("Enter passphrase for key '/u/.ssh/id_ed25519': ", "running")?.kind).toBe("needs_input");
    expect(detectInteractivePrompt("Proceed with installation? [y/N] ", "running")?.kind).toBe("needs_input");
    expect(detectInteractivePrompt("Press any key to continue . . .", "running")?.kind).toBe("needs_input");
    // Mentioned earlier, then the build went on: not a prompt.
    expect(detectInteractivePrompt("Password: \ncompiling 1/20\ncompiling 2/20", "running")).toBeNull();
  });

  it("reads sudo and missing-terminal failures only once the command has ended", () => {
    const sudo = "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\n";
    expect(detectInteractivePrompt(sudo, "exited")?.need).toMatch(/sudo/);
    expect(detectInteractivePrompt(sudo, "running")).toBeNull();
    expect(detectInteractivePrompt("the input device is not a TTY\n", "exited")?.kind).toBe("needs_input");
    expect(detectInteractivePrompt("warning: stdin is not a tty\nbuilding…", "running")).toBeNull();
  });

  it("reads nothing in ordinary output", () => {
    expect(detectInteractivePrompt("", "running")).toBeNull();
    expect(detectInteractivePrompt("==> Pouring gogcli--0.9.0.arm64_sonoma.bottle.tar.gz\n🍺  /opt/homebrew/Cellar/gogcli/0.9.0: 8 files\n", "exited")).toBeNull();
    expect(detectInteractivePrompt("added 120 packages in 4s\n", "running")).toBeNull();
  });
});

describe("formatInteractiveHandoff", () => {
  it("names the kept job for a sign-in and the one step otherwise", () => {
    const signIn = formatInteractiveHandoff(
      { kind: "sign_in", need: "it needs you to sign in", url: "https://x.test/device", code: "ABCD-1234" },
      "gh auth login --web",
      { jobId: 4 },
    );
    expect(signIn).toContain("this step needs the user");
    expect(signIn).toContain("code: ABCD-1234");
    expect(signIn).toContain('{"wait": 4}');
    const stopped = formatInteractiveHandoff(
      { kind: "needs_input", need: "it asks for a password" },
      "sudo apt install jq",
      { ended: "failed" },
    );
    expect(stopped).toContain("`sudo apt install jq`");
    expect(stopped).toContain("keep doing every other step yourself");
  });
});
