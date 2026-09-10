import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtomicMailService } from "../../atomic-mail/index.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";

function makeBus() {
  const actions: Array<{ type: string } & Record<string, unknown>> = [];
  return {
    emit(action: unknown) {
      actions.push(action as { type: string } & Record<string, unknown>);
    },
    subscribe() {
      return () => {};
    },
    actions,
  };
}

function settledMessages(
  bus: ReturnType<typeof makeBus>,
): Array<{ message?: string; error?: string }> {
  return bus.actions.filter(
    (a) => a.type === "integrations_action_settled",
  ) as never;
}

describe("IntegrationsOrchestrator — Atomic Mail", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "integrations-mail-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.ATOMIC_MAIL_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_MAIL_API_KEY;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeHub(service: Partial<AtomicMailService>) {
    const bus = makeBus();
    const runtime = {
      telegramChannel: null,
      discordChannel: null,
      mcpManager: { listStatuses: () => [] },
    } as unknown as AgentRuntime;
    const hub = new IntegrationsOrchestrator(
      runtime,
      bus,
      undefined,
      {},
      service as AtomicMailService,
    );
    return { hub, bus };
  }

  it("r registers in the background and reports the address when it lands", async () => {
    let resolveRegister: (v: { address: string }) => void = () => undefined;
    const register = vi.fn(
      () =>
        new Promise<{ address: string }>((r) => {
          resolveRegister = r;
        }),
    );
    const { hub, bus } = makeHub({ register });
    await hub.runAction("atomic-mail", "register");
    expect(settledMessages(bus).at(-1)?.message).toMatch(
      /solving a proof-of-work/i,
    );
    expect(getConfig().atomicMail.ownerEmail).toBeNull();
    resolveRegister({ address: "atag-abc123@atomicmail.ai" });
    await new Promise((r) => setTimeout(r, 0));
    expect(settledMessages(bus).at(-1)?.message).toBe(
      "Inbox ready: atag-abc123@atomicmail.ai — now press e on Your e-mail",
    );
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("saving Your e-mail mails a code; the code field is checked and never stored", async () => {
    const sendCode = vi.fn(async (email: string) => ({
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      email,
    }));
    const verifyCode = vi.fn((raw: string) =>
      raw === "482913"
        ? { ok: true as const, email: "v@x.io" }
        : { ok: false as const, reason: "that is not the code in the mail" },
    );
    const { hub, bus } = makeHub({ sendCode, verifyCode });

    await hub.saveField("atomic-mail", "ownerEmail", "v@x.io");
    expect(sendCode).toHaveBeenCalledWith("v@x.io");
    // The service, not the hub, writes the owner — atomically with the send.
    expect(settledMessages(bus).at(-1)?.message).toMatch(
      /^Code sent to v@x\.io/,
    );

    await hub.saveField("atomic-mail", "verificationCode", "000000");
    expect(settledMessages(bus).at(-1)?.error).toBe(
      "that is not the code in the mail",
    );
    await hub.saveField("atomic-mail", "verificationCode", "482913");
    expect(settledMessages(bus).at(-1)?.message).toBe(
      "v@x.io verified — downloads can e-mail you now",
    );
    // Nothing named the code lands in config.
    expect(JSON.stringify(getConfig())).not.toContain("482913");
  });

  it("a code mail that cannot be sent leaves the owner address unwritten", async () => {
    const sendCode = vi.fn(async () => {
      throw new Error("capability failed: HTTP 503");
    });
    const { hub, bus } = makeHub({ sendCode });
    await hub.saveField("atomic-mail", "ownerEmail", "  v@x.io ");
    expect(sendCode).toHaveBeenCalledWith("v@x.io");
    expect(settledMessages(bus).at(-1)?.error).toMatch(/HTTP 503/);
    expect(getConfig().atomicMail.ownerEmail).toBeNull();
  });

  it("a second r while registering joins the first instead of making a second inbox", async () => {
    let resolveRegister: (v: { address: string }) => void = () => undefined;
    const register = vi.fn(
      () =>
        new Promise<{ address: string }>((r) => {
          resolveRegister = r;
        }),
    );
    const { hub, bus } = makeHub({ register });
    await hub.runAction("atomic-mail", "register");
    await hub.runAction("atomic-mail", "register");
    expect(register).toHaveBeenCalledTimes(1);
    expect(settledMessages(bus).at(-1)?.message).toMatch(/Still registering/);
    resolveRegister({ address: "atag-1@atomicmail.ai" });
    await new Promise((r) => setTimeout(r, 0));
    expect(settledMessages(bus).at(-1)?.message).toMatch(
      /Inbox ready: atag-1@atomicmail.ai/,
    );
  });

  it("replacing or clearing the key reconnects — the old inbox's session is never reused", async () => {
    const reconnect = vi.fn(async () => ({ address: "atag-2@atomicmail.ai" }));
    const { hub, bus } = makeHub({ reconnect });
    await hub.saveField("atomic-mail", "apiKey", "new-key");
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(settledMessages(bus).at(-1)?.message).toBe(
      "Inbox connected: atag-2@atomicmail.ai",
    );
  });

  it("the row shows the owner as verified once config says so", () => {
    const { hub, bus } = makeHub({});
    process.env.ATOMIC_MAIL_API_KEY = "k";
    hub.refresh();
    const rows = (
      bus.actions.find((a) => a.type === "integrations_synced") as {
        rows: Array<{
          id: string;
          level: string;
          fields: Array<{ key: string; readonly?: boolean }>;
        }>;
      }
    ).rows;
    const mail = rows.find((r) => r.id === "atomic-mail")!;
    expect(mail.level).toBe("configured");
    expect(mail.fields.find((f) => f.key === "address")?.readonly).toBe(true);
  });
});
