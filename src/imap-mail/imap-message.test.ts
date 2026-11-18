import { describe, expect, it } from "vitest";

import { authservIdOf, parseFromHeader, parseImapMessage } from "./imap-message.js";

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");

describe("parseFromHeader (ATO-601)", () => {
  it.each([
    ["Boss <Boss@Example.com>", "boss@example.com", "Boss"],
    ['"Doe, Jane" <jane@corp.io>', "jane@corp.io", "Doe, Jane"],
    ["jane@corp.io", "jane@corp.io", ""],
    ["jane@corp.io (Jane)", "jane@corp.io", "Jane"],
    ["=?utf-8?B?0JjQstCw0L0=?= <ivan@example.ru>", "ivan@example.ru", "Иван"],
    ["undisclosed", "", ""],
  ])("%s", (raw, email, name) => {
    expect(parseFromHeader(raw)).toEqual({ email, name });
  });

  it.each([
    ['"<me@gmail.com>" <attacker@gmail.com>', "attacker@gmail.com"],
    ["=?utf-8?q?=3Cme@gmail.com=3E?= <attacker@gmail.com>", "attacker@gmail.com"],
    ["(me@gmail.com) attacker@gmail.com", "attacker@gmail.com"],
    ['"Me \\" <me@gmail.com>" <attacker@gmail.com>', "attacker@gmail.com"],
  ])("takes the address outside quotes, comments and encoded words: %s", (raw, email) => {
    expect(parseFromHeader(raw).email).toBe(email);
  });

  it.each([
    "attacker@gmail.com, me@gmail.com",
    "Me <me@gmail.com>, Evil <attacker@gmail.com>",
    "<me@gmail.com> <attacker@gmail.com>",
    "me@gmail.com attacker@gmail.com",
    "Group: me@gmail.com;",
    "<me@gmail.com",
  ])("refuses a From that is not exactly one address: %s", (raw) => {
    expect(parseFromHeader(raw).email).toBe("");
  });
});

describe("parseImapMessage (ATO-601)", () => {
  const pdf = Buffer.from("%PDF-1.4 fake");
  const raw = crlf([
    "Authentication-Results: mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
    "Authentication-Results: forged.example; dmarc=pass",
    "From: Boss <boss@example.com>",
    "Subject: =?utf-8?Q?Q3_=E2=82=AC_report?=",
    "Date: Tue, 17 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Please sum the =E2=82=AC column.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Please sum the column.</p>",
    "--alt--",
    "--outer",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    pdf.toString("base64"),
    "--outer",
    "Content-Type: image/png",
    "Content-Disposition: inline",
    "Content-ID: <logo>",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("png").toString("base64"),
    "--outer--",
    "",
  ]);

  it("reads sender, subject, date, the plain body and the topmost auth header", () => {
    const { mail } = parseImapMessage(raw, "42:7");
    expect(mail).toMatchObject({
      id: "42:7",
      fromEmail: "boss@example.com",
      fromName: "Boss",
      subject: "Q3 € report",
      receivedAt: "2026-11-17T10:00:00.000Z",
      text: "Please sum the € column.",
    });
    expect(mail.authResults).toMatch(/^mx\.google\.com;/);
    expect(mail.authResults).not.toMatch(/forged/);
  });

  it("returns named attachments with decoded bytes and skips an unnamed inline part", () => {
    const { attachments } = parseImapMessage(raw, "1");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe("report.pdf");
    expect(attachments[0]!.mimeType).toBe("application/pdf");
    expect(Buffer.from(attachments[0]!.bytes).toString()).toBe(pdf.toString());
  });

  it("reads a header block alone, and an HTML-only body as text", () => {
    const header = parseImapMessage(crlf(["From: a@b.co", "Subject: s", "", ""]), "1");
    expect(header.mail.text).toBe("");
    expect(header.mail.authResults).toBeNull();
    const html = parseImapMessage(crlf(["From: a@b.co", "Content-Type: text/html", "", "<p>Hi <b>there</b></p>"]), "1");
    expect(html.mail.text).toMatch(/Hi\W+there/);
    expect(html.mail.text).not.toContain("<p>");
  });

  it("includes a forwarded message's text and files", () => {
    const fwd = crlf([
      "From: me@example.com",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "see below",
      "--b",
      "Content-Type: message/rfc822",
      "",
      "From: vendor@shop.io",
      "Subject: invoice",
      'Content-Type: multipart/mixed; boundary="c"',
      "",
      "--c",
      "Content-Type: text/plain",
      "",
      "amount due",
      "--c",
      'Content-Type: text/csv; name="lines.csv"',
      "Content-Disposition: attachment",
      "",
      "a,b",
      "--c--",
      "--b--",
    ]);
    const parsed = parseImapMessage(fwd, "1");
    expect(parsed.mail.text).toContain("see below");
    expect(parsed.mail.text).toContain("Subject: invoice");
    expect(parsed.mail.text).toContain("amount due");
    expect(parsed.attachments.map((a) => a.name)).toEqual(["lines.csv"]);
  });
});

describe("authservIdOf (ATO-601)", () => {
  it.each([
    ["mx.google.com; spf=pass", "mx.google.com"],
    ["MX.Google.com 1; dkim=pass", "mx.google.com"],
    ["(comment) mx.example.net; none", "mx.example.net"],
    [null, ""],
  ])("%s", (header, id) => {
    expect(authservIdOf(header)).toBe(id);
  });
});
