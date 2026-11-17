import { describe, it, expect } from "vitest";
import { enabledReaders, type ReaderSettings } from "./web-fetch-readers.js";

const SETTINGS: ReaderSettings = {
  jinaReader: false,
  jinaApiKeyEnv: "JINA_API_KEY",
  firecrawlApiKeyEnv: "FIRECRAWL_API_KEY",
};

describe("enabledReaders (ATO-968)", () => {
  it("is empty by default: no URL leaves the machine", () => {
    expect(enabledReaders(SETTINGS, {})).toEqual([]);
  });

  it("turns Jina on with the switch or with a key", () => {
    expect(enabledReaders({ ...SETTINGS, jinaReader: true }, {})).toEqual(["jina"]);
    expect(enabledReaders(SETTINGS, { JINA_API_KEY: "k" })).toEqual(["jina"]);
  });

  it("adds Firecrawl only with its key, after Jina", () => {
    expect(enabledReaders(SETTINGS, { FIRECRAWL_API_KEY: "k" })).toEqual(["firecrawl"]);
    expect(enabledReaders({ ...SETTINGS, jinaReader: true }, { FIRECRAWL_API_KEY: "k" }))
      .toEqual(["jina", "firecrawl"]);
  });

  it("ignores blank keys and reads the configured variable names", () => {
    expect(enabledReaders(SETTINGS, { JINA_API_KEY: "  ", FIRECRAWL_API_KEY: "" })).toEqual([]);
    expect(enabledReaders({ ...SETTINGS, jinaApiKeyEnv: "MY_JINA" }, { MY_JINA: "k" })).toEqual(["jina"]);
  });
});
