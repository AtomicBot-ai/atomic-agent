import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordApi } from "./discord-api.js";

const TOKEN = ["A".repeat(24), "GaBcDe", "z".repeat(30)].join(".");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiscordApi.sendFile", () => {
  it("uploads the file as multipart with payload_json and files[0], no JSON content-type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-discord-api-"));
    writeFileSync(join(dir, "report.pdf"), "pdf-bytes");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "m9" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = new DiscordApi({ token: TOKEN });
    const id = await api.sendFile("c1", {
      path: join(dir, "report.pdf"),
      filename: "report.pdf",
    });

    expect(id).toBe("m9");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bot ${TOKEN}`);
    // fetch must set the multipart boundary itself.
    expect(headers["Content-Type"]).toBeUndefined();
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(body.get("payload_json") as string)).toEqual({
      attachments: [{ id: 0, filename: "report.pdf" }],
    });
    const file = body.get("files[0]") as File;
    expect(file.name).toBe("report.pdf");
    expect(await file.text()).toBe("pdf-bytes");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still sends JSON bodies with the JSON content-type", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "m1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new DiscordApi({ token: TOKEN });
    await api.sendMessage("c1", "hello");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(init.body).toBe(JSON.stringify({ content: "hello" }));
  });
});
