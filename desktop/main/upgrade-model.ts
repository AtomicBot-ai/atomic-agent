/**
 * ATO-1044 — after the starter model, the best model for this computer.
 *
 * The first chat answers on the 1.3 GB starter model (ATO-1041/1042). Once
 * it is in place the app asks the agent which model this machine can really
 * carry (`atag models recommend --json`, ATO-1043) and asks first:
 * "Download (15.1 GB)" / "Not now" (ATO-1475: never a multi-GB download
 * nobody asked for; Not now is remembered across launches). After the click
 * the chat shows "Getting the best model for this computer, 42%",
 * and when the weights are on disk it asks: Switch now / Later. Nadya's
 * ATO-1044 note: the switch is asked, not silent. The switch itself goes
 * through the usual local-model pick and, for this move only, the running
 * agent takes it live (POST /api/llm/active, #843) instead of a restart.
 *
 * Pure: the caller hands in what the agent reports.
 */

/** What `atag models recommend --json` says about the upgrade (fields the app reads). */
export interface UpgradeModel {
  id: string;
  name: string;
  sizeLabel: string;
  downloadGb: number;
}

export interface RecommendAnswer {
  action: "download" | "switch" | "none";
  why: string | null;
  model: UpgradeModel | null;
}

/**
 * The `upgrade` half of `models recommend --json`, or null when the agent
 * does not have the subcommand (an agent from before ATO-1043) or printed
 * something else.
 */
export function parseRecommendJson(stdout: string): RecommendAnswer | null {
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  const up = (body as { upgrade?: unknown } | null)?.upgrade as Record<string, unknown> | undefined;
  if (!up || typeof up !== "object") return null;
  const action = up.action;
  if (action !== "download" && action !== "switch" && action !== "none") return null;
  const m = up.model as Record<string, unknown> | null | undefined;
  const model: UpgradeModel | null =
    m && typeof m.id === "string"
      ? {
          id: m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          sizeLabel: typeof m.sizeLabel === "string" ? m.sizeLabel : "",
          downloadGb: typeof m.downloadGb === "number" ? m.downloadGb : 0,
        }
      : null;
  if (action !== "none" && !model) return null;
  return { action, why: typeof up.why === "string" ? up.why : null, model };
}

export interface UpgradeInputs {
  recommend: RecommendAnswer | null;
  /** A cloud provider with a usable key is configured. */
  cloudReady: boolean;
  /** `localModels.mode`: an external server is the person's own choice. */
  localMode: string | null;
  /** `llm.activeTextProvider`. */
  activeProvider: string | null;
  /** A download is running already (the starter, or one the person started). */
  downloadBusy: boolean;
  /** The person said Later to this model in this run of the app. */
  laterId: string | null;
  /** The person said Not now to downloading this model (remembered on disk, ATO-1475). */
  declinedId?: string | null;
  /** `localModels.managed.modelId`. */
  activeModelId: string | null;
  /** The starter model's id (starter-model.ts). */
  starterId: string;
}

export type UpgradeVerdict =
  | { act: "ask"; model: UpgradeModel }
  | { act: "offer"; model: UpgradeModel }
  | { act: "none"; why: "no_answer" | "agent_says_none" | "has_cloud" | "external" | "busy" | "later" | "declined" | "not_on_starter" };

/**
 * What the app does about the big model now. Only an install still on the
 * starter model gets it. The agent already decided
 * whether the model beats the active one; the app adds what only it knows:
 * a cloud route the person chose, a download already in the one slot, a
 * Later said in this run.
 */
export function upgradeVerdict(i: UpgradeInputs): UpgradeVerdict {
  if (!i.recommend) return { act: "none", why: "no_answer" };
  if (i.cloudReady && i.activeProvider && i.activeProvider !== "local-llama") return { act: "none", why: "has_cloud" };
  if (i.localMode && i.localMode !== "managed") return { act: "none", why: "external" };
  /* Only the zero-setup path: a person who picked a model themselves is not
     sent a multi-GB download they did not ask for (proposal for Nadya in the
     PR: offer it to everyone on a weaker model, as a question first). */
  if (i.activeModelId !== i.starterId) return { act: "none", why: "not_on_starter" };
  const r = i.recommend;
  if (r.action === "none" || !r.model) return { act: "none", why: "agent_says_none" };
  if (i.laterId === r.model.id) return { act: "none", why: "later" };
  if (r.action === "switch") return { act: "offer", model: r.model };
  if (i.declinedId === r.model.id) return { act: "none", why: "declined" };
  if (i.downloadBusy) return { act: "none", why: "busy" };
  /* ATO-1475: the download is the person's call. The app only asks, with
     the size; nothing is fetched until they click Download. */
  return { act: "ask", model: r.model };
}

/** The size on the Download button: what goes over the wire, else the catalogue's label. */
export function upgradeDownloadLabel(m: UpgradeModel): string {
  return m.downloadGb > 0 ? `${m.downloadGb.toFixed(1)} GB` : m.sizeLabel;
}

/** The model id a saved Not now names (`{ id, at }`), or null for a missing or broken file. */
export function parseUpgradeDeclined(text: string): string | null {
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Whether the finished download should still be offered: the person did not
 * move to the cloud or to their own server meanwhile, and the model is not
 * already the active one.
 */
export function upgradeStillWanted(i: {
  id: string;
  cloudReady: boolean;
  activeProvider: string | null;
  localMode: string | null;
  activeModelId: string | null;
}): boolean {
  if (i.activeProvider && i.activeProvider !== "local-llama") return false;
  if (i.localMode && i.localMode !== "managed") return false;
  return i.activeModelId !== i.id;
}

/** The one line the chat shows, by phase. */
export type UpgradePhase = "ask" | "downloading" | "ready" | "switching" | "switched" | "failed";

/**
 * Whether a local pick can be taken live by the running agent. Only the
 * move this feature makes: the agent booted on the local route (single
 * mode, no Fusion), and the pick keeps it there with another model. The
 * provider entry stays the same; the agent re-reads the model's profile
 * from the new server at the next turn (ModelProfileManager.refresh).
 */
export function localPickTakenLive(
  boot: { provider: string; mode: string } | null,
  res: { ok?: boolean; providerId?: string; transport?: string },
): boolean {
  if (!boot || !res.ok) return false;
  if (boot.mode === "fusion") return false;
  return boot.provider === "local-llama" && res.providerId === "local-llama" && res.transport === "grammar+llama-server";
}
