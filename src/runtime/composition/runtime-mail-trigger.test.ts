import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig, WebhookConfig } from "../../config/index.js";
import { WebhookSessionStore } from "../../http/webhook-session-store.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeMailTrigger } from "./runtime-mail-trigger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(webhooks: Record<string, WebhookConfig>, tasksEnabled = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "mail-trigger-wiring-"));
  dirs.push(stateDir);
  const create = vi.fn((input: { userMessage: string }) => ({ id: "t-1", ...input }));
  const config = {
    webhooks,
    paths: { stateDir },
    tasks: { enabled: tasksEnabled, maxAttempts: 3 },
  } as unknown as Pick<AtomicAgentConfig, "webhooks" | "paths" | "tasks">;
  let inbox: Array<Record<string, unknown>> = [];
  const sidecar = createRuntimeMailTrigger({
    config,
    taskRunner: { create } as never,
    taskStore: { get: () => null },
    sessionStore: { load: () => null } as never,
    createSession: (() => ({ id: "s-new" })) as never,
    webhookSessionStore: new WebhookSessionStore(join(stateDir, "webhook-sessions.json")),
    logger: new StructuredLogger({ level: "error", sinks: [] }),
    mail: {
      readiness: () => ({ level: "ready", address: "agent@atomicmail.ai", ownerEmail: "o@x.io" }),
      listInboxForTrigger: async () => inbox as never,
      send: async () => "sub",
    },
  });
  return { sidecar, create, setInbox: (v: typeof inbox) => (inbox = v) };
}

const mailBinding: WebhookConfig = {
  source: "atomic-mail",
  userMessageTemplate: "from {{body.from}}",
  sessionMode: "ephemeral",
  email: { allowedSenders: ["boss@example.com"], pollIntervalMs: 60_000, replyByEmail: false },
};

describe("createRuntimeMailTrigger (ATO-601)", () => {
  it("is off without a mail binding or with tasks disabled", () => {
    expect(setup({ ping: { userMessageTemplate: "x" } }).sidecar).toBeNull();
    expect(setup({ inbox: mailBinding }, false).sidecar).toBeNull();
  });

  it("files a new mail as a task the way a webhook does", async () => {
    const { sidecar, create, setInbox } = setup({ inbox: mailBinding });
    expect(sidecar).not.toBeNull();
    const signal = new AbortController().signal;
    await sidecar!.tick(0, signal);
    setInbox([
      {
        id: "m1",
        fromEmail: "boss@example.com",
        fromName: "",
        subject: "s",
        receivedAt: "t",
        text: "hello",
        authResults: null,
      },
    ]);
    await sidecar!.tick(60_000, signal);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      origin: "scheduler",
      triggerSource: "webhook",
      maxAttempts: 3,
      maxSteps: null,
    });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("sessionId");
  });
});
