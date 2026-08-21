import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { SessionDeleteModal } from "./session-delete-modal.js";

function strip(v: string): string {
  return v.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
}

function frameFor(preview: string): string {
  const { lastFrame } = render(
    <Box width={60} height={20} position="relative" overflow="hidden">
      <SessionDeleteModal
        confirm={{ sessionId: "s-1", preview, cursor: "cancel" }}
        availableRows={20}
        availableColumns={60}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onFocus={() => undefined}
      />
    </Box>,
  );
  return strip(lastFrame() ?? "");
}

describe("probe: delete modal preview", () => {
  it("single line", () => {
    const frame = frameFor("fix the login bug");
    console.log("SINGLE rows=", frame.split("\n").length);
    console.log(frame);
    expect(true).toBe(true);
  });

  it("multi line first prompt", () => {
    const frame = frameFor(
      "fix these:\n- login\n- signup\n- reset\n- logout\n- more",
    );
    console.log("MULTI rows=", frame.split("\n").length);
    console.log(frame);
    expect(true).toBe(true);
  });
});
