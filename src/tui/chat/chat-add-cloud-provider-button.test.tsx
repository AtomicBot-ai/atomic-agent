import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import {
  addCloudProviderActions,
  ChatAddCloudProviderButton,
} from "./chat-add-cloud-provider-button.js";

describe("the add-cloud-provider button", () => {
  it("lands on the Cloud pane with the add-provider wizard open", () => {
    const actions = addCloudProviderActions();
    expect(actions.map((a) => a.type)).toEqual([
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
      "providers_wizard_opened",
    ]);
    expect(actions[1]).toMatchObject({ tab: "llm" });
    expect(actions[2]).toMatchObject({ mode: "cloud" });
    expect(actions[3]).toMatchObject({ wizard: { mode: "add" } });
  });

  it("hands every click a fresh wizard", () => {
    const [, , , first] = addCloudProviderActions();
    const [, , , second] = addCloudProviderActions();
    expect(first).not.toBe(second);
  });

  it("still renders the label without a mouse provider", () => {
    const { lastFrame, unmount } = render(<ChatAddCloudProviderButton />);
    expect(lastFrame()).toContain("[add cloud provider]");
    unmount();
  });
});
