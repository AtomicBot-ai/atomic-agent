import { describe, expect, it } from "vitest";

import {
  IMSG_AUTOMATION_HINT,
  IMSG_DISK_ACCESS_HINT,
  IMSG_INSTALL_HINT,
  classifyImsgFailure,
  scrubImessageError,
} from "./imsg-errors.js";

function enoent(): NodeJS.ErrnoException {
  const err = new Error("spawn imsg ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

describe("classifyImsgFailure", () => {
  it("tells the operator to install imsg when the binary is missing", () => {
    expect(classifyImsgFailure(enoent())).toEqual({ kind: "missing", message: IMSG_INSTALL_HINT });
  });

  it("points at Full Disk Access when chat.db cannot be opened", () => {
    const f = classifyImsgFailure(new Error("exit 1"), "Error: unable to open database file");
    expect(f).toEqual({ kind: "disk-access", message: IMSG_DISK_ACCESS_HINT });
  });

  it("points at Automation when Messages refuses Apple events", () => {
    expect(classifyImsgFailure(null, "execution error: Not authorized to send Apple events to Messages. (-1743)").kind).toBe(
      "automation",
    );
    expect(classifyImsgFailure(null, "osascript: (-1743)").message).toBe(IMSG_AUTOMATION_HINT);
  });

  it("falls back to the first stderr line, scrubbed", () => {
    const f = classifyImsgFailure(new Error("Command failed"), "\nsend failed for +1 415 555 1212\nmore");
    expect(f.kind).toBe("other");
    expect(f.message).toBe("imsg failed: send failed for <phone>");
  });
});

describe("scrubImessageError", () => {
  it("removes phone numbers, e-mails and secret-shaped strings", () => {
    expect(scrubImessageError("to owner@icloud.com and +14155551212")).toBe("to <email> and <phone>");
    expect(scrubImessageError(new Error("key " + "a".repeat(40)))).toBe("key <redacted>");
  });
});
