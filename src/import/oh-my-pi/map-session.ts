import type { SessionState } from "../../session/session-state.js";
import { mapPiFormatSession } from "../pi/map-session.js";
import type { PiSessionData } from "../pi/pi-session-format.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const OH_MY_PI_SESSION_ID_PREFIX = "oh-my-pi:";

/**
 * Map one Oh-My-Pi transcript into a native `SessionState`. The fork
 * kept Pi's session format, so the projection is the shared Pi mapper
 * with Oh-My-Pi's own id prefix and metadata stamp — which is what
 * keeps `reconcileImportedSession` from mistaking a Pi session and an
 * Oh-My-Pi session with the same source id for the same import.
 */
export function mapOhMyPiSession(
  session: PiSessionData,
  fallbackWorkingDir: string,
): SessionState {
  return mapPiFormatSession(session, fallbackWorkingDir, {
    idPrefix: OH_MY_PI_SESSION_ID_PREFIX,
    importedFrom: "oh-my-pi",
    sessionIdKey: "ohMyPiSessionId",
  });
}
