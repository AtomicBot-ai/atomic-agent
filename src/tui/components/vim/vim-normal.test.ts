import { describe, expect, it } from "vitest";
import { normalKey } from "./vim-normal.js";
import { createVimState, type VimBuffer, type VimState } from "./vim-types.js";

/** `"fo|o"` is the buffer `foo` with the caret on the second `o`. */
function at(marked: string): VimBuffer {
  const cursor = marked.indexOf("|");
  return { value: marked.replace("|", ""), cursor };
}

function show(buffer: VimBuffer): string {
  return `${buffer.value.slice(0, buffer.cursor)}|${buffer.value.slice(buffer.cursor)}`;
}

/** Feed `keys` one by one from NORMAL (or from `state`). */
function feed(
  marked: string,
  keys: string,
  state: VimState = createVimState("normal"),
): { text: string; state: VimState; buffer: VimBuffer } {
  let buffer = at(marked);
  let current = state;
  for (const ch of keys) {
    const step = normalKey(current, buffer, ch);
    current = step.state;
    buffer = step.buffer;
  }
  return { text: show(buffer), state: current, buffer };
}

describe("vim NORMAL motions move the caret", () => {
  it("h j k l with counts, clamped onto a character", () => {
    expect(feed("ab|c", "h").text).toBe("a|bc");
    expect(feed("a|bc", "l").text).toBe("ab|c");
    expect(feed("ab|c", "l").text).toBe("ab|c");
    expect(feed("|abcdefghijklmn", "10l").text).toBe("abcdefghij|klmn");
    expect(feed("a|bc\nd", "j").text).toBe("abc\n|d");
    expect(feed("abc\nde|f", "k").text).toBe("ab|c\ndef");
    expect(feed("|a\nb\nc\nd", "3j").text).toBe("a\nb\nc\n|d");
  });

  it("w b e 0 $ ^ gg G", () => {
    expect(feed("|foo bar", "w").text).toBe("foo |bar");
    expect(feed("foo |bar", "b").text).toBe("|foo bar");
    expect(feed("|foo bar", "e").text).toBe("fo|o bar");
    expect(feed("  ab|c", "0").text).toBe("|  abc");
    expect(feed("  ab|c", "^").text).toBe("  |abc");
    expect(feed("|abc\nd", "$").text).toBe("ab|c\nd");
    expect(feed("a\nb\n|c", "gg").text).toBe("|a\nb\nc");
    expect(feed("|a\nb\nc", "G").text).toBe("a\nb\n|c");
    expect(feed("|a\nb\nc", "2G").text).toBe("a\n|b\nc");
    expect(feed("a\nb\n|c", "2gg").text).toBe("a\n|b\nc");
  });

  it("0 after a digit is part of the count, not a motion", () => {
    const step = feed("|abcdefghijkl", "10");
    expect(step.state.count).toBe("10");
    expect(step.text).toBe("|abcdefghijkl");
  });

  it("never types into the buffer", () => {
    expect(feed("fo|o", "qzZ!").text).toBe("fo|o");
  });
});

describe("vim NORMAL edits", () => {
  it("x deletes under the caret, with a count, within the line", () => {
    expect(feed("f|oo", "x").text).toBe("f|o");
    expect(feed("fo|o", "x").text).toBe("f|o");
    expect(feed("a|bcd", "3x").text).toBe("|a");
    expect(feed("a|bc\nd", "9x").text).toBe("|a\nd");
    expect(feed("a\n|\nb", "x").text).toBe("a\n|\nb");
    expect(feed("f|oo", "x").state.register).toEqual({ text: "o", linewise: false });
  });

  it("dd deletes lines (with a count) and lands on the next line", () => {
    expect(feed("one\nt|wo\nthree", "dd").text).toBe("one\n|three");
    expect(feed("one\ntw|o", "dd").text).toBe("|one");
    expect(feed("fo|o", "dd").text).toBe("|");
    expect(feed("|a\nb\nc", "2dd").text).toBe("|c");
    expect(feed("|a\nb\nc", "d2d").text).toBe("|c");
    expect(feed("|a\nb", "9dd").text).toBe("|");
    expect(feed("x\n  t|wo\ny", "dd").state.register).toEqual({
      text: "  two",
      linewise: true,
    });
  });

  it("d with a motion", () => {
    expect(feed("|foo bar", "dw").text).toBe("|bar");
    expect(feed("foo |bar\nbaz", "dw").text).toBe("foo| \nbaz");
    expect(feed("|a b c", "2dw").text).toBe("|c");
    expect(feed("|a b c", "d2w").text).toBe("|c");
    expect(feed("|foo bar", "de").text).toBe("| bar");
    expect(feed("foo |bar", "db").text).toBe("|bar");
    expect(feed("ab|c", "dh").text).toBe("a|c");
    expect(feed("a|bc", "dl").text).toBe("a|c");
    expect(feed("ab|c", "d0").text).toBe("|c");
    expect(feed("  ab|c", "d^").text).toBe("  |c");
    expect(feed("a|bc", "d$").text).toBe("|a");
    expect(feed("a\n|b\nc", "dj").text).toBe("|a");
    expect(feed("|a\nb\nc", "dk").text).toBe("|a\nb\nc");
    expect(feed("a\n|b\nc", "dG").text).toBe("|a");
    expect(feed("a\nb\n|c", "dgg").text).toBe("|");
  });

  it("D deletes to the end of the line", () => {
    expect(feed("fo|o bar\nx", "D").text).toBe("f|o\nx");
    expect(feed("a|b\ncd\ne", "2D").text).toBe("|a\ne");
  });

  it("c changes and leaves the editor in INSERT", () => {
    const cw = feed("|foo bar", "cw");
    expect(cw.text).toBe("| bar");
    expect(cw.state.mode).toBe("insert");
    expect(feed("fo|o bar", "cw").text).toBe("fo| bar");
    expect(feed("|a b c", "c2w").text).toBe("| c");
    expect(feed("foo|   bar", "cw").text).toBe("foo|bar");
    expect(feed("  a\nb|c\nd", "cc").text).toBe("  a\n|\nd");
    expect(feed("a|bc", "c$").text).toBe("a|");
    expect(feed("a|bc", "C").text).toBe("a|");
    const onEmpty = feed("a\n|\nb", "C");
    expect(onEmpty.text).toBe("a\n|\nb");
    expect(onEmpty.state.mode).toBe("insert");
  });

  it("yy / yw / p / P", () => {
    expect(feed("|one\ntwo", "yyp").text).toBe("one\n|one\ntwo");
    expect(feed("one\nt|wo", "yyP").text).toBe("one\n|two\ntwo");
    expect(feed("|foo bar", "ywP").text).toBe("foo| foo bar");
    expect(feed("|abc", "xp").text).toBe("b|ac");
    expect(feed("|ab", "yl3p").text).toBe("aaa|ab");
    expect(feed("|a\nb", "yy2p").text).toBe("a\n|a\na\nb");
    // Nothing yanked yet: p does nothing.
    expect(feed("fo|o", "p").text).toBe("fo|o");
  });

  it("yank leaves the buffer and the undo stack alone", () => {
    const yanked = feed("|one\ntwo", "yy");
    expect(yanked.text).toBe("|one\ntwo");
    expect(yanked.state.undo).toEqual([]);
    expect(feed("foo |bar", "yb").text).toBe("|foo bar");
  });

  it("u undoes the last change, a count undoes several", () => {
    expect(feed("|abc", "xu").text).toBe("|abc");
    expect(feed("one\nt|wo", "ddu").text).toBe("one\nt|wo");
    expect(feed("|abcd", "xxxu").text).toBe("|cd");
    expect(feed("|abcd", "xxx3u").text).toBe("|abcd");
    expect(feed("|abc", "u").text).toBe("|abc");
  });
});

describe("vim NORMAL pending commands", () => {
  it("an operator followed by something else is cancelled", () => {
    const cancelled = feed("|foo bar", "dz");
    expect(cancelled.text).toBe("|foo bar");
    expect(cancelled.state.operator).toBeNull();
    expect(feed("|foo bar", "dzw").text).toBe("foo |bar");
    expect(feed("|foo bar", "dyw").text).toBe("foo |bar");
  });

  it("g followed by anything but g is dropped", () => {
    expect(feed("|abc", "gx").text).toBe("|abc");
    expect(feed("|abc", "gx").state.pendingG).toBe(false);
  });

  it("keeps the count and operator while they are being typed", () => {
    const half = feed("|foo", "2d3");
    expect(half.state.operator).toBe("d");
    expect(half.state.operatorCount).toBe("2");
    expect(half.state.count).toBe("3");
  });
});

describe("vim NORMAL into INSERT", () => {
  it("i a I A o O place the caret and switch to INSERT", () => {
    const i = feed("f|oo", "i");
    expect(i.text).toBe("f|oo");
    expect(i.state.mode).toBe("insert");
    expect(feed("f|oo", "a").text).toBe("fo|o");
    expect(feed("|", "a").text).toBe("|");
    expect(feed("f|oo\nx", "A").text).toBe("foo|\nx");
    expect(feed("  fo|o", "I").text).toBe("  |foo");
    expect(feed("f|oo\nbar", "o").text).toBe("foo\n|\nbar");
    expect(feed("foo\nb|ar", "O").text).toBe("foo\n|\nbar");
  });

  it("remembers the buffer before INSERT, so u can take the session back", () => {
    const o = feed("f|oo", "o");
    expect(o.state.undo).toEqual([{ value: "foo", cursor: 1 }]);
  });
});
