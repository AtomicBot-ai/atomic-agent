import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { IntegrationsPanel } from "./integrations-panel.js";
import {
  createInitialIntegrationsPanelState,
  type IntegrationRow,
  type IntegrationsPanelState,
} from "../integrations-panel-state.js";

const COMPOSIO: IntegrationRow = {
  id: "composio",
  label: "Composio",
  summary: "~1500 SaaS toolkits",
  level: "not_configured",
  detail: "no key — Composio tools are not loaded",
  docsUrl: "https://composio.dev",
  appliesLive: true,
  actions: [],
  fields: [
    {
      key: "apiKey",
      label: "API key",
      kind: "text",
      display: "—",
      present: false,
      help: "Free tier: 100K tool calls/month.",
    },
  ],
};

function flat(frame: string | undefined): string {
  return (frame ?? "").replace(/\s+/g, " ");
}

function panelOf(
  overrides: Partial<IntegrationsPanelState> = {},
): IntegrationsPanelState {
  return {
    ...createInitialIntegrationsPanelState(),
    rows: [COMPOSIO],
    ...overrides,
  };
}

describe("IntegrationsPanel", () => {
  it("lists an integration with its status and summary", () => {
    const { lastFrame } = render(<IntegrationsPanel panel={panelOf()} />);
    const out = flat(lastFrame());
    expect(out).toContain("Integrations");
    expect(out).toContain("Composio");
    expect(out).toContain("~1500 SaaS toolkits");
    expect(out).toContain("not loaded");
    expect(out).toContain("0/1 configured");
  });

  it("shows a helpful hint when nothing is registered", () => {
    const { lastFrame } = render(
      <IntegrationsPanel panel={panelOf({ rows: [] })} />,
    );
    expect(flat(lastFrame())).toContain("no integrations available");
  });

  it("shows the masked value and help text in detail mode", () => {
    const row: IntegrationRow = {
      ...COMPOSIO,
      level: "connected",
      detail: "connected",
      fields: [{ ...COMPOSIO.fields[0]!, display: "••••••", present: true }],
    };
    const { lastFrame } = render(
      <IntegrationsPanel panel={panelOf({ rows: [row], mode: "detail" })} />,
    );
    const out = flat(lastFrame());
    expect(out).toContain("API key");
    expect(out).toContain("••••••");
    expect(out).toContain("connected");
    expect(out).toContain("Free tier");
    expect(out).toContain("e edit");
  });

  it("renders the live edit buffer, not the stored value", () => {
    const { lastFrame } = render(
      <IntegrationsPanel
        panel={panelOf({ mode: "edit", editBuffer: "ak_typed" })}
      />,
    );
    const out = flat(lastFrame());
    expect(out).toContain("ak_typed");
    expect(out).toContain("enter save");
  });

  it("walks the operator through setup while the integration is not connected", () => {
    // A field labelled "Bot token" is self-explanatory only to someone
    // who has already made a bot. The steps are the difference between
    // a hub and a form.
    const row: IntegrationRow = {
      ...COMPOSIO,
      setupSteps: ["Sign up at composio.dev", "Paste the key below"],
    };
    const { lastFrame } = render(
      <IntegrationsPanel panel={panelOf({ rows: [row], mode: "detail" })} />,
    );
    const out = flat(lastFrame());
    expect(out).toContain("Setup");
    expect(out).toContain("1. Sign up at composio.dev");
    expect(out).toContain("2. Paste the key below");
  });

  it("points an untouched row at its walkthrough", () => {
    const { lastFrame } = render(<IntegrationsPanel panel={panelOf()} />);
    expect(flat(lastFrame())).toContain("press enter for step-by-step setup");
  });

  it("drops the nudge once the integration is configured", () => {
    const row: IntegrationRow = { ...COMPOSIO, level: "connected" };
    const { lastFrame } = render(
      <IntegrationsPanel panel={panelOf({ rows: [row] })} />,
    );
    expect(flat(lastFrame())).not.toContain("step-by-step setup");
  });

  it("surfaces an error line", () => {
    const { lastFrame } = render(
      <IntegrationsPanel panel={panelOf({ lastError: "key rejected" })} />,
    );
    expect(flat(lastFrame())).toContain("key rejected");
  });
});
