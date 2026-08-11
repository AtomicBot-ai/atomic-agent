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

describe("ApprovalModal", () => {
  it("renders the request and the y/n/esc hotkey row", () => {
    const frame = render(<ApprovalModal request={request()} />).lastFrame() ?? "";
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
    const frame =
      render(<ApprovalModal request={request({ category: "fs_write_home" })} />).lastFrame() ??
      "";
    expect(frame).toContain("file write · home");
  });

  it("points at the Privacy-tab toggle so the off switch is discoverable", () => {
    // The footer hint is the discoverability answer to issue #79: `y`
    // grants one call, the standing switch lives on the Privacy tab.
    const frame = render(<ApprovalModal request={request()} />).lastFrame() ?? "";
    expect(frame).toContain("approves this call once");
    expect(frame).toContain("(/privacy)");
  });

  it("offers [s] session grant and [a] shape grant for a shell request", () => {
    const frame =
      render(
        <ApprovalModal request={request({ category: "shell", commandShape: "git" })} />,
      ).lastFrame() ?? "";
    expect(frame).toContain("[s]");
    expect(frame).toContain("this session");
    expect(frame).toContain("[a]");
    expect(frame).toContain("git");
  });

  it("offers [s] but NOT [a] for a non-shell grantable request", () => {
    const frame =
      render(<ApprovalModal request={request({ category: "fs_write_home" })} />).lastFrame() ??
      "";
    expect(frame).toContain("[s]");
    expect(frame).not.toContain("[a]");
  });

  it("offers NO grant keys and warns for a trust_config request", () => {
    // trust_config is never grantable: only y/n/esc, plus an explicit note.
    const frame =
      render(<ApprovalModal request={request({ category: "trust_config" })} />).lastFrame() ??
      "";
    expect(frame).not.toContain("[s]");
    expect(frame).not.toContain("[a]");
    expect(frame).toContain("[y]");
    expect(frame).toContain("[n]");
    expect(frame).toContain("never granted for the session");
  });

  it("offers [s] but NOT [a] for a shell request with no command shape", () => {
    // Opaque interpreters (bash -c …) reach the prompt with no
    // commandShape, so [a] must not be offered — only [s] / [y].
    const frame = render(<ApprovalModal request={request()} />).lastFrame() ?? "";
    expect(frame).toContain("[s]");
    expect(frame).not.toContain("[a]");
  });
});
