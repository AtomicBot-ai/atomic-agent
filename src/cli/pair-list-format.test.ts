import { describe, expect, it } from "vitest";

import { formatDeviceLine, humanDate, timeAgo } from "./pair-list-format.js";

/** ATO-2758: `atag pair --list` prints dates people read. */
describe("pair --list dates", () => {
  const now = new Date("2026-11-27T12:00:00.000Z");
  const utc = { locale: "en-US", timeZone: "UTC" };

  it("says how long ago, up to 30 days", () => {
    expect(timeAgo(new Date("2026-11-27T11:59:40.000Z"), now)).toBe("just now");
    expect(timeAgo(new Date("2026-11-27T11:55:00.000Z"), now)).toBe("5 minutes ago");
    expect(timeAgo(new Date("2026-11-27T11:00:00.000Z"), now)).toBe("1 hour ago");
    expect(timeAgo(new Date("2026-11-24T12:00:00.000Z"), now)).toBe("3 days ago");
    expect(timeAgo(new Date("2026-09-01T12:00:00.000Z"), now)).toBeNull();
  });

  it("prints the local date and time, not the ISO stamp", () => {
    const text = humanDate("2026-11-24T10:00:00.000Z", now, utc);
    expect(text).toContain("Nov 24, 2026");
    expect(text).toContain("10:00");
    expect(text).toContain("(3 days ago)");
    expect(text).not.toContain("T10:00:00");
    expect(humanDate("not a date", now, utc)).toBe("not a date");
  });

  it("formats a device line with the age alone for a recent last seen", () => {
    const line = formatDeviceLine(
      { id: "ab12", name: "iPhone", createdAt: "2026-11-24T10:00:00.000Z", lastSeenAt: "2026-11-27T10:00:00.000Z" },
      now,
      utc,
    );
    expect(line).toMatch(/^ab12 {2}iPhone {11}paired Nov 24, 2026/);
    expect(line).toContain("last seen 2 hours ago");
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
