import { describe, expect, it } from "vitest";

import {
  TRIGGER_BODY_MAX_BYTES,
  buildTriggerInboxBatch,
  parseTriggerInbox,
} from "./atomic-mail-trigger-batches.js";

describe("trigger inbox batch (ATO-601)", () => {
  it("asks for the text body and the Authentication-Results header", () => {
    const batch = buildTriggerInboxBatch("acc", "inbox-id", 50) as Array<
      [string, Record<string, unknown>, string]
    >;
    expect(batch.map(([name]) => name)).toEqual(["Email/query", "Email/get"]);
    expect(batch[0]![1]).toMatchObject({ filter: { inMailbox: "inbox-id" }, limit: 50 });
    const get = batch[1]![1];
    expect(get.fetchTextBodyValues).toBe(true);
    expect(get.maxBodyValueBytes).toBe(TRIGGER_BODY_MAX_BYTES);
    expect(get.properties).toEqual(
      expect.arrayContaining(["textBody", "bodyValues", "header:Authentication-Results:asText:all"]),
    );
  });

  it("reads the text parts, lower-cases the sender and keeps the header", () => {
    const list = parseTriggerInbox([
      ["Email/query", { ids: ["m1", "m2"] }],
      [
        "Email/get",
        {
          list: [
            {
              id: "m1",
              from: [{ email: "Boss@Example.com", name: "Boss" }],
              subject: "Invoice",
              receivedAt: "2026-11-12T10:00:00Z",
              preview: "short",
              textBody: [{ partId: "1" }, { partId: "2" }],
              bodyValues: { "1": { value: "line one" }, "2": { value: "line two" } },
              "header:Authentication-Results:asText:all": ["mx; spf=pass; dkim=pass"],
            },
            { id: "m2", from: [{ email: "x@y.z" }], preview: "only preview", textBody: [] },
          ],
        },
      ],
    ]);
    expect(list[0]).toEqual({
      id: "m1",
      fromEmail: "boss@example.com",
      fromName: "Boss",
      subject: "Invoice",
      receivedAt: "2026-11-12T10:00:00Z",
      text: "line one\n\nline two",
      authResults: "mx; spf=pass; dkim=pass",
    });
    expect(list[1]).toMatchObject({ text: "only preview", authResults: null, subject: "" });
  });

  it("keeps headers one per line, topmost first, so a value cannot fake a new header", () => {
    const [m] = parseTriggerInbox([
      [
        "Email/get",
        {
          list: [
            {
              id: "m1",
              "header:Authentication-Results:asText:all": [
                "mx; spf=fail",
                "evil; x\r\nmx; dmarc=pass",
              ],
            },
          ],
        },
      ],
    ]);
    expect(m!.authResults).toBe("mx; spf=fail\nevil; x mx; dmarc=pass");
  });

  it("returns nothing for an answer without Email/get", () => {
    expect(parseTriggerInbox([])).toEqual([]);
  });
});
