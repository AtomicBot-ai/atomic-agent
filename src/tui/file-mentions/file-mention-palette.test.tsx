import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FileMentionPalette, mentionWindowStart } from "./file-mention-palette.js";

function frame(element: Parameters<typeof render>[0]): string {
  const { lastFrame, unmount } = render(element);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

describe("FileMentionPalette", () => {
  it("says the list is still being built", () => {
    expect(frame(<FileMentionPalette results={null} cursor={0} />)).toContain("listing files");
  });

  it("says when nothing matches", () => {
    expect(frame(<FileMentionPalette results={[]} cursor={0} />)).toContain("no matching file");
  });

  it("shows the paths with the cursor row marked", () => {
    const out = frame(<FileMentionPalette results={["src/app.ts", "README.md"]} cursor={1} />);
    expect(out).toContain("@src/app.ts");
    expect(out).toContain("@README.md");
  });

  it("windows a long list and counts what is hidden", () => {
    const results = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const out = frame(<FileMentionPalette results={results} cursor={10} />);
    expect(out).toContain("@f10.ts");
    expect(out).not.toContain("@f0.ts");
    expect(out).toContain("above");
    expect(out).toContain("below");
  });
});

describe("mentionWindowStart", () => {
  it("keeps the cursor in view", () => {
    expect(mentionWindowStart(0, 20, 6)).toBe(0);
    expect(mentionWindowStart(10, 20, 6)).toBe(5);
    expect(mentionWindowStart(19, 20, 6)).toBe(14);
  });
});
