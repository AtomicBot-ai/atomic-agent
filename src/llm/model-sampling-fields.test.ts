import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  USER_CONFIG_DEFAULTS,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
} from "../config/index.js";
import { LlamaServerClient } from "./llama-server-client.js";
import { BUILT_IN_SAMPLING, resolveSamplingFields } from "./model-sampling-fields.js";

const QWEN_SAMPLING = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0,
  repeatPenalty: 1.0,
};

function capturingClient(
  bodies: Array<Record<string, unknown>>,
  modelSampling?: boolean,
): LlamaServerClient {
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: "x", stop: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new LlamaServerClient({
    baseUrl: "http://127.0.0.1:9999",
    fetchImpl,
    ...(modelSampling !== undefined ? { modelSampling } : {}),
  });
}

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

describe("resolveSamplingFields (ATO-2202)", () => {
  it("keeps the built-in defaults when the model's sampling is off", () => {
    expect(
      resolveSamplingFields({ modelSampling: QWEN_SAMPLING }, {}, false),
    ).toEqual({
      temperature: 0.2,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      repeat_last_n: 256,
    });
    expect(BUILT_IN_SAMPLING.temperature).toBe(0.2);
  });

  it("uses the model's values over the built-ins when on, min_p included", () => {
    expect(
      resolveSamplingFields({ modelSampling: QWEN_SAMPLING }, {}, true),
    ).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      repeat_penalty: 1.0,
      repeat_last_n: 256,
    });
  });

  it("lets the request and then the env win over the model", () => {
    const fields = resolveSamplingFields(
      { temperature: 0, repeatPenalty: 1.2, modelSampling: QWEN_SAMPLING },
      { topK: 1, temperature: 0.9 },
      true,
    );
    expect(fields.temperature).toBe(0);
    expect(fields.top_k).toBe(1);
    expect(fields.repeat_penalty).toBe(1.2);
    expect(fields.top_p).toBe(0.95);
  });

  it("fills only what the model names", () => {
    const fields = resolveSamplingFields({ modelSampling: { temperature: 1 } }, {}, true);
    expect(fields).toEqual({
      temperature: 1,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      repeat_last_n: 256,
    });
    expect(fields).not.toHaveProperty("min_p");
  });
});

describe("LlamaServerClient with localModels.modelSampling (ATO-2202)", () => {
  it("sends the model's sampling when the client flag is on", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies, true).complete({ prompt: "p", modelSampling: QWEN_SAMPLING });
    expect(bodies[0]).toMatchObject({ temperature: 0.6, top_k: 20, min_p: 0, repeat_penalty: 1.0 });
  });

  it("reads the flag from the config when the client has no override", async () => {
    getConfig().localModels.modelSampling = true;
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).complete({ prompt: "p", modelSampling: QWEN_SAMPLING });
    expect(bodies[0]?.temperature).toBe(0.6);
    expect(bodies[0]?.top_k).toBe(20);
  });

  it("keeps the request's explicit temperature over the model's", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies, true).complete({
      prompt: "p",
      temperature: 0,
      modelSampling: QWEN_SAMPLING,
    });
    expect(bodies[0]?.temperature).toBe(0);
    expect(bodies[0]?.top_k).toBe(20);
  });

  it("sends the built-in sampling when the flag is off or absent", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).complete({ prompt: "p", modelSampling: QWEN_SAMPLING });
    getConfig().localModels.modelSampling = true;
    await capturingClient(bodies, false).complete({ prompt: "p", modelSampling: QWEN_SAMPLING });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ temperature: 0.2, top_p: 0.95, top_k: 40, repeat_penalty: 1.1 });
      expect(body).not.toHaveProperty("min_p");
      expect(body).not.toHaveProperty("modelSampling");
    }
  });
});

describe("localModels.modelSampling config", () => {
  it("defaults to off, also for a file written before the field existed", () => {
    expect(USER_CONFIG_DEFAULTS.localModels.modelSampling).toBe(false);
    expect(parseUserConfigFile({}).localModels.modelSampling).toBe(false);
    expect(
      parseUserConfigFile({ version: 77, localModels: { thinking: "on" } }).localModels.modelSampling,
    ).toBe(false);
  });

  it("accepts a boolean and rejects anything else", () => {
    expect(parseUserConfigFile({ localModels: { modelSampling: true } }).localModels.modelSampling).toBe(true);
    expect(() => parseUserConfigFile({ localModels: { modelSampling: 3 } })).toThrow(/localModels\.modelSampling/);
  });
});

describe("resolveSamplingFields user layer (ATO-2482)", () => {
  it("applies the person's set even when the model's sampling is off", () => {
    expect(
      resolveSamplingFields({ modelSampling: QWEN_SAMPLING, userSampling: { temperature: 0.5 } }, {}, false),
    ).toMatchObject({ temperature: 0.5, top_p: 0.95, top_k: 40 });
  });

  it("puts the person's set over the model's, under the request and the env", () => {
    const fields = resolveSamplingFields(
      { modelSampling: QWEN_SAMPLING, userSampling: { temperature: 0.5, topK: 30, presencePenalty: 1.5 } },
      { topK: 7 },
      true,
    );
    expect(fields).toMatchObject({ temperature: 0.5, top_k: 7, min_p: 0, presence_penalty: 1.5 });
    expect(
      resolveSamplingFields({ temperature: 0, userSampling: { temperature: 0.5 } }, {}, true).temperature,
    ).toBe(0);
  });

  it("sends no presence_penalty when no set names one", () => {
    expect(resolveSamplingFields({ modelSampling: QWEN_SAMPLING }, {}, true)).not.toHaveProperty(
      "presence_penalty",
    );
  });
});
