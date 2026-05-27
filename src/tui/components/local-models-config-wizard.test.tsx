import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { LocalModelsConfigWizard } from "./local-models-config-wizard.js";

vi.mock("../../llm/llama-server-health.js", () => ({
  checkLlamaServer: vi.fn(async () => ({
    reachable: true,
    status: 200,
    error: null,
    latencyMs: 1,
  })),
}));

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("LocalModelsConfigWizard", () => {
  it("renders onboarding choices in local, cloud, remote llama.cpp order", () => {
    const { lastFrame } = render(
      <LocalModelsConfigWizard
        initialUrl="http://127.0.0.1:8080"
        probeError={null}
        onFinished={() => {}}
      />,
    );

    const text = stripAnsi(lastFrame() ?? "");
    const local = "[1] Local models (llama.cpp)";
    const cloud = "[2] Cloud models";
    const remote = "[3] Remote llama.cpp";

    expect(text).toContain(local);
    expect(text).toContain(cloud);
    expect(text).toContain(remote);
    expect(text.indexOf(local)).toBeLessThan(text.indexOf(cloud));
    expect(text.indexOf(cloud)).toBeLessThan(text.indexOf(remote));
  });

  it("opens the remote llama.cpp flow on chat URL first", async () => {
    const { lastFrame, stdin } = render(
      <LocalModelsConfigWizard
        initialUrl="http://127.0.0.1:8080"
        probeError={null}
        onFinished={() => {}}
      />,
    );

    stdin.write("3");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Set the HTTP base URL of your chat llama-server");
    expect(text).toContain("Enter: test & continue to embedding URL");
  });

  it("shows the remote embedding URL step as optional", async () => {
    const { lastFrame, stdin } = render(
      <LocalModelsConfigWizard
        initialUrl="http://127.0.0.1:8080"
        probeError={null}
        onFinished={() => {}}
      />,
    );

    stdin.write("3");
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Set the HTTP base URL of your embedding-only llama-server");
    expect(text).toContain("Optional: leave empty");
    expect(text).toContain("empty Enter skips embeddings");
  });
});
