import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import {
  extractLinks,
  formatUnsourcedLinkNotice,
  formatUnsourcedLinkRefusal,
  linkSources,
  normalizeLink,
  unsourcedLinks,
} from "./link-evidence.js";

const RESULT_URL =
  "https://www.tomshardware.com/pc-components/gpus/nvidia-rtx-5090-review";

function turnWith(summary: string, userText = "find the review"): ConversationTurn[] {
  return [
    { kind: "user", text: userText, at: 1 },
    {
      kind: "assistant_tool_call",
      tool: "os.web.search",
      args: { query: "rtx 5090 review" },
      at: 2,
    },
    { kind: "tool_result", tool: "os.web.search", status: "ok", summary, at: 3 },
  ];
}

describe("extractLinks", () => {
  it("trims the punctuation and markup prose wraps around a link", () => {
    expect(
      extractLinks(
        `See ${RESULT_URL}. Also [docs](https://example.com/a/b), (https://example.com/c) and **https://example.com/d**!`,
      ),
    ).toEqual([
      RESULT_URL,
      "https://example.com/a/b",
      "https://example.com/c",
      "https://example.com/d",
    ]);
  });

  it("keeps balanced parentheses that belong to the link", () => {
    expect(
      extractLinks("https://en.wikipedia.org/wiki/Rust_(programming_language)."),
    ).toEqual(["https://en.wikipedia.org/wiki/Rust_(programming_language)"]);
  });

  it("reads only http(s) links, once each", () => {
    expect(
      extractLinks("ftp://x.org/a file:///etc/hosts http://a.io/x http://a.io/x"),
    ).toEqual(["http://a.io/x"]);
  });

  it("decodes &amp; from fetched HTML", () => {
    expect(extractLinks('href="https://a.io/p?x=1&amp;y=2"')).toEqual([
      "https://a.io/p?x=1&y=2",
    ]);
  });
});

describe("extractLinks in other scripts", () => {
  const URL = "https://a.io/docs/page";

  it("stops at the quotes, brackets and punctuation of other scripts", () => {
    expect(extractLinks(`Ссылка: «${URL}»`)).toEqual([URL]);
    expect(extractLinks(`“${URL}”`)).toEqual([URL]);
    expect(extractLinks(`见${URL}。`)).toEqual([URL]);
    expect(extractLinks(`见${URL}，谢谢`)).toEqual([URL]);
    expect(extractLinks(`「${URL}」と（${URL}）`)).toEqual([URL]);
    expect(extractLinks(`${URL}…`)).toEqual([URL]);
    expect(extractLinks(`${URL}—подробнее`)).toEqual([URL]);
  });

  it("stops where CJK text runs on with no space", () => {
    expect(extractLinks(`${URL}中文标题`)).toEqual([URL]);
    expect(extractLinks(`${URL}を参照`)).toEqual([URL]);
  });

  it("keeps a Cyrillic path whole", () => {
    expect(extractLinks("https://ru.wikipedia.org/wiki/Москва, см.")).toEqual([
      "https://ru.wikipedia.org/wiki/Москва",
    ]);
  });

  it("does not flag a correctly copied link in a Russian or CJK reply", () => {
    const sources = linkSources(turnWith(`1. ${URL}`));
    for (const reply of [
      `Вот: «${URL}»`,
      `见${URL}。`,
      `见${URL}，谢谢`,
      `See ${URL}…`,
    ]) {
      expect(unsourcedLinks(reply, sources)).toEqual([]);
    }
  });

  it("stores a source link glued to CJK text under its own key", () => {
    const sources = linkSources(turnWith(`结果：${URL}中文标题`));
    expect(sources.known.has(normalizeLink(URL)!)).toBe(true);
    expect(unsourcedLinks(`见 ${URL}`, sources)).toEqual([]);
  });
});

describe("normalizeLink", () => {
  it("ignores scheme, www., host case, trailing slash and fragment", () => {
    const key = normalizeLink("https://example.com/docs/page");
    expect(normalizeLink("http://WWW.Example.com/docs/page/")).toBe(key);
    expect(normalizeLink("https://example.com/docs/page#install")).toBe(key);
  });

  it("decodes percent-encoding but keeps the query", () => {
    expect(normalizeLink("https://a.io/caf%C3%A9?q=1")).toBe("a.io/café?q=1");
    expect(normalizeLink("https://a.io/x?q=1")).not.toBe(normalizeLink("https://a.io/x?q=2"));
  });
});

describe("unsourcedLinks", () => {
  it("flags the issue's case: the result's link with a slug word dropped", () => {
    const sources = linkSources(turnWith(`1. RTX 5090 review — ${RESULT_URL}`));
    const mangled = "https://www.tomshardware.com/pc-components/gpus/rtx-5090-review";
    expect(unsourcedLinks(`Here it is: ${mangled}`, sources)).toEqual([{ url: mangled }]);
  });

  it("accepts the link copied from the result, in any spelling the normaliser joins", () => {
    const sources = linkSources(turnWith(`1. RTX 5090 review — ${RESULT_URL}`));
    expect(unsourcedLinks(`Here: ${RESULT_URL}.`, sources)).toEqual([]);
    expect(unsourcedLinks(`[review](${RESULT_URL}/#verdict)`, sources)).toEqual([]);
    expect(
      unsourcedLinks(RESULT_URL.replace("https://www.", "http://"), sources),
    ).toEqual([]);
  });

  it("accepts a parent path of a known link, not a longer one", () => {
    const sources = linkSources(
      turnWith("https://github.com/AtomicBot-ai/atomic-agent/blob/main/README.md"),
    );
    expect(
      unsourcedLinks("https://github.com/AtomicBot-ai/atomic-agent", sources),
    ).toEqual([]);
    expect(unsourcedLinks("https://github.com/AtomicBot-ai/atomic", sources)).toHaveLength(1);
    expect(
      unsourcedLinks(
        "https://github.com/AtomicBot-ai/atomic-agent/blob/main/README.md/extra",
        sources,
      ),
    ).toHaveLength(1);
  });

  it("leaves a link alone on a host this turn's results did not link to", () => {
    const sources = linkSources(turnWith(`result: ${RESULT_URL}`));
    expect(unsourcedLinks("Docs: https://developer.nvidia.com/cuda", sources)).toEqual([]);
  });

  it("checks nothing when this turn's results held no link", () => {
    const sources = linkSources(turnWith("no links in this output"));
    expect(
      unsourcedLinks("https://www.tomshardware.com/made-up", sources),
    ).toEqual([]);
  });

  it("counts links from the operator's message, call arguments and earlier replies as known", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "what is on https://a.io/one?", at: 1 },
      { kind: "assistant_reply", text: "Earlier: https://a.io/earlier", at: 2 },
      { kind: "user", text: "and now?", at: 3 },
      {
        kind: "assistant_tool_call",
        tool: "os.web.fetch",
        args: { url: "https://a.io/fetched" },
        at: 4,
      },
      {
        kind: "tool_result",
        tool: "os.web.fetch",
        status: "ok",
        summary: "page links to https://a.io/listed",
        at: 5,
      },
    ];
    const sources = linkSources(turns);
    expect(
      unsourcedLinks(
        "https://a.io/one https://a.io/earlier https://a.io/fetched https://a.io/listed",
        sources,
      ),
    ).toEqual([]);
    expect(unsourcedLinks("https://a.io/invented", sources)).toEqual([
      { url: "https://a.io/invented" },
    ]);
  });

  it("does not take a held reply or a progress note as a source", () => {
    const mangled = "https://www.tomshardware.com/rtx-5090-review";
    const turns: ConversationTurn[] = [
      ...turnWith(`hit: ${RESULT_URL}`),
      { kind: "assistant_reply", text: `note: ${mangled}`, progressNote: true, at: 4 },
      { kind: "assistant_tool_call", tool: "reply", args: { text: mangled }, at: 5 },
      {
        kind: "tool_result",
        tool: "reply",
        status: "error",
        summary: formatUnsourcedLinkRefusal([{ url: mangled }]),
        at: 6,
      },
    ];
    expect(unsourcedLinks(mangled, linkSources(turns))).toEqual([{ url: mangled }]);
  });

  it("counts links on the open page's snapshot as known, without arming on them", () => {
    const pageLink = "https://www.tomshardware.com/pc-components/gpus/rtx-5090-deals";
    const snapshot = `- link "RTX 5090 deals":\n  - /url: ${pageLink}`;
    const armed = linkSources(turnWith(`hit: ${RESULT_URL}`), [snapshot]);
    expect(unsourcedLinks(`Deals: ${pageLink}`, armed)).toEqual([]);
    expect(
      unsourcedLinks("https://www.tomshardware.com/made-up", armed),
    ).toHaveLength(1);
    const unarmed = linkSources(turnWith("no links in this output"), [snapshot]);
    expect(unarmed.turnResultHosts.size).toBe(0);
  });

  it("arms only on this turn's results, not an earlier turn's", () => {
    const turns: ConversationTurn[] = [
      ...turnWith(`hit: ${RESULT_URL}`),
      { kind: "assistant_reply", text: "done", at: 4 },
      { kind: "user", text: "thanks, one more thing", at: 5 },
    ];
    expect(
      unsourcedLinks("https://www.tomshardware.com/other", linkSources(turns)),
    ).toEqual([]);
  });
});

describe("formatUnsourcedLinkNotice", () => {
  it("names the link and both exits", () => {
    const notice = formatUnsourcedLinkNotice([{ url: "https://a.io/x" }]);
    expect(notice).toContain('links "https://a.io/x"');
    expect(notice).toContain("no tool result this turn holds that link");
    expect(notice).toContain("Copy each link exactly");
    expect(notice).toContain("remove it");
  });

  it("names at most five links and counts the rest", () => {
    const links = Array.from({ length: 7 }, (_, i) => ({ url: `https://a.io/${i}` }));
    const notice = formatUnsourcedLinkNotice(links);
    expect(notice).toContain('"https://a.io/4"');
    expect(notice).not.toContain('"https://a.io/5"');
    expect(notice).toContain("and 2 more");
  });
});
