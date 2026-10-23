import { describe, expect, it } from "vitest";
import { llamaDefaultPortNote } from "./llama-default-port-note.js";

describe("llamaDefaultPortNote", () => {
  it("names both default ports for a loopback URL on either of them", () => {
    for (const url of [
      "http://127.0.0.1:9931",
      "http://127.0.0.1:8080",
      "http://localhost:8080/",
      "http://[::1]:9931",
    ]) {
      const note = llamaDefaultPortNote(url);
      expect(note).toContain("9931");
      expect(note).toContain("8080");
      expect(note).not.toContain("—");
    }
  });

  it("stays quiet for a port or host the operator typed on purpose", () => {
    expect(llamaDefaultPortNote("http://127.0.0.1:19091")).toBeNull();
    expect(llamaDefaultPortNote("http://127.0.0.1:1234")).toBeNull();
    expect(llamaDefaultPortNote("http://192.168.1.5:8080")).toBeNull();
    expect(llamaDefaultPortNote("not a url")).toBeNull();
  });
});
