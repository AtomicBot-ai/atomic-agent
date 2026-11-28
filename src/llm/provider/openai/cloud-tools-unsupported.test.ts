import { describe, expect, it } from "vitest";

import { isCloudToolsUnsupported } from "./cloud-tools-unsupported.js";
import { humanizeOpenAiHttpError, OpenAiHttpError } from "./openai-http.js";
import { parseProviderErrorBody } from "./parse-provider-error-body.js";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

function refusal(status: number, raw: string, url = OPENROUTER, label = "openrouter"): OpenAiHttpError {
  return new OpenAiHttpError(`openai provider ${status}: ${raw}`, status, url, false, null, label, undefined, {
    body: parseProviderErrorBody(raw),
  });
}

describe("a cloud model without tools (ATO-1673)", () => {
  it("says the model can't use tools, not that its id is wrong", () => {
    const said = humanizeOpenAiHttpError(
      refusal(404, '{"error":{"message":"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing","code":404}}'),
    );
    expect(said).toBe(
      '"openrouter" says this model can\'t use tools (404), and the agent needs them to work. Pick a model that supports tool calling.',
    );
    expect(said).not.toContain("model id or the base URL");
  });

  it("reads a 400 in the vendor's words the same way", () => {
    const said = humanizeOpenAiHttpError(
      refusal(400, '{"error":{"message":"This model does not support tools."}}', "https://api.deepseek.com/chat/completions", "deepseek"),
    );
    expect(said).toContain("can't use tools (400)");
    expect(said).not.toContain("rejected the request");
  });

  it("leaves a server on this machine to its own sentence", () => {
    expect(isCloudToolsUnsupported(400, "http://127.0.0.1:11434/v1/chat/completions", "llama3 does not support tools")).toBe(false);
    expect(isCloudToolsUnsupported(400, OPENROUTER, "tool_choice is not supported")).toBe(false);
    expect(isCloudToolsUnsupported(500, OPENROUTER, "does not support tools")).toBe(false);
  });
});

describe("a gateway's empty balance (ATO-1673)", () => {
  it("reads new-api's 403 insufficient_user_quota as no credit, not a refused key", () => {
    const said = humanizeOpenAiHttpError(
      refusal(
        403,
        '{"error":{"code":"insufficient_user_quota","message":"user quota is not enough","type":"new_api_error"}}',
        "https://api.example-gateway.com/v1/chat/completions",
        "my-gateway",
      ),
    );
    expect(said).not.toContain("did not accept your API key");
    expect(said).toContain("Top up your balance");
  });
});
