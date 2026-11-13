import { OAuthFlowError } from "./oauth-errors.js";
import type { Sleep } from "./oauth-types.js";

/** Default abortable delay; rejects with `cancelled` when the signal fires. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OAuthFlowError("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new OAuthFlowError("cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
