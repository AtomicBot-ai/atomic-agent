import { isMaskableSecretValue } from "../error-reporting/secret-detector.js";
import { readSecretSources, type SecretSources } from "./secret-refs.js";
import { resolveSecretRef, SecretRefError, type SecretSpawner } from "./secret-ref-resolver.js";

/**
 * The secrets a tool call may name as `{{secret:NAME}}` (ATO-476): the
 * `toolSecrets` map of `<stateDir>/secret-sources.json`, name to
 * reference. The model sees and writes only the name; the value is
 * fetched when the approved command is about to start, and is masked in
 * everything the command prints.
 *
 * Opt-in and closed: with no file, or a name not in the map, a call that
 * names a secret fails. The agent's own provider keys are not offered.
 */
export interface ToolSecretSource {
  /** Whether `name` is a configured tool secret. Read fresh per call. */
  has(name: string): boolean;
  /** The value of `name`. Rejects with a message that never holds a value. */
  resolve(name: string): Promise<string>;
}

export interface ToolSecretSourceOptions {
  /** Test seam: the sources instead of reading the file. */
  sources?: () => SecretSources;
  spawn?: SecretSpawner;
  env?: NodeJS.ProcessEnv;
}

export function createToolSecretSource(
  stateDir: string,
  options: ToolSecretSourceOptions = {},
): ToolSecretSource {
  // Read per call, so a secret added to the file mid-session applies to
  // the next command and a removed one stops working at once.
  const sources = options.sources ?? (() => readSecretSources(stateDir));
  return {
    has(name) {
      return Object.hasOwn(sources().toolSecrets, name);
    },
    async resolve(name) {
      const current = sources();
      if (!Object.hasOwn(current.toolSecrets, name)) {
        throw new SecretRefError(`no tool secret named ${name}`);
      }
      const value = await resolveSecretRef(name, current.toolSecrets[name]!, {
        sources: current,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      });
      // Its echo in the output would reach the model unmasked.
      if (!isMaskableSecretValue(value)) {
        throw new SecretRefError(
          `${name}: the value is too short or too plain to be hidden from the model's view of the output, so it is not used`,
        );
      }
      return value;
    },
  };
}
