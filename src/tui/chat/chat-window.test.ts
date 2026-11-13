import { describe, expect, it } from "vitest";
import {
  MIN_OVERSCAN_ROWS,
  chatOverscanRows,
  computeChatWindow,
  widenChatWindow,
  type ChatWindowInput,
} from "./chat-window.js";

function input(overrides: Partial<ChatWindowInput>): ChatWindowInput {
  return {
    heights: [],
    bottomRows: 0,
    offset: 0,
    viewportRows: 10,
    overscanRows: 0,
    ...overrides,
  };
}

/** Ten messages of five rows: 50 rows of chat. */
const TEN_BY_FIVE = Array.from({ length: 10 }, () => 5);

describe("computeChatWindow", () => {
  it("draws nothing and needs no spacer for an empty log", () => {
    expect(computeChatWindow(input({ bottomRows: 3 }))).toEqual({
      start: 0,
      end: 0,
      spacerAbove: 0,
      spacerBelow: 0,
      totalRows: 3,
    });
  });

  it("draws every message of a chat shorter than the viewport", () => {
    const window = computeChatWindow(
      input({ heights: [2, 3, 1], viewportRows: 20 }),
    );
    expect(window).toEqual({
      start: 0,
      end: 3,
      spacerAbove: 0,
      spacerBelow: 0,
      totalRows: 6,
    });
  });

  it("pinned to the bottom, draws only the newest messages that reach the viewport", () => {
    // 10 rows of viewport over 5-row messages: the last two fill it.
    const window = computeChatWindow(input({ heights: TEN_BY_FIVE }));
    expect(window.start).toBe(8);
    expect(window.end).toBe(10);
    expect(window.spacerAbove).toBe(40);
    expect(window.spacerBelow).toBe(0);
    expect(window.totalRows).toBe(50);
  });

  it("includes a message that is only partly inside the viewport", () => {
    // 12 rows: two whole messages and two rows of the third.
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, viewportRows: 12 }),
    );
    expect(window.start).toBe(7);
    expect(window.end).toBe(10);
  });

  it("scrolled up, replaces the newer messages with a spacer below", () => {
    // Offset 20 shows rows 20..29 from the bottom: messages 4 and 5.
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, offset: 20 }),
    );
    expect(window).toEqual({
      start: 4,
      end: 6,
      spacerAbove: 20,
      spacerBelow: 20,
      totalRows: 50,
    });
  });

  it("at the top of the chat, draws the oldest messages", () => {
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, offset: 40 }),
    );
    expect(window.start).toBe(0);
    expect(window.end).toBe(2);
    expect(window.spacerAbove).toBe(0);
    expect(window.spacerBelow).toBe(40);
  });

  it("widens the drawn band by the overscan on both sides", () => {
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, offset: 20, overscanRows: 5 }),
    );
    expect(window.start).toBe(3);
    expect(window.end).toBe(7);
    expect(window.spacerAbove).toBe(15);
    expect(window.spacerBelow).toBe(15);
  });

  it("does not draw a message that only touches the band's edge", () => {
    // Message 7 ends exactly where the viewport starts at offset 10.
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, offset: 10 }),
    );
    expect(window.start).toBe(6);
    expect(window.end).toBe(8);
  });

  it("counts the live rows under the messages before the viewport reaches them", () => {
    // Six live rows leave four for the newest message.
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, bottomRows: 6 }),
    );
    expect(window.start).toBe(9);
    expect(window.end).toBe(10);
    expect(window.spacerAbove).toBe(45);
    expect(window.totalRows).toBe(56);
  });

  it("draws no message while the live rows fill the whole band", () => {
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, bottomRows: 30 }),
    );
    expect(window).toEqual({
      start: 10,
      end: 10,
      spacerAbove: 50,
      spacerBelow: 0,
      totalRows: 80,
    });
  });

  it("keeps the full height below when the band is past the top", () => {
    // An offset the caller has not clamped yet.
    const window = computeChatWindow(
      input({ heights: TEN_BY_FIVE, offset: 500 }),
    );
    expect(window).toEqual({
      start: 0,
      end: 0,
      spacerAbove: 0,
      spacerBelow: 50,
      totalRows: 50,
    });
  });

  it("keeps the spacers plus the drawn rows equal to the whole chat", () => {
    const heights = [3, 7, 1, 12, 4, 4, 9, 2, 6, 5, 8];
    const total = heights.reduce((a, b) => a + b, 0);
    for (let offset = 0; offset <= total; offset += 1) {
      const window = computeChatWindow(
        input({ heights, offset, viewportRows: 7, overscanRows: 3 }),
      );
      const drawn = heights
        .slice(window.start, window.end)
        .reduce((a, b) => a + b, 0);
      expect(window.spacerAbove + drawn + window.spacerBelow).toBe(total);
      expect(window.start).toBeLessThanOrEqual(window.end);
    }
  });

  it("draws every message that has a row inside the viewport, at any offset", () => {
    const heights = [3, 7, 1, 12, 4, 4, 9, 2, 6, 5, 8];
    const bottomRows = 2;
    const viewportRows = 7;
    const total = heights.reduce((a, b) => a + b, 0) + bottomRows;
    for (let offset = 0; offset <= total - viewportRows; offset += 1) {
      const window = computeChatWindow(
        input({ heights, bottomRows, offset, viewportRows }),
      );
      let fromBottom = bottomRows;
      for (let i = heights.length - 1; i >= 0; i -= 1) {
        const low = fromBottom;
        const high = fromBottom + heights[i]!;
        fromBottom = high;
        const visible = high > offset && low < offset + viewportRows;
        if (visible) {
          expect(i).toBeGreaterThanOrEqual(window.start);
          expect(i).toBeLessThan(window.end);
        }
      }
    }
  });

  it("treats negative, fractional and non-finite numbers as row counts", () => {
    const window = computeChatWindow(
      input({
        heights: [2.9, -4, Number.NaN, 3],
        bottomRows: -1,
        offset: Number.POSITIVE_INFINITY,
        viewportRows: 20.5,
        overscanRows: -3,
      }),
    );
    expect(window).toEqual({
      start: 0,
      end: 4,
      spacerAbove: 0,
      spacerBelow: 0,
      totalRows: 5,
    });
  });
});

describe("chatOverscanRows", () => {
  it("is one viewport of rows", () => {
    expect(chatOverscanRows(30)).toBe(30);
  });

  it("never drops below the floor on a short viewport", () => {
    expect(chatOverscanRows(3)).toBe(MIN_OVERSCAN_ROWS);
    expect(chatOverscanRows(Number.NaN)).toBe(MIN_OVERSCAN_ROWS);
  });
});

describe("widenChatWindow", () => {
  const heights = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const pinned = computeChatWindow(
    input({ heights, offset: 0, viewportRows: 10 }),
  );

  it("leaves the window alone when nothing needs a redraw", () => {
    expect(widenChatWindow(pinned, heights, [])).toBe(pinned);
    expect(widenChatWindow(pinned, heights, [pinned.start])).toBe(pinned);
  });

  it("reaches back to a stale message above and shrinks the spacer to match", () => {
    expect(pinned).toMatchObject({ start: 8, end: 10, spacerAbove: 40 });
    const widened = widenChatWindow(pinned, heights, [3]);
    expect(widened).toEqual({
      start: 3,
      end: 10,
      spacerAbove: 15,
      spacerBelow: 0,
      totalRows: pinned.totalRows,
    });
  });

  it("reaches forward to a stale message below", () => {
    const top = computeChatWindow(
      input({ heights, offset: 40, viewportRows: 10 }),
    );
    expect(top).toMatchObject({ start: 0, end: 2 });
    expect(widenChatWindow(top, heights, [6])).toMatchObject({
      start: 0,
      end: 7,
      spacerAbove: 0,
      spacerBelow: 15,
    });
  });

  it("ignores indices outside the history", () => {
    expect(widenChatWindow(pinned, heights, [-1, 10, 99])).toBe(pinned);
  });
});
