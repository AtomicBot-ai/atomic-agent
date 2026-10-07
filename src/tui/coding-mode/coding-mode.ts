// Compatibility entry point for existing TUI consumers; shared policy is domain-owned.
export {
  CODING_MODES,
  codingModeLook,
  cycleCodingMode,
  resolveCodingMode,
} from "../../approval/coding-mode.js";
export type {
  CodingMode,
  CodingModeLook,
  ResolvedCodingMode,
} from "../../approval/coding-mode.js";
