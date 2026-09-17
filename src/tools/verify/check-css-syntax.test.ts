import { describe, expect, it } from "vitest";

import { checkCssSource, CSS_CHECKER } from "./check-css-syntax.js";

describe("checkCssSource", () => {
  it("passes balanced rules, nested blocks, strings and comments", () => {
    const css = `
/* a comment with a stray } inside */
.a { color: red; }
@media (max-width: 600px) { .b { content: "{not a brace"; } }
.c::after { content: '}'; }
`;
    expect(checkCssSource("x.css", css)).toEqual({
      file: "x.css",
      ok: true,
      checker: CSS_CHECKER,
    });
  });

  it("names the line of a closing brace with no open block", () => {
    const css = ".a { color: red; }\n}\n.b { }\n";
    const out = checkCssSource("x.css", css);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unexpected `}` at line 2 (no open block)");
  });

  it("counts the blocks left open at the end of the file", () => {
    const out = checkCssSource("x.css", ".a { .b { color: red; }\n.c {");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("2 unclosed `{` at end of file");
  });

  it("does not let an unterminated string swallow the rest of the file", () => {
    // The string ends at the newline (invalid CSS, but the brace count
    // must still see the `}` on the next line).
    const out = checkCssSource("x.css", ".a { content: \"oops;\n}\n");
    expect(out.ok).toBe(true);
  });
});
