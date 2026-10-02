import type { ChatMessageVariant } from "../tui-state.js";
import type { SupervisorNotice } from "./daemon-supervisor.js";

/**
 * The chat half of a supervisor incident.
 *
 * The feed already carries a line per attempt, but the feed sits in a
 * tab nobody watches while they chat and is wiped at every turn start,
 * so a dead or wedged daemon read from the chat as an agent that went
 * silent for a minute or two with a spinner. Each notice says what
 * happened, what is being done about it and, when the answer is the
 * operator's, what to do.
 */
export function formatDaemonNotice(notice: SupervisorNotice): {
  text: string;
  variant: ChatMessageVariant;
} {
  switch (notice.kind) {
    case "restarting": {
      const what =
        notice.cause === "died"
          ? notice.quickDeaths > 0
            ? "The local model server crashed again soon after its restart"
            : "The local model server crashed"
          : `The local model server hung — ${notice.reason}`;
      return {
        variant: "warn",
        text: `${what}. Restarting it automatically; a reply in progress is paused and continues once the server is back.`,
      };
    }
    case "restarted":
      return {
        variant: "normal",
        text: `The local model server is back up (restarted in ${Math.max(
          1,
          Math.round(notice.afterMs / 1000),
        )} s). A paused reply continues by itself.`,
      };
    case "restart_failed":
      return {
        variant: "warn",
        text: `The local model server did not come back up${
          notice.fault ? `: ${notice.fault}` : ""
        }. Trying again — the LLM pane's logs show why it fails.`,
      };
    case "gave_up":
      return {
        variant: "warn",
        text: [
          `The local model server crashed ${notice.deaths} times within a minute of starting, so automatic restarts are stopped${
            notice.fault ? `: ${notice.fault}` : ""
          }.`,
          "The agent cannot answer on the local model until the server runs again. Fix the cause (a smaller model or context size if it ran out of memory), then /llm restart.",
        ].join("\n"),
      };
  }
}
