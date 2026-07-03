/**
 * Request/response payload shapes for the `provider.*` and `models.status`
 * commands. See [SIDECAR.md](../../../SIDECAR.md) §4.8.
 */

import type {
  ModelsStatus,
  ProviderSummary,
} from "../../runtime-api/index.js";

export interface ProviderListPayload {
  [key: string]: never;
}
export interface ProviderListResult {
  providers: ProviderSummary[];
  activeTextId: string;
}

export interface ProviderSetActivePayload {
  id: string;
}
export interface ProviderSetActiveResult {
  activeTextId: string;
}

export interface ProviderReloadPayload {
  id?: string;
}
export interface ProviderReloadResult {
  ok: true;
}

export interface ProviderRemovePayload {
  id: string;
}
export interface ProviderRemoveResult {
  ok: true;
}

export interface ModelsStatusPayload {
  [key: string]: never;
}
export interface ModelsStatusResult {
  status: ModelsStatus;
}
