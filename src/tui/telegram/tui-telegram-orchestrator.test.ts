import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TelegramChannel } from "../../channels/telegram/telegram-channel.js";
import type {
  PairingOutcome,
  StartPairingOptions,
} from "../../channels/telegram/telegram-channel.js";
import type { TuiAction } from "../tui-action.js";

import { TuiTelegramOrchestrator } from "./tui-telegram-orchestrator.js";

interface FakeChannel {
  state: ReturnType<typeof vi.fn>;
  lastError: ReturnType<typeof vi.fn>;
  getOwnerUserId: ReturnType<typeof vi.fn>;
  getBotIdentity: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  setOwnerUserId: ReturnType<typeof vi.fn>;
  setToken: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  startPairing: ReturnType<typeof vi.fn>;
  cancelPairing: ReturnType<typeof vi.fn>;
}

/** A fake `startPairing` that opens a window (code 123456) and settles with `result`. */
function opensWindow(
  result: () => Promise<PairingOutcome | null>,
): (timeoutMs?: number, options?: StartPairingOptions) => Promise<PairingOutcome | null> {
  return (timeoutMs = 300_000, options = {}) => {
    options.onOpened?.({ code: "123456", expiresAt: Date.now() + timeoutMs });
    return result();
  };
}

function makeFakeChannel(overrides: Partial<FakeChannel> = {}): FakeChannel {
  return {
    state: vi.fn(() => "disabled" as const),
    lastError: vi.fn(() => null),
    getOwnerUserId: vi.fn(() => null),
    getBotIdentity: vi.fn(() => null),
    setEnabled: vi.fn(async () => {}),
    setOwnerUserId: vi.fn(async () => {}),
    setToken: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    startPairing: vi.fn(opensWindow(async () => null)),
    cancelPairing: vi.fn(),
    ...overrides,
  };
}

function makeBus(): {
  emit: (action: unknown) => void;
  subscribe: (l: (action: TuiAction) => void) => () => void;
  actions: Array<{ type: string } & Record<string, unknown>>;
} {
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

function makeRuntime(channel: FakeChannel | null): AgentRuntime {
  return {
    telegramChannel: channel as unknown as TelegramChannel | null,
  } as unknown as AgentRuntime;
}

describe("TuiTelegramOrchestrator", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "tui-telegram-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfigCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("start() emits initial settings + status snapshot", () => {
    const channel = makeFakeChannel({
      state: vi.fn(() => "down" as const),
      lastError: vi.fn(() => "missing TELEGRAM_BOT_TOKEN"),
      getOwnerUserId: vi.fn(() => 42),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    orch.start();

    const synced = bus.actions.find(
      (a) => a.type === "telegram_settings_synced",
    );
    const status = bus.actions.find(
      (a) => a.type === "telegram_status_changed",
    );
    expect(synced).toMatchObject({
      enabled: false,
      ownerUserId: 42,
      hasToken: false,
    });
    expect(status).toMatchObject({
      channelState: "down",
      lastError: "missing TELEGRAM_BOT_TOKEN",
    });
  });

  it("start() is a no-op without a telegramChannel except settings sync", () => {
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(null), bus);

    orch.start();

    expect(
      bus.actions.find((a) => a.type === "telegram_status_changed"),
    ).toBeUndefined();
    expect(
      bus.actions.find((a) => a.type === "telegram_settings_synced"),
    ).toBeDefined();
  });

  it("forwardStatus returns false for non-telegram channels", () => {
    const orch = new TuiTelegramOrchestrator(
      makeRuntime(makeFakeChannel()),
      makeBus(),
    );
    expect(orch.forwardStatus({ channel: "other", state: "up" })).toBe(false);
  });

  it("forwardStatus emits status_changed for telegram channel", () => {
    const channel = makeFakeChannel();
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    orch.forwardStatus({
      channel: "telegram",
      state: "up",
    });

    expect(
      bus.actions.find((a) => a.type === "telegram_status_changed"),
    ).toMatchObject({ channelState: "up", lastError: null });
  });

  it("setEnabled emits started + settled and forwards to channel", async () => {
    const channel = makeFakeChannel();
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.setEnabled(true);

    expect(channel.setEnabled).toHaveBeenCalledWith(true);
    const types = bus.actions.map((a) => a.type);
    expect(types).toContain("telegram_action_started");
    expect(types).toContain("telegram_action_settled");
    const settled = bus.actions.find(
      (a) => a.type === "telegram_action_settled",
    );
    expect(settled?.message).toMatch(/enabled/);
  });

  it("setEnabled surfaces channel errors via telegram_action_settled", async () => {
    const channel = makeFakeChannel({
      setEnabled: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.setEnabled(true);

    const settled = bus.actions.find(
      (a) => a.type === "telegram_action_settled",
    );
    expect(settled?.error).toMatch(/setEnabled failed.*nope/);
  });

  it("setEnabled is a no-op without a channel and emits an info line", async () => {
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(null), bus);

    await orch.setEnabled(true);

    expect(
      bus.actions.find((a) => a.type === "telegram_action_started"),
    ).toBeUndefined();
    expect(bus.actions.find((a) => a.type === "runtime_info")).toBeDefined();
  });

  it("submitToken rejects an empty buffer locally without calling channel", async () => {
    const channel = makeFakeChannel();
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.submitToken("   ");

    expect(channel.setToken).not.toHaveBeenCalled();
    expect(
      bus.actions.find((a) => a.type === "telegram_token_prompt_error_set"),
    ).toMatchObject({ error: "token is empty" });
  });

  it("submitToken happy path closes prompt and trims the buffer", async () => {
    const channel = makeFakeChannel();
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.submitToken("  abc:xyz  ");

    expect(channel.setToken).toHaveBeenCalledWith("abc:xyz");
    const types = bus.actions.map((a) => a.type);
    expect(types).toContain("telegram_token_prompt_submitting_started");
    expect(types).toContain("telegram_token_prompt_closed");
    // Token never lands in any emitted action payload.
    for (const action of bus.actions) {
      expect(JSON.stringify(action)).not.toContain("abc:xyz");
    }
  });

  it("submitToken success auto-advances the setup flow (calls setEnabled)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "real:token";
    const channel = makeFakeChannel({
      // Channel still appears disabled until setEnabled lands.
      state: vi.fn(() => "disabled" as const),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.submitToken("real:token");

    expect(channel.setToken).toHaveBeenCalledWith("real:token");
    expect(channel.setEnabled).toHaveBeenCalledWith(true);
  });

  it("submitToken surfaces the channel error inside the modal", async () => {
    const channel = makeFakeChannel({
      setToken: vi.fn(async () => {
        throw new Error("getMe rejected");
      }),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.submitToken("abc:xyz");

    const error = bus.actions.find(
      (a) => a.type === "telegram_token_prompt_error_set",
    );
    expect(error?.error).toMatch(/getMe rejected/);
    // Modal must NOT close on error so the operator can retry.
    expect(
      bus.actions.find((a) => a.type === "telegram_token_prompt_closed"),
    ).toBeUndefined();
  });

  it("startPairing refuses unless the channel is `up`", async () => {
    const channel = makeFakeChannel({ state: vi.fn(() => "down" as const) });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.startPairing(60_000);

    expect(channel.startPairing).not.toHaveBeenCalled();
    expect(
      bus.actions.find((a) => a.type === "telegram_pairing_started"),
    ).toBeUndefined();
    expect(bus.actions.find((a) => a.type === "runtime_info")).toBeDefined();
  });

  it("startPairing emits started + tick + resolved on success and forwards welcomeDelivered", async () => {
    vi.useFakeTimers();
    let resolveClaim: ((outcome: PairingOutcome) => void) | null = null;
    const channel = makeFakeChannel({
      state: vi.fn(() => "up" as const),
      startPairing: vi.fn(
        opensWindow(
          () =>
            new Promise<PairingOutcome | null>((res) => {
              resolveClaim = res;
            }),
        ),
      ),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    const pending = orch.startPairing(60_000);

    expect(
      bus.actions.find((a) => a.type === "telegram_pairing_started"),
    ).toBeDefined();

    // Advance the 1s ticker once to ensure tick events flow.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      bus.actions.find((a) => a.type === "telegram_pairing_tick"),
    ).toBeDefined();

    resolveClaim?.({
      claim: { userId: 7, chatId: 99, username: "owner_7" },
      welcomeDelivered: true,
    });
    await pending;

    const resolved = bus.actions.find(
      (a) => a.type === "telegram_pairing_resolved",
    );
    expect(resolved).toMatchObject({
      result: { userId: 7, chatId: 99, username: "owner_7", welcomeDelivered: true },
    });
  });

  it("startPairing forwards welcomeDelivered=false when the welcome was skipped or rejected", async () => {
    const channel = makeFakeChannel({
      state: vi.fn(() => "up" as const),
      startPairing: vi.fn(
        opensWindow(async () => ({
          claim: { userId: 11, chatId: 22, username: null },
          welcomeDelivered: false,
        })),
      ),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    await orch.startPairing(60_000);

    const resolved = bus.actions.find(
      (a) => a.type === "telegram_pairing_resolved",
    );
    expect(resolved).toMatchObject({
      result: { userId: 11, chatId: 22, welcomeDelivered: false },
    });
  });

  it("cancelPairing forwards to the channel and clears the modal timer", async () => {
    vi.useFakeTimers();
    const channel = makeFakeChannel({
      state: vi.fn(() => "up" as const),
      startPairing: vi.fn(opensWindow(() => new Promise(() => {}))),
    });
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

    void orch.startPairing(60_000);
    orch.cancelPairing();

    expect(channel.cancelPairing).toHaveBeenCalled();
    // No further ticks after cancel.
    bus.actions.length = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      bus.actions.find((a) => a.type === "telegram_pairing_tick"),
    ).toBeUndefined();
  });

  describe("one-time code and owner replacement (ATO-718)", () => {
    const infoLines = (bus: ReturnType<typeof makeBus>): string[] =>
      bus.actions
        .filter((a) => a.type === "runtime_info")
        .map((a) => String(a.line));

    it("requestPairing hands back the window's code, opened with the 5-minute default", () => {
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getBotIdentity: vi.fn(() => ({ id: 1, username: "my_bot" })),
        startPairing: vi.fn(opensWindow(() => new Promise(() => {}))),
      });
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), makeBus());
      const request = orch.requestPairing();
      expect(request).toMatchObject({
        kind: "opened",
        code: "123456",
        botUsername: "my_bot",
        timeoutMs: 5 * 60_000,
      });
      expect(channel.startPairing).toHaveBeenCalledWith(
        5 * 60_000,
        expect.objectContaining({ replaceOwner: false }),
      );
      orch.shutdown();
    });

    it("keeps the code out of panel actions", () => {
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        startPairing: vi.fn(opensWindow(() => new Promise(() => {}))),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      orch.requestPairing();
      const panelActions = bus.actions.filter((a) => a.type.startsWith("telegram_"));
      expect(panelActions.length).toBeGreaterThan(0);
      expect(JSON.stringify(panelActions)).not.toContain("123456");
      orch.shutdown();
    });

    it("/telegram pair narrates the code, then the new owner's @username", async () => {
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getBotIdentity: vi.fn(() => ({ id: 1, username: "my_bot" })),
        startPairing: vi.fn(
          opensWindow(async () => ({
            claim: { userId: 7, chatId: 7, username: "new_owner" },
            welcomeDelivered: true,
          })),
        ),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.startPairing();
      // The code is shown on the Integrations status line, the tab the
      // command switches to, and kept out of the runtime feed, which
      // issue reports include.
      const status = bus.actions
        .filter((a) => a.type === "integrations_action_settled")
        .map((a) => String(a.message));
      expect(status[0]).toContain("/start 123456");
      expect(status[0]).toContain("@my_bot");
      expect(status[0]).toContain("5 minutes");
      expect(status[1]).toBe("Paired: @new_owner is now the owner.");
      const lines = infoLines(bus);
      expect(lines.join("\n")).not.toContain("123456");
      expect(lines[lines.length - 1]).toBe("Paired: @new_owner is now the owner.");
      expect([...status, ...lines].join("\n")).not.toContain("—");
      orch.shutdown();
    });

    it("asks before replacing a paired owner, and opens on the second ask", async () => {
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getOwnerUserId: vi.fn(() => 42),
        startPairing: vi.fn(opensWindow(async () => null)),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

      expect(orch.requestPairing()).toEqual({
        kind: "confirm_replace",
        ownerUserId: 42,
      });
      expect(channel.startPairing).not.toHaveBeenCalled();

      const second = orch.requestPairing();
      expect(second.kind).toBe("opened");
      expect(channel.startPairing).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ replaceOwner: true }),
      );
      orch.shutdown();
    });

    it("lets the replace confirmation lapse after the confirm window", () => {
      vi.useFakeTimers();
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getOwnerUserId: vi.fn(() => 42),
      });
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), makeBus());
      expect(orch.requestPairing().kind).toBe("confirm_replace");
      vi.advanceTimersByTime(16_000);
      expect(orch.requestPairing().kind).toBe("confirm_replace");
      expect(channel.startPairing).not.toHaveBeenCalled();
      orch.shutdown();
    });

    it("/telegram pair with a paired owner only says how to confirm", async () => {
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getOwnerUserId: vi.fn(() => 42),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.startPairing();
      expect(channel.startPairing).not.toHaveBeenCalled();
      expect(infoLines(bus)[0]).toContain("Run /telegram pair again within 15 seconds");
    });
  });

  it("shutdown clears active timers without throwing", () => {
    const orch = new TuiTelegramOrchestrator(
      makeRuntime(makeFakeChannel()),
      makeBus(),
    );
    expect(() => orch.shutdown()).not.toThrow();
  });

  describe("advanceConnect", () => {
    it("opens the token prompt when no token is present", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const channel = makeFakeChannel();
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.advanceConnect();
      expect(
        bus.actions.find((a) => a.type === "telegram_token_prompt_opened"),
      ).toBeDefined();
      expect(channel.setEnabled).not.toHaveBeenCalled();
      expect(channel.startPairing).not.toHaveBeenCalled();
    });

    it("calls setEnabled(true) when token present but channel is disabled", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      const channel = makeFakeChannel({
        state: vi.fn(() => "disabled" as const),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.advanceConnect();
      expect(channel.setEnabled).toHaveBeenCalledWith(true);
    });

    it("calls setEnabled(true) (NOT restart) when token present but channel is `down`", async () => {
      // Locks the post-review fix: TelegramChannel.restart() from
      // `down` is a no-op (it only re-runs `start` when wasUp), so
      // mapping `down` → `restart` would trap the user in two-press
      // recovery from a rejected token. The flow now retries via
      // `set_enabled(true)` which actually calls `start()`.
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      const channel = makeFakeChannel({
        state: vi.fn(() => "down" as const),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.advanceConnect();
      expect(channel.setEnabled).toHaveBeenCalledWith(true);
      expect(channel.restart).not.toHaveBeenCalled();
    });

    it("starts pairing when up + no owner", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getOwnerUserId: vi.fn(() => null),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.advanceConnect();
      expect(channel.startPairing).toHaveBeenCalled();
    });

    it("is a no-op when up + paired (already connected)", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      const channel = makeFakeChannel({
        state: vi.fn(() => "up" as const),
        getOwnerUserId: vi.fn(() => 42),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);
      await orch.advanceConnect();
      expect(channel.setEnabled).not.toHaveBeenCalled();
      expect(channel.startPairing).not.toHaveBeenCalled();
      expect(channel.restart).not.toHaveBeenCalled();
    });

    it("emits an info line when no telegram channel is present", async () => {
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(null), bus);
      await orch.advanceConnect();
      expect(bus.actions.find((a) => a.type === "runtime_info")).toBeDefined();
    });

    it("ignores a second concurrent advanceConnect while the first is in flight", async () => {
      // Locks the busy-guard fix: a rapid double-Enter would cause
      // pairing.start() to cancel the first window via its
      // replace-on-active contract, flickering the modal twice. The
      // guard prevents the second dispatch entirely.
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      let mockState: "disabled" | "up" = "disabled";
      const channel = makeFakeChannel({
        state: vi.fn(() => mockState),
        getOwnerUserId: vi.fn(() => null),
        setEnabled: vi.fn(async () => {
          mockState = "up";
        }),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

      const first = orch.advanceConnect();
      const second = orch.advanceConnect();
      await Promise.all([first, second]);

      expect(channel.setEnabled).toHaveBeenCalledTimes(1);
      expect(channel.startPairing).toHaveBeenCalledTimes(1);
    });

    it("after a successful set_enabled re-enters the flow exactly once and starts pairing", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      // Mutable state machine: starts disabled, transitions to up
      // once `setEnabled(true)` lands. Owner stays null so the
      // recursion's next decision is `start_pairing`.
      let mockState: "disabled" | "up" = "disabled";
      const channel = makeFakeChannel({
        state: vi.fn(() => mockState),
        getOwnerUserId: vi.fn(() => null),
        setEnabled: vi.fn(async () => {
          mockState = "up";
        }),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

      await orch.advanceConnect();

      expect(channel.setEnabled).toHaveBeenCalledTimes(1);
      expect(channel.startPairing).toHaveBeenCalledTimes(1);
    });

    it("does NOT recurse when set_enabled lands the channel in `down` (avoids restart loops)", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "abc:xyz";
      // disabled → setEnabled lands in `down` (token was rejected).
      let mockState: "disabled" | "down" = "disabled";
      const channel = makeFakeChannel({
        state: vi.fn(() => mockState),
        setEnabled: vi.fn(async () => {
          mockState = "down";
        }),
      });
      const bus = makeBus();
      const orch = new TuiTelegramOrchestrator(makeRuntime(channel), bus);

      await orch.advanceConnect();

      expect(channel.setEnabled).toHaveBeenCalledTimes(1);
      expect(channel.restart).not.toHaveBeenCalled();
      expect(channel.startPairing).not.toHaveBeenCalled();
    });
  });

  it("toggleAdvanced emits telegram_advanced_toggled", () => {
    const bus = makeBus();
    const orch = new TuiTelegramOrchestrator(
      makeRuntime(makeFakeChannel()),
      bus,
    );
    orch.toggleAdvanced();
    expect(
      bus.actions.find((a) => a.type === "telegram_advanced_toggled"),
    ).toBeDefined();
  });
});
