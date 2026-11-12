import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { WebhookConfig } from "../config/index.js";
import type { AtomicMailReadiness, AtomicMailService } from "./atomic-mail-service.js";
import type { TriggerMail } from "./atomic-mail-trigger-batches.js";
import {
  AtomicMailTrigger,
  MAX_TASKS_PER_POLL,
  REPLY_CHECK_MS,
  REPLY_MAX_AGE_MS,
  activeMailBindings,
  type MailTriggerTask,
} from "./atomic-mail-trigger.js";
import { MAIL_TRIGGER_STATE_FILENAME } from "./atomic-mail-trigger-state.js";

const OWN = "atag-abc123@atomicmail.ai";

function mail(id: string, over: Partial<TriggerMail> = {}): TriggerMail {
  return {
    id,
    fromEmail: "boss@example.com",
    fromName: "",
    subject: `subject ${id}`,
    receivedAt: "2026-11-12T10:00:00Z",
    text: `text ${id}`,
    authResults: null,
    ...over,
  };
}

function binding(over: Partial<NonNullable<WebhookConfig["email"]>> = {}): WebhookConfig {
  return {
    source: "atomic-mail",
    userMessageTemplate: "Mail task from {{body.from}}",
    sessionMode: "ephemeral",
    email: { allowedSenders: ["boss@example.com"], pollIntervalMs: 60_000, replyByEmail: false, ...over },
  };
}

describe("AtomicMailTrigger (ATO-601)", () => {
  let stateDir: string;
  let inbox: TriggerMail[];
  let readiness: AtomicMailReadiness;
  let bindings: Record<string, WebhookConfig>;
  let tasks: Map<string, MailTriggerTask>;
  let created: Array<{ binding: string; userMessage: string; sessionId: string | null }>;
  let send: Mock<AtomicMailService["send"]>;
  let listInboxForTrigger: Mock<AtomicMailService["listInboxForTrigger"]>;
  let trigger: AtomicMailTrigger;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mail-trigger-"));
    inbox = [];
    readiness = { level: "ready", address: OWN, ownerEmail: "owner@example.com" };
    bindings = { inbox: binding() };
    tasks = new Map();
    created = [];
    send = vi.fn<AtomicMailService["send"]>().mockResolvedValue("sub-1");
    listInboxForTrigger = vi.fn<AtomicMailService["listInboxForTrigger"]>(async () => [...inbox]);
    trigger = new AtomicMailTrigger({
      stateDir,
      mail: { readiness: () => readiness, listInboxForTrigger, send },
      bindings: () => bindings,
      createTask: (input) => {
        created.push(input);
        const id = `t-${created.length}`;
        tasks.set(id, { status: "pending", sessionId: null });
        return { id };
      },
      resolveSessionId: () => null,
      getTask: (id) => tasks.get(id) ?? null,
      readReplyText: (sessionId) => `answer in ${sessionId}`,
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Newest first, like the server. */
  function arrive(...mails: TriggerMail[]): void {
    inbox = [...mails.reverse(), ...inbox];
  }

  it("primes on the first poll: old mail never becomes a task", async () => {
    arrive(mail("old1"), mail("old2"));
    await trigger.tick(0);
    expect(created).toEqual([]);
    const file = join(stateDir, MAIL_TRIGGER_STATE_FILENAME);
    expect(JSON.parse(readFileSync(file, "utf8")).bindings.inbox.seen).toEqual(["old2", "old1"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    arrive(mail("new1"));
    await trigger.tick(60_000);
    expect(created).toHaveLength(1);
    expect(created[0]!.binding).toBe("inbox");
    expect(created[0]!.userMessage.startsWith("Mail task from boss@example.com\n\n")).toBe(true);
    expect(created[0]!.userMessage).toContain("text new1");
    expect(created[0]!.userMessage).toContain("<<<UNTRUSTED EXTERNAL CONTENT");
  });

  it("creates each message once, oldest first, across restarts", async () => {
    await trigger.tick(0);
    arrive(mail("a"), mail("b"));
    await trigger.tick(60_000);
    expect(created.map((c) => c.userMessage.includes("text a"))).toEqual([true, false]);
    const again = new AtomicMailTrigger({
      stateDir,
      mail: { readiness: () => readiness, listInboxForTrigger, send },
      bindings: () => bindings,
      createTask: (input) => {
        created.push(input);
        return { id: `t-x${created.length}` };
      },
      resolveSessionId: () => null,
      getTask: () => null,
      readReplyText: () => null,
    });
    await again.tick(500_000);
    expect(created).toHaveLength(2);
  });

  it("polls no more often than pollIntervalMs", async () => {
    await trigger.tick(0);
    await trigger.tick(30_000);
    expect(listInboxForTrigger).toHaveBeenCalledTimes(1);
    await trigger.tick(60_000);
    expect(listInboxForTrigger).toHaveBeenCalledTimes(2);
  });

  it("ignores senders off the list, forged senders and its own address", async () => {
    await trigger.tick(0);
    arrive(
      mail("stranger", { fromEmail: "stranger@example.com" }),
      mail("forged", { authResults: "mx; dmarc=fail" }),
      mail("self", { fromEmail: OWN }),
      mail("ok"),
    );
    await trigger.tick(60_000);
    expect(created).toHaveLength(1);
    expect(created[0]!.userMessage).toContain("text ok");
    // Refused messages are marked seen, never retried.
    await trigger.tick(120_000);
    expect(created).toHaveLength(1);
  });

  it("does not poll at all with an empty allow-list or no mail binding", async () => {
    bindings = { inbox: binding({ allowedSenders: [] }), ping: { userMessageTemplate: "x" } };
    await trigger.tick(0);
    await trigger.tick(60_000);
    expect(listInboxForTrigger).not.toHaveBeenCalled();
    expect(activeMailBindings(bindings)).toEqual([]);
  });

  it("does not poll without an inbox", async () => {
    readiness = { level: "no_inbox" };
    await trigger.tick(0);
    expect(listInboxForTrigger).not.toHaveBeenCalled();
  });

  it(`creates at most ${MAX_TASKS_PER_POLL} tasks per poll; the rest wait`, async () => {
    await trigger.tick(0);
    arrive(...Array.from({ length: MAX_TASKS_PER_POLL + 2 }, (_, i) => mail(`m${i}`)));
    await trigger.tick(60_000);
    expect(created).toHaveLength(MAX_TASKS_PER_POLL);
    await trigger.tick(120_000);
    expect(created).toHaveLength(MAX_TASKS_PER_POLL + 2);
  });

  it("survives an inbox error and keeps going", async () => {
    await trigger.tick(0);
    listInboxForTrigger.mockRejectedValueOnce(new Error("401"));
    await expect(trigger.tick(60_000)).resolves.toBeUndefined();
    arrive(mail("later"));
    await trigger.tick(120_000);
    expect(created).toHaveLength(1);
  });

  describe("replyByEmail", () => {
    beforeEach(() => {
      bindings = { inbox: binding({ replyByEmail: true }) };
    });

    it("mails the final answer to the sender once the task completes", async () => {
      await trigger.tick(0);
      arrive(mail("q", { subject: "Question" }));
      await trigger.tick(60_000);
      expect(send).not.toHaveBeenCalled();
      tasks.set("t-1", { status: "completed", sessionId: "s-9" });
      await trigger.tick(60_000 + REPLY_CHECK_MS);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toEqual({
        to: "boss@example.com",
        subject: "Re: Question",
        text: "answer in s-9",
      });
      await trigger.tick(60_000 + 2 * REPLY_CHECK_MS);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("retries a failed send and drops a cancelled task", async () => {
      await trigger.tick(0);
      arrive(mail("q1"), mail("q2"));
      await trigger.tick(60_000);
      tasks.set("t-1", { status: "failed", sessionId: null });
      tasks.set("t-2", { status: "cancelled", sessionId: null });
      send.mockRejectedValueOnce(new Error("down"));
      await trigger.tick(60_000 + REPLY_CHECK_MS);
      await trigger.tick(60_000 + 2 * REPLY_CHECK_MS);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0].text).toContain("could not finish");
    });

    it("gives up on a reply after a day", async () => {
      await trigger.tick(0);
      arrive(mail("q"));
      await trigger.tick(60_000);
      tasks.set("t-1", { status: "completed", sessionId: "s" });
      await trigger.tick(60_000 + REPLY_MAX_AGE_MS + REPLY_CHECK_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("never replies when replyByEmail is off", async () => {
      bindings = { inbox: binding({ replyByEmail: false }) };
      await trigger.tick(0);
      arrive(mail("q"));
      await trigger.tick(60_000);
      tasks.set("t-1", { status: "completed", sessionId: "s" });
      await trigger.tick(60_000 + REPLY_CHECK_MS);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
