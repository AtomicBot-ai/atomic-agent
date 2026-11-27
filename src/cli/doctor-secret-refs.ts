import {
  listSavedSecretRefs,
  type SavedSecretRefEntry,
  type SecretRefSource,
} from "../config/index.js";
import { resolveSecretRefSync, type SyncSecretSpawner } from "../config/secret-ref-resolver.js";
import { readSecretSources, SECRET_SOURCES_FILE, type SecretSources } from "../config/secret-refs.js";
import type { DoctorContext, DoctorFinding } from "./doctor-checks.js";

/**
 * `atag doctor` for secret references (ATO-2530): each saved key written
 * as `op://…`, `bw://…`, `vault://…` or `cmd://…` is resolved (from the
 * process cache when the agent already did at start, so a password
 * manager is asked at most once), and `secret-sources.json` is checked.
 * Findings name the key and the reason, never a value. No fix: signing in
 * to a password manager is the person's step.
 */
export interface SecretRefDoctorDeps {
  list?: (stateDir: string) => SavedSecretRefEntry[];
  sources?: (stateDir: string, warn: (message: string) => void) => SecretSources;
  spawn?: SyncSecretSpawner;
  env?: NodeJS.ProcessEnv;
}

const SOURCE_NAMES: Record<SecretRefSource, string> = {
  "1password": "1Password",
  bitwarden: "Bitwarden",
  vault: "Vault",
  command: `your command in ${SECRET_SOURCES_FILE}`,
};

export function createSecretRefsCheck(deps: SecretRefDoctorDeps = {}): (ctx: DoctorContext) => DoctorFinding[] {
  return (ctx) => {
    const out: DoctorFinding[] = [];
    const problems: string[] = [];
    const sources = (deps.sources ?? readSecretSources)(ctx.stateDir, (m) => problems.push(m));
    for (const problem of problems) {
      out.push({ check: "secret-refs", status: "fail", message: `${problem} (edit the file by hand)` });
    }
    let refs: SavedSecretRefEntry[];
    try {
      refs = (deps.list ?? listSavedSecretRefs)(ctx.stateDir);
    } catch (err) {
      return [...out, { check: "secret-refs", status: "warn", message: `could not list saved keys: ${messageOf(err)}` }];
    }
    for (const entry of refs) {
      const from = SOURCE_NAMES[entry.source];
      try {
        resolveSecretRefSync(entry.name, entry.ref, {
          sources,
          ...(deps.env === undefined ? {} : { env: deps.env }),
          ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
        });
        out.push({ check: "secret-refs", status: "ok", message: `${entry.name}: read from ${from}` });
      } catch (err) {
        out.push({
          check: "secret-refs",
          status: "fail",
          message: `${messageOf(err)} (saved as a reference to ${from}; sign in there, then run atag doctor again)`,
        });
      }
    }
    const toolSecrets = Object.keys(sources.toolSecrets);
    if (toolSecrets.length > 0) {
      out.push({
        check: "secret-refs",
        status: "ok",
        message: `tool secrets a command may name as {{secret:NAME}}: ${toolSecrets.join(", ")} (read when a command uses one)`,
      });
    }
    return out;
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
