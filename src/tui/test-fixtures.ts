import { reduceTuiState } from "./agent-event-reducer.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiSessionInfo, TuiState } from "./tui-state.js";

export function fakeSession(
  overrides: Partial<TuiSessionInfo> = {},
): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured: false,
    ...overrides,
  };
}

export function apply(state: TuiState, actions: TuiAction[]): TuiState {
  return actions.reduce(reduceTuiState, state);
}
