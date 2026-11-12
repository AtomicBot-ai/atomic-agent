import { describe, expect, it } from "vitest";

import {
  decodeHeaderWords,
  emlExtractor,
  mboxExtractor,
} from "./email-extractor.js";

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");

describe("emlExtractor", () => {
  it("shows key headers and the plain body of a simple message", async () => {
    const data = crlf([
      "Return-Path: <a@example.com>",
      "From: Ann <a@example.com>",
      "To: Bob <b@example.com>",
      "Subject: Quarterly",
      " numbers",
      "Date: Tue, 10 Nov 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hi Bob,",
      "numbers attached.",
    ]);
    const result = await emlExtractor({ data, sourcePath: "m.eml" });
    expect(result.format).toBe("eml");
    expect(result.text).toBe(
      [
        "From: Ann <a@example.com>",
        "To: Bob <b@example.com>",
        "Date: Tue, 10 Nov 2026 10:00:00 +0000",
        "Subject: Quarterly numbers",
        "",
        "Hi Bob,",
        "numbers attached.",
      ].join("\n"),
    );
    expect(result.text).not.toContain("Return-Path");
  });

  it("decodes RFC 2047 headers, base64 and quoted-printable bodies", async () => {
    expect(decodeHeaderWords("=?UTF-8?B?0J/RgNC40LLQtdGC?= =?UTF-8?Q?_=D0=BC=D0=B8=D1=80?=")).toBe(
      "Привет мир",
    );
    const data = crlf([
      "From: x@example.com",
      "Subject: =?koi8-r?B?8NLJ18XU?=",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="OUTER"',
      "",
      "This is the MIME preamble.",
      "--OUTER",
      'Content-Type: multipart/alternative; boundary="ALT"',
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=C3=A9 menu, a long line that is soft=",
      "-wrapped.",
      "--ALT",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML twin that must not be shown</p>",
      "--ALT--",
      "--OUTER",
      "Content-Type: application/pdf; name=menu.pdf",
      "Content-Disposition: attachment; filename*=utf-8''men%C3%BA.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF-1.4 fake").toString("base64"),
      "--OUTER--",
    ]);
    const result = await emlExtractor({ data, sourcePath: "m.eml" });
    expect(result.text).toContain("Subject: Привет");
    expect(result.text).toContain("Café menu, a long line that is soft-wrapped.");
    expect(result.text).not.toContain("HTML twin");
    expect(result.text).not.toContain("preamble");
    expect(result.text).toContain("Attachments:\n- menú.pdf (application/pdf, 13 B)");
    expect(result.text).not.toContain("JVBER");
  });

  it("falls back to the HTML part rendered as markdown", async () => {
    const data = crlf([
      "From: x@example.com",
      "Content-Type: multipart/alternative; boundary=b1",
      "",
      "--b1",
      "Content-Type: text/html; charset=windows-1251",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(
        Buffer.concat([
          Buffer.from("<h1>", "latin1"),
          Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
          Buffer.from("</h1><script>x()</script><p>body</p>", "latin1"),
        ]),
      ).toString("base64"),
      "--b1--",
    ]);
    const result = await emlExtractor({ data, sourcePath: "m.eml" });
    expect(result.text).toContain("# Привет");
    expect(result.text).toContain("body");
    expect(result.text).not.toContain("x()");
  });

  it("renders a forwarded message/rfc822 part", async () => {
    const data = crlf([
      "From: me@example.com",
      "Subject: Fwd: hello",
      "Content-Type: multipart/mixed; boundary=m",
      "",
      "--m",
      "Content-Type: text/plain",
      "",
      "See below.",
      "--m",
      "Content-Type: message/rfc822",
      "",
      "From: original@example.com",
      "Subject: hello",
      "",
      "Original text.",
      "--m--",
    ]);
    const result = await emlExtractor({ data, sourcePath: "m.eml" });
    expect(result.text).toContain("See below.");
    expect(result.text).toContain("--- attached message ---\nFrom: original@example.com\nSubject: hello\n\nOriginal text.");
  });
});

describe("mboxExtractor", () => {
  const mbox = Buffer.from(
    [
      "From a@example.com Mon Nov  9 10:00:00 2026",
      "From: a@example.com",
      "Subject: one",
      "",
      "first body",
      ">From the start, quoted.",
      "",
      "From b@example.com Mon Nov  9 11:00:00 2026",
      "From: b@example.com",
      "Subject: two",
      "",
      "second body",
      "",
      "From c@example.com Mon Nov  9 12:00:00 2026",
      "From: c@example.com",
      "Subject: three",
      "",
      "third body",
      "",
    ].join("\n"),
    "latin1",
  );

  it("splits messages and unescapes >From lines", async () => {
    const result = await mboxExtractor({ data: mbox, sourcePath: "x.mbox" });
    expect(result.format).toBe("mbox");
    expect(result.pageCount).toBe(3);
    expect(result.pagesExtracted).toEqual([1, 2, 3]);
    expect(result.text).toContain("--- message 1 ---\nFrom: a@example.com\nSubject: one\n\nfirst body\nFrom the start, quoted.");
    expect(result.text).toContain("--- message 3 ---");
  });

  it("pages through messages", async () => {
    const result = await mboxExtractor({ data: mbox, sourcePath: "x.mbox", pagesFrom: 2, maxPages: 1 });
    expect(result.pagesExtracted).toEqual([2]);
    expect(result.text).toContain("second body");
    expect(result.text).not.toContain("first body");
    expect(result.warnings.join(" ")).toMatch(/1 more message/);
  });

  it("warns on a file with no mbox separators", async () => {
    const result = await mboxExtractor({ data: Buffer.from("just text"), sourcePath: "x.mbox" });
    expect(result.pageCount).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/no messages found/);
  });
});
