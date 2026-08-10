import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ApprovalModal } from "./approval-modal.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "a1",
    sessionId: "s1",
    tool: "os.shell.run",
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

  it("points at the Privacy-tab toggle so the off switch is discoverable", () => {
    // The footer hint is the discoverability answer to issue #79: `y`
    // grants one call, the global switch lives on the Privacy tab.
    const frame = render(<ApprovalModal request={request()} />).lastFrame() ?? "";
    expect(frame).toContain("approves this call only");
    expect(frame).toContain("(/privacy)");
  });
});
