import { describe, expect, it } from "vitest";
import { remoteMediaProblem } from "./raw-model-body-guard.js";

const body = (content: unknown) => Buffer.from(JSON.stringify({ messages: [{ role: "user", content }] }));

describe("remoteMediaProblem", () => {
  it("passes text, inline data: media and base64 audio", () => {
    expect(remoteMediaProblem(body("hello"))).toBeNull();
    expect(remoteMediaProblem(body([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]))).toBeNull();
    expect(remoteMediaProblem(body([{ type: "image_url", image_url: { url: " DATA:image/jpeg;base64,AA" } }]))).toBeNull();
    expect(remoteMediaProblem(body([{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }]))).toBeNull();
  });

  it("refuses an http(s), file or other non-data URL in any media part", () => {
    for (const part of [
      { type: "image_url", image_url: { url: "http://127.0.0.1:19091/slots" } },
      { type: "image_url", image_url: "https://example.com/a.png" },
      { type: "image_url", image_url: { url: "file:///etc/passwd" } },
      { type: "input_audio", input_audio: { url: "http://10.0.0.5/a.wav" } },
      { type: "input_audio", input_audio: "http://10.0.0.5/a.wav" },
      { type: "file", file: { file_url: "http://nas.local/doc.pdf" } },
    ]) {
      expect(remoteMediaProblem(body([part]))).toMatch(/data: URL/);
    }
  });

  it("leaves bodies it cannot read to the engine", () => {
    expect(remoteMediaProblem(undefined)).toBeNull();
    expect(remoteMediaProblem(Buffer.from("not json"))).toBeNull();
    expect(remoteMediaProblem(Buffer.from(JSON.stringify({ prompt: "x" })))).toBeNull();
  });
});
