import { describe, expect, it, vi } from "vitest";
import { LlamaServerError } from "../../llama-server-client.js";
import {
  ServerTemplateRenderer,
  TAIL_SENTINEL,
} from "./server-template-renderer.js";

/** A Llama-3-shaped template, as `/apply-template` would render it. */
function llama3Template(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string {
  return (
    messages
      .map(
        (m) =>
          `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`,
      )
      .join("") + "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

const parts = {
  system: "### system\nYou are atomic-agent.",
  user: "### conversation\nuser: hi\n### respond\nRespond now.\n",
  prefixHash: "h1",
};

describe("ServerTemplateRenderer", () => {
  it("renders the prefix once per hash and splices each step's tail into it", async () => {
    const applyTemplate = vi.fn(async (messages) => llama3Template(messages));
    const renderer = new ServerTemplateRenderer({ applyTemplate });
    const first = await renderer.render(parts, "plain-instruct/llama-3");
    const second = await renderer.render(
      { ...parts, user: "### conversation\nuser: hi\nassistant: hello\n" },
      "plain-instruct/llama-3",
    );
    expect(first).toBe(
      "<|start_header_id|>system<|end_header_id|>\n\n### system\nYou are atomic-agent.<|eot_id|>" +
        "<|start_header_id|>user<|end_header_id|>\n\n" +
        parts.user +
        "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n",
    );
    // Same head byte for byte; only the tail moved.
    const head = first!.slice(0, first!.indexOf(parts.user));
    expect(second!.startsWith(head)).toBe(true);
    expect(second).toContain("assistant: hello");
    expect(applyTemplate).toHaveBeenCalledTimes(1);
    expect(applyTemplate.mock.calls[0]![0]).toEqual([
      { role: "system", content: parts.system },
      { role: "user", content: TAIL_SENTINEL },
    ]);
    expect(applyTemplate.mock.calls[0]![1]).toBeUndefined();
  });

  it("re-renders for another prefix, model or thinking setting, and passes the switch through", async () => {
    const applyTemplate = vi.fn(async (messages) => llama3Template(messages));
    const renderer = new ServerTemplateRenderer({ applyTemplate });
    await renderer.render(parts, "m1");
    await renderer.render({ ...parts, prefixHash: "h2" }, "m1");
    await renderer.render(parts, "m2");
    await renderer.render({ ...parts, enableThinking: false }, "m1");
    await renderer.render(parts, "m1");
    expect(applyTemplate).toHaveBeenCalledTimes(4);
    expect(applyTemplate.mock.calls[3]![1]).toEqual({ enable_thinking: false });
  });

  it("falls back to the raw prompt when the template loses or duplicates the sentinel", async () => {
    const drops = new ServerTemplateRenderer({
      applyTemplate: async () => "<s>[INST] nothing of yours [/INST]",
    });
    expect(await drops.render(parts, "m")).toBeNull();
    const doubles = new ServerTemplateRenderer({
      applyTemplate: async () => `${TAIL_SENTINEL} ${TAIL_SENTINEL}`,
    });
    expect(await doubles.render(parts, "m")).toBeNull();
  });

  it("gives up on the endpoint after a 404, and retries other failures next step", async () => {
    const missing = vi.fn(async () => {
      throw new LlamaServerError("not found", 404, "http://x/apply-template");
    });
    const renderer = new ServerTemplateRenderer({ applyTemplate: missing });
    expect(await renderer.render(parts, "m")).toBeNull();
    expect(await renderer.render(parts, "m")).toBeNull();
    expect(missing).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = new ServerTemplateRenderer({
      applyTemplate: async (messages) => {
        calls += 1;
        if (calls === 1) throw new LlamaServerError("reset", null, "u");
        return llama3Template(messages);
      },
    });
    expect(await flaky.render(parts, "m")).toBeNull();
    expect(await flaky.render(parts, "m")).not.toBeNull();
  });
});
