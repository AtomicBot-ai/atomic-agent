import { describe, expect, it } from "vitest";
import {
  NEAREST_FRAGMENT_MAX_CHARS,
  findLooseEditMatch,
  nearestFragment,
} from "./fs-edit-match.js";

const MAIN_PY =
  "from users import get_user_name\n\nfor uid in [1, 2]:\n    print(get_user_name(uid))\n";

function applied(source: string, oldString: string, newString: string): string {
  const lookup = findLooseEditMatch(source, oldString);
  if (lookup.kind !== "unique") throw new Error(`expected unique, got ${lookup.kind}`);
  return source.slice(0, lookup.match.start) + newString + source.slice(lookup.match.end);
}

describe("findLooseEditMatch", () => {
  it("matches across a blank line the model dropped (ATO-785)", () => {
    const oldString = "from users import get_user_name\nfor uid in [1, 2]:";
    expect(
      applied(MAIN_PY, oldString, "from users import fetch_user_name\nfor uid in [1, 2]:"),
    ).toBe("from users import fetch_user_name\nfor uid in [1, 2]:\n    print(get_user_name(uid))\n");
  });

  it("ignores trailing spaces and carriage returns on either side", () => {
    const source = "a = 1   \r\nb = 2\r\nc = 3\r\n";
    expect(applied(source, "a = 1\nb = 2  ", "a = 10\nb = 20")).toBe(
      "a = 10\nb = 20\r\nc = 3\r\n",
    );
  });

  it("takes the line's newline when oldString ends with one", () => {
    const source = "x\n\ny\nz\n";
    expect(applied(source, "x\ny\n", "")).toBe("z\n");
  });

  it("keeps indentation significant and matches whole lines only", () => {
    expect(findLooseEditMatch("if a:\n    b()\n", "if a:\nb()").kind).toBe("none");
    expect(findLooseEditMatch("alpha beta\n\ngamma\n", "beta\ngamma").kind).toBe("none");
  });

  it("reports an ambiguous match instead of picking one", () => {
    const source = "x = 1\n\ny = 2\nx = 1\n\n\ny = 2\n";
    expect(findLooseEditMatch(source, "x = 1\ny = 2")).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });

  it("finds nothing for a blank oldString", () => {
    expect(findLooseEditMatch("a\n", "\n  \n").kind).toBe("none");
  });
});

describe("nearestFragment", () => {
  it("quotes the closest run of lines as JSON, with the real line breaks", () => {
    const fragment = nearestFragment(
      MAIN_PY,
      "from users import get_user_name\nfor uid in range(3):",
    );
    expect(fragment).toBe(JSON.stringify("from users import get_user_name\n"));
  });

  it("is null when no line is shared and clips a long fragment", () => {
    expect(nearestFragment("alpha\nbeta\n", "gamma")).toBeNull();
    const long = "y".repeat(400);
    const fragment = nearestFragment(`${long}\n`, `${long}\nmissing`);
    expect(fragment).toHaveLength(NEAREST_FRAGMENT_MAX_CHARS + 1);
  });
});
