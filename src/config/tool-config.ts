import { parseBool, parseNonNegativeInt, parsePositiveInt } from "./config-primitives.js";
import { parseStringArrayOrNull } from "./config-values.js";

export interface RuntimeProjectsConfig {
  roots: string[];
}

export interface UserProjectsConfig {
  roots: string[];
}

export function createProjectsDefaults(): UserProjectsConfig {
  return {
    roots: [],
  };
}

export function parseProjectsConfig(
  raw: Record<string, unknown>,
  readDefaults: () => UserProjectsConfig,
): UserProjectsConfig {
  return {
    roots:
      parseStringArrayOrNull(
        raw.roots ?? readDefaults().roots,
        "projects.roots",
      ) ?? [],
  };
}

export interface RuntimeToolsConfig {
  shell: {
    /**
     * Wall-clock wait for an `os.shell.run` call whose `timeoutMs`
     * the model omitted; a command still running then is detached as
     * a job, not killed. `0` = no default (the command runs until it
     * exits or the turn is cancelled). An explicit `timeoutMs`,
     * including `0`, always wins over this — and kills at its limit.
     */
    defaultTimeoutMs: number;
    /** Absolute ceiling for a detached job, from its start. */
    jobMaxMs: number;
    /** Detached jobs running per session; the next detach evicts the oldest. */
    maxJobs: number;
  };
}

export interface UserToolsConfig {
  shell: {
    /**
     * Wall-clock wait, in milliseconds, for an `os.shell.run` call
     * whose `timeoutMs` the model omitted. Default 600 000 (10 min).
     * A command still running then is not killed: it is detached as a
     * job the model can `wait` for or `kill`, with its output so far
     * in the result. `0` = no default, which is the pre-v67 behaviour.
     * The model can still pass an explicit `timeoutMs` per call (`0`
     * for none); that always wins and kills at its limit. A
     * non-negative integer.
     */
    defaultTimeoutMs: number;
    /**
     * Absolute ceiling, in milliseconds, for a detached job, counted
     * from its start — kept or not, waited on or not. Default
     * 3 600 000 (1 h). A positive integer.
     */
    jobMaxMs: number;
    /**
     * Detached jobs that may run at once per session. Default 3. The
     * next detach stops the oldest un-kept job first and says so. A
     * positive integer.
     */
    maxJobs: number;
  };
}

export function createToolsDefaults(): UserToolsConfig {
  return {
    shell: {
      // Ten minutes: long enough for an install or a test suite, short
      // enough that a runaway scan is reported the same hour it started.
      // The detach notice tells the model how to wait for or stop it.
      defaultTimeoutMs: 600_000,
      // An hour: a build or a download that has not finished by then is
      // not going to, and nobody is watching it any more.
      jobMaxMs: 3_600_000,
      // Three concurrent jobs is a server, a watcher and a build; more
      // is a model that has stopped waiting for anything.
      maxJobs: 3,
    },
  };
}

export function parseToolsConfig(
  raw: Record<string, unknown>,
  readDefaults: () => UserToolsConfig,
): UserToolsConfig {
  return {
    shell: {
      // Non-negative rather than positive: `0` is "no default", the
      // behaviour every pre-v67 file had.
      defaultTimeoutMs: parseNonNegativeInt(
        raw.defaultTimeoutMs ??
          readDefaults().shell.defaultTimeoutMs,
        "tools.shell.defaultTimeoutMs",
      ),
      jobMaxMs: parsePositiveInt(
        raw.jobMaxMs ?? readDefaults().shell.jobMaxMs,
        "tools.shell.jobMaxMs",
      ),
      maxJobs: parsePositiveInt(
        raw.maxJobs ?? readDefaults().shell.maxJobs,
        "tools.shell.maxJobs",
      ),
    },
  };
}

export interface RuntimeVisionConfig {
  /** Master kill switch. Disables the tool, skips capability detection. */
  enabled: boolean;
  /** When `false`, treat any vision-capable model as supported regardless of `/props`. */
  autoDetect: boolean;
  /** Hard upper bound on a single image's decoded byte length. */
  maxImageBytes: number;
  /** Hard upper bound on the number of images per `vision.describe` call. */
  maxImagesPerCall: number;
}

export interface UserVisionConfig {
  enabled: boolean;
  autoDetect: boolean;
  maxImageBytes: number;
  maxImagesPerCall: number;
}

export function createVisionDefaults(): UserVisionConfig {
  return {
    enabled: true,
    autoDetect: true,
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerCall: 4,
  };
}

export function parseVisionConfig(
  raw: Record<string, unknown>,
  readDefaults: () => UserVisionConfig,
): UserVisionConfig {
  return {
    enabled: parseBool(
      raw.enabled ?? readDefaults().enabled,
      "vision.enabled",
    ),
    autoDetect: parseBool(
      raw.autoDetect ?? readDefaults().autoDetect,
      "vision.autoDetect",
    ),
    maxImageBytes: parsePositiveInt(
      raw.maxImageBytes ?? readDefaults().maxImageBytes,
      "vision.maxImageBytes",
    ),
    maxImagesPerCall: parsePositiveInt(
      raw.maxImagesPerCall ?? readDefaults().maxImagesPerCall,
      "vision.maxImagesPerCall",
    ),
  };
}
