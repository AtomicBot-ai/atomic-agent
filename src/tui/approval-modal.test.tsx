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
  it("renders the request and the y/n/esc hotkey row", () => {
    const frame = frameOf(request());
    expect(frame).toContain("approval required");
    expect(frame).toContain("os.shell.run");
    expect(frame).toContain("[y]");
    expect(frame).toContain("[n]");
    expect(frame).toContain("[esc]");
  });

  it("shows the ladder category label so the operator sees why it fired", () => {
    // R5: the prompt carries its `ApprovalCategory`; the modal renders a
    // human label (`file write · home`) so a home write reads differently
    // from a trust-config write.
    const frame = frameOf(request({ category: "fs_write_home" }));
    expect(frame).toContain("file write · home");
  });

  it("points at the Privacy-tab toggle so the off switch is discoverable", () => {
    // The footer hint is the discoverability answer to issue #79: `y`
    // grants one call, the standing switch lives on the Privacy tab.
    const frame = frameOf(request());
    expect(frame).toContain("approves this call once");
    expect(frame).toContain("(/privacy)");
  });

  it("offers [s] session grant and [a] shape grant for a shell request", () => {
    const frame = frameOf(request({ category: "shell", commandShape: "git" }));
    expect(frame).toContain("[s]");
    expect(frame).toContain("this session");
    expect(frame).toContain("[a]");
    expect(frame).toContain("git");
  });

  it("offers [s] but NOT [a] for a non-shell grantable request", () => {
    const frame = frameOf(request({ category: "fs_write_home" }));
    expect(frame).toContain("[s]");
    expect(frame).not.toContain("[a]");
  });

  it("offers NO grant keys and warns for a trust_config request", () => {
    // trust_config is never grantable: only y/n/esc, plus an explicit note.
    const frame = frameOf(request({ category: "trust_config" }));
    expect(frame).not.toContain("[s]");
    expect(frame).not.toContain("[a]");
    expect(frame).toContain("[y]");
    expect(frame).toContain("[n]");
    expect(frame).toContain("never granted for the session");
  });

  it("offers [e] only when the request carries a redirectable path", () => {
    // The shell request has no target to move; the write does.
    expect(frameOf(request())).not.toContain("[e]");
    const write = frameOf(
      request({
        tool: "os.fs.write",
        category: "fs_write_workspace",
        redirectablePath: "/work/site/index.html",
      }),
    );
    expect(write).toContain("[e]");
    expect(write).toContain("edit target path");
  });

  it("swaps the decision rows for the target field while it is open", () => {
    // While the field owns the keyboard the y / n rows would be a lie —
    // those keys type into the path instead of deciding.
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
    expect(frame).not.toContain("[y]");
    expect(frame).not.toContain("[n]");
  });

  it("tells the operator the keys stand down once they start typing", () => {
    // The composer stays live under the prompt, so this hint is the
    // only thing standing between "y did nothing" and a bug report.
    expect(frameOf(request())).toContain("keys work while the input is empty");
  });

  it("offers [s] but NOT [a] for a shell request with no command shape", () => {
    // Opaque interpreters (bash -c …) reach the prompt with no
    // commandShape, so [a] must not be offered — only [s] / [y].
    const frame = frameOf(request());
    expect(frame).toContain("[s]");
    expect(frame).not.toContain("[a]");
  });
});
