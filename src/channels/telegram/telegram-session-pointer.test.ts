import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TelegramSessionPointer } from "./telegram-session-pointer.js";

describe("TelegramSessionPointer", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-pointer-"));
    path = join(dir, "telegram-session.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns { current: null } when the file does not exist", () => {
    const ptr = new TelegramSessionPointer(path);
    expect(ptr.read()).toEqual({ current: null });
  });

  it("setCurrent persists and survives a fresh read", () => {
    const ptr = new TelegramSessionPointer(path);
    ptr.setCurrent("s-1");
    expect(ptr.read()).toEqual({ current: "s-1" });
    expect(new TelegramSessionPointer(path).read()).toEqual({
      current: "s-1",
    });
  });

  it("rotate moves current into history and clears current", () => {
    const ptr = new TelegramSessionPointer(path);
    ptr.setCurrent("s-1");
    ptr.rotate();
    expect(ptr.read()).toEqual({ current: null, history: ["s-1"] });
  });

  it("rotate is idempotent when current is already null", () => {
    const ptr = new TelegramSessionPointer(path);
    ptr.rotate();
    expect(ptr.read()).toEqual({ current: null });
  });

  it("history is capped to the most recent 16 rotated ids (newest first)", () => {
    const ptr = new TelegramSessionPointer(path);
    for (let i = 1; i <= 20; i += 1) {
      ptr.setCurrent(`s-${i}`);
      ptr.rotate();
    }
    const data = ptr.read();
    expect(data.current).toBeNull();
    expect(data.history).toBeDefined();
    expect(data.history!.length).toBe(16);
    expect(data.history![0]).toBe("s-20");
    expect(data.history![15]).toBe("s-5");
  });

  it("corrupt file resets to { current: null } on read", () => {
    writeFileSync(path, "not-json", "utf8");
    expect(new TelegramSessionPointer(path).read()).toEqual({
      current: null,
    });
  });

  it("non-object JSON resets to { current: null } on read", () => {
    writeFileSync(path, "[1, 2, 3]", "utf8");
    expect(new TelegramSessionPointer(path).read()).toEqual({
      current: null,
    });
  });

  it("setCurrent after rotate preserves history", () => {
    const ptr = new TelegramSessionPointer(path);
    ptr.setCurrent("s-1");
    ptr.rotate();
    ptr.setCurrent("s-2");
    expect(ptr.read()).toEqual({ current: "s-2", history: ["s-1"] });
  });
});
