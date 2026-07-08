import type { RequestType, SidecarEvent, SidecarResponse } from "@agent/sidecar/index.js";

export interface AgentStatus {
  running: boolean;
  error: string | null;
}

export interface AgentBridge {
  request: (type: RequestType, payload: unknown) => Promise<SidecarResponse>;
  getStatus: () => Promise<AgentStatus>;
  onEvent: (callback: (event: SidecarEvent) => void) => () => void;
  onStatusChange: (callback: (status: AgentStatus) => void) => () => void;
}
