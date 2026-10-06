import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { AssistantBubble } from "./assistant-bubble.js";

// A bare URL wrapped in OSC 8 with the URL itself as the visible label.
const OSC8_CURSOR =
  "\u001b]8;;https://cursor.com\u001b\\https://cursor.com\u001b]8;;\u001b\\";

describe("AssistantBubble", () => {
  it("wraps a bare URL in OSC 8 while the reply is still streaming", () => {
    const { lastFrame } = render(
      <AssistantBubble text="see https://cursor.com now" streaming />,
    );
    expect(lastFrame() ?? "").toContain(OSC8_CURSOR);
  });

  it("keeps the same URL clickable once the reply finalises into markdown", () => {
    const { lastFrame } = render(
      <AssistantBubble text="see https://cursor.com now" toolSteps={0} />,
    );
    expect(lastFrame() ?? "").toContain(OSC8_CURSOR);
  });

  it("lists reply attachments under the text once finalised", () => {
    const { lastFrame } = render(
      <AssistantBubble
        text="report attached"
        toolSteps={0}
        attachments={["/tmp/report.pdf", "/tmp/shot.png"]}
      />,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain("report attached");
    expect(text).toContain("📎 /tmp/report.pdf");
    expect(text).toContain("📎 /tmp/shot.png");
  });

  it("renders no attachment row when the reply carries none", () => {
    const { lastFrame } = render(
      <AssistantBubble text="plain" toolSteps={0} attachments={[]} />,
    );
    expect(lastFrame() ?? "").not.toContain("📎");
  });

  it("renders streaming text without OSC 8 when there is no URL", () => {
    const { lastFrame } = render(
      <AssistantBubble text="thinking about it" streaming />,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain("thinking about it");
    expect(text).not.toContain("\u001b]8;;");
  });
});
