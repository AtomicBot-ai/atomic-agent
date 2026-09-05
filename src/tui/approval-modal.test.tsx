import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ApprovalModal } from "./approval-modal.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "a1",
    sessionId: "s1",
    tool: "os.shell.run",
    category: "shell",
    reason: "dangerous command",
    ...overrides,
  };
}

/**
 * The modal takes the target-field props from the app shell; every test
 * that is not about the field renders it closed.
 */
function frameOf(req: ApprovalRequest, pathDraft: string | null = null): string {
  return (
    render(
      <ApprovalModal
        request={req}
        pathDraft={pathDraft}
        onPathOpen={() => {}}
        onPathChange={() => {}}
        onPathSubmit={() => {}}
        onPathCancel={() => {}}
      />,
    ).lastFrame() ?? ""
  );
}

describe("ApprovalModal", () => {
  it("renders the request and the decision buttons", () => {
    const frame = frameOf(request());
    expect(frame).toContain("approval required");
    expect(frame).toContain("os.shell.run");
    expect(frame).toContain("approve");
    expect(frame).toContain("deny");
    expect(frame).toContain("esc abort run");
  });

  it("prints each button's chord on the button", () => {
    // The chord is the keyboard path to the same control the mouse
    // clicks, so it belongs on the face rather than in a legend three
    // lines down that has to be kept in sync by hand.
    const frame = frameOf(request({ category: "shell", commandShape: "git" }));
    expect(frame).toContain("ctrl+y");
    expect(frame).toContain("ctrl+d");
    expect(frame).toContain("ctrl+f");
    expect(frame).toContain("ctrl+b");
  });

  it("never offers a bare letter as a decision", () => {
    // The regression this whole change exists to prevent: a bracketed
    // letter promises that typing it decides the call, and the composer
    // underneath is live.
    const frame = frameOf(request({ category: "shell", commandShape: "git" }));
    for (const marker of ["[y]", "[n]", "[s]", "[a]", "[e]"]) {
      expect(frame).not.toContain(marker);
    }
  });

  it("shows the ladder category label so the operator sees why it fired", () => {
    // R5: the prompt carries its `ApprovalCategory`; the modal renders a
    // human label (`file write · home`) so a home write reads differently
    // from a trust-config write.
    const frame = frameOf(request({ category: "fs_write_home" }));
    expect(frame).toContain("file write · home");
  });

  it("points at the composer coding-mode control so the off switch is discoverable", () => {
    // The footer hint is the discoverability answer to issue #79:
    // approving covers one call, the standing stance lives in the
    // composer's coding-mode control.
    const frame = frameOf(request());
    expect(frame).toContain("approve covers this call once");
    expect(frame).toContain("coding-mode control");
  });

  it("offers both session grants for a shell request with a shape", () => {
    const frame = frameOf(request({ category: "shell", commandShape: "git" }));
    expect(frame).toContain("this session");
    expect(frame).toContain("git");
  });

  it("offers the category grant but no shape grant for a non-shell request", () => {
    const frame = frameOf(request({ category: "fs_write_home" }));
    expect(frame).toContain("this session");
    expect(frame).toContain("ctrl+f");
    // Nothing to grant a shape for, so the shared slot stays empty.
    expect(frame).not.toContain("ctrl+b");
  });

  it("offers NO grants and warns for a trust_config request", () => {
    // trust_config is never grantable: approve / deny / esc, plus an
    // explicit note.
    const frame = frameOf(request({ category: "trust_config" }));
    expect(frame).not.toContain("this session");
    expect(frame).not.toContain("ctrl+f");
    expect(frame).toContain("approve");
    expect(frame).toContain("deny");
    expect(frame).toContain("never granted for the session");
  });

  it("offers the retarget button only when the request carries a path", () => {
    // The shell request has no target to move; the write does.
    expect(frameOf(request())).not.toContain("edit target path");
    const write = frameOf(
      request({
        tool: "os.fs.write",
        category: "fs_write_workspace",
        redirectablePath: "/work/site/index.html",
      }),
    );
    expect(write).toContain("edit target path");
    // Same slot, same chord as the shape grant — the two can never both
    // be offered, which `approval-key-arbitration.test.ts` pins.
    expect(write).toContain("ctrl+b");
  });

  it("swaps the decision buttons for the target field while it is open", () => {
    // While the field owns the keyboard the buttons would be a lie —
    // those chords are inert until the field closes.
    const frame = frameOf(
      request({
        tool: "os.fs.write",
        category: "fs_write_workspace",
        redirectablePath: "/work/site/index.html",
      }),
      "~/Documents/apple-site/index.html",
    );
    expect(frame).toContain("target");
    expect(frame).toContain("~/Documents/apple-site/index.html");
    expect(frame).toContain("confirm target path");
    expect(frame).not.toContain("ctrl+y");
    expect(frame).not.toContain("ctrl+d");
  });

  it("says the composer is live rather than that the keys stand down", () => {
    // The old hint had to explain that typing disarmed the verdicts.
    // Nothing disarms now, so the hint says the one thing still worth
    // knowing: you may answer in words instead. Ink wraps the footer at
    // the terminal width, so strip the box chrome and collapse
    // whitespace before matching.
    const frame = frameOf(request()).replace(/[\u2550-\u256c]/g, " ").replace(/\s+/g, " ");
    expect(frame).toContain("the composer stays live");
    expect(frame).not.toContain("keys work while the input is empty");
  });

  it("withholds the shape grant for a shell request with no command shape", () => {
    // Opaque interpreters (bash -c …) reach the prompt with no
    // commandShape, so the shape grant must not be offered — only the
    // category grant and the two decisions.
    const frame = frameOf(request());
    expect(frame).toContain("ctrl+f");
    expect(frame).not.toContain("ctrl+b");
  });
});
