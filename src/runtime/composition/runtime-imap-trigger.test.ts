import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig, WebhookConfig } from "../../config/index.js";
import { IMAP_ATTACHMENT_DEFAULTS } from "../../config/imap-trigger-config.js";
import { WebhookSessionStore } from "../../http/webhook-session-store.js";
import { FakeImapServer } from "../../imap-mail/fake-imap-server-test-helpers.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeImapTrigger } from "./runtime-imap-trigger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const imapBinding: WebhookConfig = {
  source: "imap",
  userMessageTemplate: "from {{body.from}}",
  sessionMode: "ephemeral",
  email: { allowedSenders: ["boss@example.com"], pollIntervalMs: 60_000, replyByEmail: false, trustFromHeader: true },
  imap: {
    host: "imap.example.com",
    port: 993,
    user: "me@example.com",
    auth: "login",
    password: "app-password",
    mailbox: "INBOX",
    idle: false,
    markSeen: true,
    attachments: IMAP_ATTACHMENT_DEFAULTS,
  },
};

function setup(webhooks: Record<string, WebhookConfig>, tasksEnabled = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "imap-trigger-wiring-"));
  dirs.push(stateDir);
  const server = new FakeImapServer();
  const create = vi.fn((input: { userMessage: string }) => ({ id: "t-1", ...input }));
  const config = {
    webhooks,
    paths: { stateDir },
    tasks: { enabled: tasksEnabled, maxAttempts: 3 },
  } as unknown as Pick<AtomicAgentConfig, "webhooks" | "paths" | "tasks">;
  const sidecar = createRuntimeImapTrigger({
    config,
    taskRunner: { create } as never,
    createSession: (() => ({ id: "s-new" })) as never,
    webhookSessionStore: new WebhookSessionStore(join(stateDir, "webhook-sessions.json")),
    logger: new StructuredLogger({ level: "error", sinks: [] }),
    connect: async () => server.connect(),
  });
  return { sidecar, create, server };
}

describe("createRuntimeImapTrigger (ATO-601)", () => {
  it("is off without an imap binding or with tasks disabled", () => {
    expect(setup({ ping: { userMessageTemplate: "x" } }).sidecar).toBeNull();
    expect(setup({ gmail: imapBinding }, false).sidecar).toBeNull();
  });

  it("files a mail as a scheduler-origin webhook task", async () => {
    const { sidecar, create, server } = setup({ gmail: imapBinding });
    const signal = new AbortController().signal;
    await sidecar!.tick(Date.now(), signal);
    server.deliver("From: boss@example.com\r\nSubject: hi\r\n\r\nplease\r\n");
    await sidecar!.tick(Date.now() + 61_000, signal);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ origin: "scheduler", triggerSource: "webhook", maxAttempts: 3, maxSteps: null });
  });
});
