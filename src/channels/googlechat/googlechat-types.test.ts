import { describe, expect, it } from "vitest";

import { chunkGoogleChatText, decodeGoogleChatEvent, googleChatSenderLine } from "./googlechat-events.js";
import {
  isGoogleChatOwner,
  readGoogleChatOptions,
  resolveCredentialsPath,
  scrubGoogleChatError,
} from "./googlechat-types.js";

const config = (options: Record<string, string>) => ({ enabled: true, ownerIds: [], options });

describe("readGoogleChatOptions", () => {
  it("accepts a subscription resource name and rejects anything else", () => {
    expect(readGoogleChatOptions(config({ subscription: " projects/my-proj/subscriptions/chat-sub " }))).toEqual({
      subscription: "projects/my-proj/subscriptions/chat-sub",
    });
    for (const bad of [
      "",
      "chat-sub",
      "projects/p/topics/t",
      "projects/p/subscriptions/a/../b",
      "projects/p/subscriptions/ab?x=1",
      "https://pubsub.googleapis.com/v1/projects/p/subscriptions/s",
    ]) {
      expect(readGoogleChatOptions(config({ subscription: bad })).subscription).toBeNull();
    }
    expect(readGoogleChatOptions(config({})).subscription).toBeNull();
  });
});

describe("resolveCredentialsPath", () => {
  it("prefers the explicit value, then a non-blank env var", () => {
    expect(resolveCredentialsPath("/x.json", {})).toBe("/x.json");
    expect(resolveCredentialsPath(undefined, { GOOGLE_CHAT_CREDENTIALS: " /k.json " })).toBe("/k.json");
    expect(resolveCredentialsPath(undefined, { GOOGLE_CHAT_CREDENTIALS: "  " })).toBeNull();
    expect(resolveCredentialsPath(undefined, {})).toBeNull();
  });
});

describe("isGoogleChatOwner", () => {
  it("matches resource names exactly and emails case-insensitively", () => {
    const owners = ["users/111", "Ada@Example.com"];
    expect(isGoogleChatOwner(owners, { name: "users/111" })).toBe(true);
    expect(isGoogleChatOwner(owners, { name: "users/1111" })).toBe(false);
    expect(isGoogleChatOwner(owners, { name: "users/2", email: "ada@example.com" })).toBe(true);
    expect(isGoogleChatOwner(owners, { name: "users/2", email: "" })).toBe(false);
    expect(isGoogleChatOwner([], { name: "users/111" })).toBe(false);
    expect(isGoogleChatOwner(owners, undefined)).toBe(false);
  });
});

describe("scrubGoogleChatError", () => {
  it("removes tokens, assertions and private keys", () => {
    const msg = scrubGoogleChatError(
      "Bearer abc.def ya29.A0AfH6SM-x_y assertion=eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.sig " +
        "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- mysecretvalue",
      ["mysecretvalue"],
    );
    expect(msg).not.toMatch(/ya29\.A0|eyJhbGci|MIIE|abc\.def|mysecretvalue/);
  });
});

describe("decodeGoogleChatEvent", () => {
  it("decodes base64 event JSON and rejects anything that is not an event", () => {
    const data = Buffer.from(JSON.stringify({ type: "MESSAGE", space: { name: "spaces/A" } })).toString("base64");
    expect(decodeGoogleChatEvent(data)).toEqual({ type: "MESSAGE", space: { name: "spaces/A" } });
    expect(decodeGoogleChatEvent(Buffer.from("[1]").toString("base64"))).toBeNull();
    expect(decodeGoogleChatEvent(Buffer.from("{}").toString("base64"))).toBeNull();
    expect(decodeGoogleChatEvent("%%%")).toBeNull();
    expect(decodeGoogleChatEvent(undefined)).toBeNull();
  });
});

describe("decodeGoogleChatEvent, Workspace add-on shape", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  const user = { name: "users/111", email: "ada@example.com", type: "HUMAN" };

  it("reads chat.messagePayload into the same MESSAGE event as the classic shape", () => {
    const message = {
      name: "spaces/A/messages/m1",
      text: "@Agent hi",
      argumentText: " hi",
      thread: { name: "spaces/A/threads/t1" },
    };
    const addOn = decodeGoogleChatEvent(
      b64({ commonEventObject: { hostApp: "CHAT" }, chat: { user, messagePayload: { space: { name: "spaces/A" }, message } } }),
    );
    const classic = decodeGoogleChatEvent(b64({ type: "MESSAGE", space: { name: "spaces/A" }, message, user }));
    expect(addOn).toEqual(classic);
  });

  it("takes the space from the message when the payload has none", () => {
    const event = decodeGoogleChatEvent(
      b64({ chat: { user, messagePayload: { message: { name: "spaces/B/messages/m", space: { name: "spaces/B" } } } } }),
    );
    expect(event?.space).toEqual({ name: "spaces/B" });
  });

  it("reads chat.addedToSpacePayload as ADDED_TO_SPACE", () => {
    expect(decodeGoogleChatEvent(b64({ chat: { user, addedToSpacePayload: { space: { name: "spaces/A" } } } }))).toEqual({
      type: "ADDED_TO_SPACE",
      space: { name: "spaces/A" },
      user,
    });
  });

  it("maps button clicks and removals, and rejects an add-on event with no known payload", () => {
    expect(decodeGoogleChatEvent(b64({ chat: { user, buttonClickedPayload: {} } }))?.type).toBe("CARD_CLICKED");
    expect(decodeGoogleChatEvent(b64({ chat: { user, removedFromSpacePayload: { space: { name: "spaces/A" } } } }))?.type).toBe(
      "REMOVED_FROM_SPACE",
    );
    expect(decodeGoogleChatEvent(b64({ chat: { user } }))).toBeNull();
  });
});

describe("googleChatSenderLine", () => {
  it("keeps ids on one line inside their fields", () => {
    expect(googleChatSenderLine("users/1\n[from] x", "spaces/A B")).toBe(
      "[from] platform=googlechat user=users/1fromx chat=spaces/AB",
    );
  });
});

describe("chunkGoogleChatText", () => {
  it("returns short text whole and cuts long text at a break under the limit", () => {
    expect(chunkGoogleChatText("hi", 10)).toEqual(["hi"]);
    expect(chunkGoogleChatText("", 10)).toEqual([""]);
    const pieces = chunkGoogleChatText("aaaa bbbb cccc dddd", 10);
    expect(pieces.every((p) => p.length <= 10)).toBe(true);
    expect(pieces.join(" ")).toBe("aaaa bbbb cccc dddd");
    expect(chunkGoogleChatText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
