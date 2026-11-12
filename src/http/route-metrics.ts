import { getAppVersion } from "../version.js";
import {
  formatPrometheus,
  PROMETHEUS_CONTENT_TYPE,
  type PrometheusFamily,
} from "../tracing/prometheus-format.js";
import type { PrometheusRegistry } from "../tracing/prometheus-registry.js";
import type { HandlerContext, HttpHandler } from "./request-context.js";

/**
 * `GET /metrics` — the agent's health in the Prometheus text format
 * (ATO-646), for whoever runs `atag serve` on a server and scrapes it
 * from Prometheus or Grafana Agent.
 *
 * Two sources:
 * - what the runtime has counted since boot (turns, steps, provider
 *   failures, tool calls, tasks, scheduler ticks), folded by the
 *   `PrometheusRegistry` that serve installs as a metric sink;
 * - readings taken at scrape time: turns running now, tasks per status
 *   in the durable queue, the version and process uptime.
 *
 * Behind the same bearer auth as every `/api` route (the table's
 * default): with `--api-key` set a scrape must send it, which
 * Prometheus does through `authorization: { credentials: … }`. Serve
 * refuses to listen beyond loopback without a key, so the only
 * keyless `/metrics` is a loopback one, as for the rest of the API.
 * No label carries a session id, a path or message text.
 */
export function createMetricsHandler(registry?: PrometheusRegistry): HttpHandler {
  return (_req, res, ctx) => {
    const families = [...liveFamilies(ctx), ...(registry?.families() ?? [])];
    res.writeHead(200, {
      "content-type": PROMETHEUS_CONTENT_TYPE,
      "cache-control": "no-store",
    });
    res.end(formatPrometheus(families));
  };
}

function liveFamilies(ctx: HandlerContext): PrometheusFamily[] {
  const families: PrometheusFamily[] = [
    {
      name: "atomic_agent_info",
      help: "Always 1; the version label names the running build.",
      type: "gauge",
      series: [{ labels: { version: getAppVersion() }, value: 1 }],
    },
    {
      name: "atomic_agent_uptime_seconds",
      help: "Seconds since this serve process started.",
      type: "gauge",
      series: [{ labels: {}, value: Math.round(process.uptime()) }],
    },
    {
      name: "atomic_agent_turns_running",
      help: "Sessions with a turn running right now.",
      type: "gauge",
      series: [{ labels: {}, value: ctx.runtime.turnController.busySessionIds().length }],
    },
  ];
  const tasks = readTaskCounts(ctx);
  if (tasks) {
    families.push({
      name: "atomic_agent_tasks",
      help: "Durable tasks in the queue, by status.",
      type: "gauge",
      series: TASK_STATUSES.map((status) => ({ labels: { status }, value: tasks[status] ?? 0 })),
    });
  }
  return families;
}

const TASK_STATUSES = ["pending", "running", "completed", "failed", "blocked", "cancelled"] as const;

/** A store that is shutting down answers nothing rather than failing the scrape. */
function readTaskCounts(ctx: HandlerContext): Partial<Record<string, number>> | null {
  try {
    return ctx.runtime.taskStore.countByStatus();
  } catch {
    return null;
  }
}
