import { describe, expect, it } from "vitest";

import {
  convertMarkdownToTelegramHtml,
  escapeHtmlText,
} from "./markdown-to-html.js";

describe("escapeHtmlText", () => {
  it("escapes the three structural HTML characters", () => {
    expect(escapeHtmlText("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });

  it("returns empty input as-is", () => {
    expect(escapeHtmlText("")).toBe("");
  });
});

describe("convertMarkdownToTelegramHtml", () => {
  it("returns empty string for empty input", () => {
    expect(convertMarkdownToTelegramHtml("")).toBe("");
  });

  it("escapes raw HTML characters in plain prose", () => {
    expect(convertMarkdownToTelegramHtml("if a < b && b > 0")).toBe(
      "if a &lt; b &amp;&amp; b &gt; 0",
    );
  });

  it("renders bold via ** and __ as <b>", () => {
    expect(convertMarkdownToTelegramHtml("**hello** and __world__")).toBe(
      "<b>hello</b> and <b>world</b>",
    );
  });

  it("renders italic via single * and _ as <i>", () => {
    expect(convertMarkdownToTelegramHtml("an *emphasised* word")).toBe(
      "an <i>emphasised</i> word",
    );
    expect(convertMarkdownToTelegramHtml("an _emphasised_ word")).toBe(
      "an <i>emphasised</i> word",
    );
  });

  it("does not italicise underscores inside identifiers", () => {
    expect(convertMarkdownToTelegramHtml("snake_case_identifier")).toBe(
      "snake_case_identifier",
    );
  });

  // Word-flanked asterisks are multiplication, not emphasis, and so
  // are space-flanked ones. Reading either as emphasis does not merely
  // restyle the text: Telegram turns `<i>` into italics and the `*`
  // characters are gone from the rendered reply, so `2*pi*5` reaches
  // the operator as `2pi5` and `G1 * G2 * G3` as `G1  G2  G3`.
  describe("asterisk emphasis requires non-word, non-space flanking", () => {
    const literal: Array<[name: string, input: string, expected: string]> = [
      ["a product of two factors", "2*pi*5", "2*pi*5"],
      [
        "a loose pair spanning a call",
        "20*log10(abs(15-1*25))",
        "20*log10(abs(15-1*25))",
      ],
      ["a chain of transfer functions", "G_cont = G1*G2*G3", "G_cont = G1*G2*G3"],
      [
        "mixed identifier and product",
        "G_cont = 2*pi*5 and G1*G2*G3",
        "G_cont = 2*pi*5 and G1*G2*G3",
      ],
      // The same arithmetic written with spaces around the operator.
      // The word guard alone does not reach these — the flanks are
      // spaces — but a `*` followed by whitespace cannot open emphasis
      // under CommonMark either, and these are the shapes an agent
      // emits when it pretty-prints a control-systems script.
      [
        "a spaced chain of transfer functions",
        "G_cont = G1 * G2 * G3",
        "G_cont = G1 * G2 * G3",
      ],
      ["a spaced product", "omega = 2 * pi * 5", "omega = 2 * pi * 5"],
      [
        "a spaced loose pair spanning a call",
        "y = 20 * log10(abs(15 - 1 * 25))",
        "y = 20 * log10(abs(15 - 1 * 25))",
      ],
      [
        "Octave element-wise multiplication",
        "matrix A .* B .* C",
        "matrix A .* B .* C",
      ],
      [
        "a SQL star next to a comparison",
        "SELECT * FROM t WHERE c = *",
        "SELECT * FROM t WHERE c = *",
      ],
      // `\w` is ASCII-only in JS, so the word guard on its own leaves
      // Cyrillic-flanked products emphasised; the rule uses Unicode
      // letter/number classes so prose in any script behaves the same.
      ["a product inside Cyrillic prose", "пи*2*пи", "пи*2*пи"],
      ["a Cyrillic factor", "цена 2*пи*5 герц", "цена 2*пи*5 герц"],
      // The `_` rule had the same ASCII-only leak: `snake_case_name`
      // was safe but its Cyrillic equivalent was not.
      [
        "a Cyrillic snake_case identifier",
        "слово_это_слово",
        "слово_это_слово",
      ],
      ["an ASCII snake_case identifier", "snake_case_name", "snake_case_name"],
      ["a spaced underscore", "a _ b _ c", "a _ b _ c"],
      // Scripts written without spaces are exempt from the *word*
      // guard (see below), but the exemption is per-character: real
      // arithmetic puts an ASCII operand next to the `*`, so the same
      // MATLAB line embedded in Chinese prose is still protected.
      [
        "a loose pair spanning a call inside Chinese prose",
        "这是 20*log10(abs(15-1*25)) 的结果",
        "这是 20*log10(abs(15-1*25)) 的结果",
      ],
      // CommonMark forbids intraword `_` in every script, CJK
      // included, so there is nothing to give back here.
      ["a Chinese underscore run", "这是_重点_内容", "这是_重点_内容"],
      // The flanking character is U+20E3 COMBINING ENCLOSING KEYCAP,
      // which is a mark rather than a digit; the word guard counts
      // marks so the keycap behaves like the bare digit beside it.
      ["a keycap-flanked pair", "1️⃣*x*", "1️⃣*x*"],
      ["a digit-flanked pair", "1*x*", "1*x*"],
    ];
    for (const [name, input, expected] of literal) {
      it(`leaves ${name} literal`, () => {
        expect(convertMarkdownToTelegramHtml(input)).toBe(expected);
      });
    }

    const emphasised: Array<[name: string, input: string, expected: string]> = [
      ["space-flanked", "an *emphasised* word", "an <i>emphasised</i> word"],
      ["at the start of the line", "*emphasised* word", "<i>emphasised</i> word"],
      ["at the end of the line", "an *emphasised*", "an <i>emphasised</i>"],
      ["parenthesised", "(*this*)", "(<i>this</i>)"],
      ["followed by punctuation", "*this*.", "<i>this</i>."],
      ["two runs on one line", "*one* and *two*", "<i>one</i> and <i>two</i>"],
      ["a multi-word run", "read *the whole thing* now", "read <i>the whole thing</i> now"],
      [
        "a run whose body is punctuation-flanked",
        "see *(this)* here",
        "see <i>(this)</i> here",
      ],
      [
        "Cyrillic prose",
        "это *очень* важно",
        "это <i>очень</i> важно",
      ],
      [
        "Cyrillic prose with underscores",
        "это _очень_ важно",
        "это <i>очень</i> важно",
      ],
      // Chinese, Japanese, Korean and Thai are written without spaces
      // between words, so *every* emphasis run in them is flanked by
      // letters. Applying the word guard there is not a heuristic, it
      // is a blanket disable of single-`*` italics for the language —
      // these four are the reason `SPACELESS_SCRIPT` is exempt.
      ["Chinese prose", "这是*重点*内容", "这是<i>重点</i>内容"],
      ["Japanese prose", "これは*重要*です", "これは<i>重要</i>です"],
      ["Korean prose", "이것은*중요*합니다", "이것은<i>중요</i>합니다"],
      ["Thai prose", "ราคา*สอง*บาท", "ราคา<i>สอง</i>บาท"],
    ];
    for (const [name, input, expected] of emphasised) {
      it(`still emphasises ${name}`, () => {
        expect(convertMarkdownToTelegramHtml(input)).toBe(expected);
      });
    }

    it("keeps bold working next to a product", () => {
      expect(convertMarkdownToTelegramHtml("**gain**: G1*G2*G3")).toBe(
        "<b>gain</b>: G1*G2*G3",
      );
    });

    it("does not strand an asterisk when bold is word-flanked", () => {
      expect(convertMarkdownToTelegramHtml("x**bold**y")).toBe("x<b>bold</b>y");
    });

    // Whatever stops being emphasis still has to reach the escaper —
    // an unbalanced `<i>` makes Telegram reject the whole sendMessage
    // with a 400 and the reply is demoted to plain text.
    it("still escapes HTML characters in a line it leaves literal", () => {
      expect(convertMarkdownToTelegramHtml("if 2*pi*5 > x && y < z")).toBe(
        "if 2*pi*5 &gt; x &amp;&amp; y &lt; z",
      );
    });

    it("emits balanced <i> tags for every emphasised run", () => {
      const html = convertMarkdownToTelegramHtml(
        "*a* 2*pi*5 *b* G1*G2*G3 *c*",
      );
      expect(html.match(/<i>/g)?.length ?? 0).toBe(3);
      expect(html.match(/<\/i>/g)?.length ?? 0).toBe(3);
    });

    it("still renders a bullet list whose marker is an asterisk", () => {
      expect(convertMarkdownToTelegramHtml("* list item")).toBe("• list item");
    });

    it("keeps a lone spaced asterisk literal", () => {
      expect(convertMarkdownToTelegramHtml("5 * 3 = 15")).toBe("5 * 3 = 15");
    });

    it("still emphasises a run that wraps bold", () => {
      expect(convertMarkdownToTelegramHtml("*a **b** c*")).toBe(
        "<i>a <b>b</b> c</i>",
      );
    });

    // Telegram answers crossing tags with a 400 on the whole
    // sendMessage; `sendOutbound` recovers by re-sending the chunk as
    // plain text, but that costs every bit of formatting in the reply.
    // An emphasis candidate whose body does not close what it opens
    // stays literal instead of emitting an `<i>` across a `<b>`.
    it("refuses an emphasis run that would cross a bold tag", () => {
      expect(convertMarkdownToTelegramHtml("__* *a__*")).toBe("<b>* *a</b>*");
    });

    it("refuses an underscore run that would cross a bold tag", () => {
      expect(convertMarkdownToTelegramHtml("**_ _a** _")).toBe("<b>_ _a</b> _");
    });

    it("keeps bold working in a script written without spaces", () => {
      expect(convertMarkdownToTelegramHtml("这是**重点**内容")).toBe(
        "这是<b>重点</b>内容",
      );
    });

    // A `*` inside a URL splits the `<a href="…">` that `renderLinks`
    // emitted, so the emphasis body holds no complete tag for
    // `tagsBalanced` to reject and the run used to be wrapped anyway —
    // producing `<i>&lt;a href="http://x/</i>">a</a>*`, an orphan
    // `</a>` that Telegram answers with a 400. A delimiter sitting
    // inside an already-emitted tag now refuses the candidate.
    it("refuses a run whose delimiter sits inside an emitted anchor", () => {
      expect(convertMarkdownToTelegramHtml("*[a](http://x/*)*")).toBe(
        '*<a href="http://x/*">a</a>*',
      );
    });

    it("refuses an underscore run whose delimiter sits inside an anchor", () => {
      expect(convertMarkdownToTelegramHtml("_[a](http://x/_)_")).toBe(
        '_<a href="http://x/_">a</a>_',
      );
    });
  });

  it("renders strikethrough via ~~", () => {
    expect(convertMarkdownToTelegramHtml("~~old~~ new")).toBe("<s>old</s> new");
  });

  it("renders inline code via single backticks and escapes the body", () => {
    expect(convertMarkdownToTelegramHtml("call `foo<bar>` now")).toBe(
      "call <code>foo&lt;bar&gt;</code> now",
    );
  });

  it("does not interpret markdown inside inline code", () => {
    expect(convertMarkdownToTelegramHtml("code `**not bold**` here")).toBe(
      "code <code>**not bold**</code> here",
    );
  });

  it("renders fenced code blocks without a language", () => {
    const md = "before\n```\nline 1\nline 2\n```\nafter";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "before\n<pre><code>line 1\nline 2</code></pre>\nafter",
    );
  });

  it("renders fenced code blocks with a language class", () => {
    const md = "```python\nprint('hi')\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<pre><code class=\"language-python\">print('hi')</code></pre>",
    );
  });

  it("escapes HTML inside fenced code blocks", () => {
    const md = "```\nif (a < b && c > 0) {}\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<pre><code>if (a &lt; b &amp;&amp; c &gt; 0) {}</code></pre>",
    );
  });

  it("does not interpret markdown inside fenced code blocks", () => {
    const md = "```\n**not bold** _not italic_\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<pre><code>**not bold** _not italic_</code></pre>",
    );
  });

  it("renders headings as bold", () => {
    expect(convertMarkdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(convertMarkdownToTelegramHtml("### Subsection")).toBe(
      "<b>Subsection</b>",
    );
  });

  it("renders a safe http/https link as <a>", () => {
    expect(
      convertMarkdownToTelegramHtml("see [docs](https://example.com/x)"),
    ).toBe('see <a href="https://example.com/x">docs</a>');
  });

  it("renders a tg:// mention link as <a>", () => {
    expect(convertMarkdownToTelegramHtml("hi [me](tg://user?id=42)")).toBe(
      'hi <a href="tg://user?id=42">me</a>',
    );
  });

  it("rejects unsafe schemes by degrading to escaped plain text", () => {
    expect(convertMarkdownToTelegramHtml("[click](javascript:alert(1))")).toBe(
      "click (javascript:alert(1))",
    );
  });

  it("escapes <,>,& inside link href attributes", () => {
    expect(convertMarkdownToTelegramHtml("[x](https://e.com/?a=1&b=2)")).toBe(
      '<a href="https://e.com/?a=1&amp;b=2">x</a>',
    );
  });

  it("renders unordered list items with bullets", () => {
    const md = "- first\n- second\n- third";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "• first\n• second\n• third",
    );
  });

  it("renders ordered list items with bullets (Telegram has no <ol>)", () => {
    const md = "1. first\n2. second\n3. third";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "• first\n• second\n• third",
    );
  });

  it("renders a blockquote", () => {
    const md = "> quoted line one\n> quoted line two";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<blockquote>quoted line one\nquoted line two</blockquote>",
    );
  });

  it("composes bold + italic + link in one pass", () => {
    const md = "**Important**: read the [_guide_](https://x.com/g).";
    const out = convertMarkdownToTelegramHtml(md);
    expect(out).toBe(
      '<b>Important</b>: read the <a href="https://x.com/g"><i>guide</i></a>.',
    );
  });

  it("survives stray < and > in regular prose without producing tags", () => {
    expect(convertMarkdownToTelegramHtml("use <unknown> tags")).toBe(
      "use &lt;unknown&gt; tags",
    );
  });

  it("preserves emitted tags untouched while escaping interleaved <,>,&", () => {
    expect(convertMarkdownToTelegramHtml("**bold** and a < b")).toBe(
      "<b>bold</b> and a &lt; b",
    );
  });

  it("strips heading trailing-hash markers", () => {
    expect(convertMarkdownToTelegramHtml("## Title ##")).toBe("<b>Title</b>");
  });
});
