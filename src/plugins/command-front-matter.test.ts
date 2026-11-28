import { describe, expect, it } from "vitest";
import { frontMatterProblem } from "./command-front-matter.js";

/** ATO-2773: say why a command's front matter was ignored. */
describe("frontMatterProblem", () => {
  it("is null for no block, a good block and an empty one", () => {
    expect(frontMatterProblem("Just a prompt\n")).toBeNull();
    expect(frontMatterProblem("---\ndescription: Ship it\nargument-hint: <tag>\n---\nBody\n")).toBeNull();
    expect(frontMatterProblem("---\r\ndescription: Windows line ends\r\n---\r\nBody\r\n")).toBeNull();
  });

  it("names the file line of a YAML error", () => {
    // Line 1 is ---, line 2 is fine, line 3 holds the bad value.
    expect(frontMatterProblem("---\ndescription: ok\nargument-hint: [open\n---\nBody\n")).toMatch(
      /^could not parse front matter at line [34]$/,
    );
  });

  it("says when the block never closes or is not key: value lines", () => {
    expect(frontMatterProblem("---\ndescription: x\nBody\n")).toBe("front matter has no closing --- line");
    expect(frontMatterProblem("---\n- one\n- two\n---\nBody\n")).toBe("front matter is not a list of key: value lines");
  });
});
