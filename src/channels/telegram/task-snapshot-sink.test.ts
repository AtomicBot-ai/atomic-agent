import { describe, expect, it, vi } from "vitest";

import type { TaskLiveStatus } from "../../tasks/index.js";
import { TelegramChannel } from "./telegram-channel.js";

// ATO-965: the Telegram route for auto status snapshots of running tasks.

const status = { taskId: "t1", userMessage: "nightly", startedAt: 0 } as TaskLiveStatus;

function fakeChannel() {
  return {
    sendTaskSnapshot: vi.fn(async () => "sent" as const),
    endTaskSnapshot: vi.fn(async () => undefined),
  };
}

describe("TelegramChannel.buildTaskSnapshotSink", () => {
  it("routes updates and the end to the live channel", async () => {
    const channel = fakeChannel();
    const sink = TelegramChannel.buildTaskSnapshotSink({
      resolveChannel: () => channel as unknown as TelegramChannel,
    });
    await sink.update(status);
    await sink.end("t1");
    expect(channel.sendTaskSnapshot).toHaveBeenCalledWith(status);
    expect(channel.endTaskSnapshot).toHaveBeenCalledWith("t1");
  });

  it("stays silent inside quiet hours", async () => {
    const channel = fakeChannel();
    const sink = TelegramChannel.buildTaskSnapshotSink({
      resolveChannel: () => channel as unknown as TelegramChannel,
      quietHours: { start: "23:00", end: "08:00" },
      now: () => new Date(2026, 0, 1, 2, 0),
    });
    await sink.update(status);
    expect(channel.sendTaskSnapshot).not.toHaveBeenCalled();
  });

  it("does nothing when the channel is not constructed yet", async () => {
    const sink = TelegramChannel.buildTaskSnapshotSink({ resolveChannel: () => null });
    await expect(sink.update(status)).resolves.toBeUndefined();
    await expect(sink.end("t1")).resolves.toBeUndefined();
  });
});
