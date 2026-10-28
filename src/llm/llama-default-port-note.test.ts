import { describe, expect, it } from "vitest";
import { llamaDefaultPortNote, llamaLegacyPortNote } from "./llama-default-port-note.js";

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

describe("llamaLegacyPortNote (ATO-708)", () => {
  it("points a loopback 8080 address at 9931", () => {
    for (const url of ["http://127.0.0.1:8080", "http://localhost:8080/v1/chat/completions"]) {
      const note = llamaLegacyPortNote(url);
      expect(note).toContain("8080");
      expect(note).toContain("9931");
      expect(note).not.toContain("\u2014");
    }
  });

  it("stays quiet for 9931, another port, or another host", () => {
    expect(llamaLegacyPortNote("http://127.0.0.1:9931")).toBeNull();
    expect(llamaLegacyPortNote("http://127.0.0.1:1234")).toBeNull();
    expect(llamaLegacyPortNote("http://192.168.1.5:8080")).toBeNull();
    expect(llamaLegacyPortNote("not a url")).toBeNull();
  });
});
