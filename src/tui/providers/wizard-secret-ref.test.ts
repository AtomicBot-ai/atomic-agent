import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetSecretRefCache,
  type SecretSpawner,
} from "../../config/secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES } from "../../config/secret-refs.js";
import { probeWizardContract } from "./probe-wizard-contract.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";
import { verifyWizardBeforeSave } from "./verify-wizard-before-save.js";
import {
  describeUnreadableSecretRef,
  readWizardKeyReference,
} from "./wizard-secret-ref.js";

/**
 * ATO-2530: a key typed on the /providers key screen as `op://…` is read
 * before the wizard checks or saves it. No real `op` runs here: the
 * spawner is a fake.
 */

const OP_REF = "op://Private/OpenRouter/credential";

function wizard(apiKeyBuffer: string): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", { kind: "openrouter" }),
    phase: "api_key",
    apiKeyBuffer,
  };
}

const lockedOp: SecretSpawner = async () => ({
  stdout: "",
  stderr: "[ERROR] 2026/11/28 you are not currently signed in",
  exitCode: 1,
  failure: null,
});

const signedInOp: SecretSpawner = async (argv) => ({
  stdout: argv[2] === OP_REF ? "sk-or-real-value\n" : "",
  stderr: "",
  exitCode: 0,
  failure: null,
});

function stubOkFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentAuthorizations(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    (call) => ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.authorization ?? "",
  );
}

beforeEach(() => {
  resetSecretRefCache();
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSecretRefCache();
  delete process.env.OPENROUTER_API_KEY;
});

describe("verifyWizardBeforeSave with a reference", () => {
  it("stops the save with a plain sentence and a Details line when 1Password is locked", async () => {
    const fetchMock = stubOkFetch();
    const gate = await verifyWizardBeforeSave(wizard(OP_REF), {
      secretRefs: { sources: EMPTY_SECRET_SOURCES, spawn: lockedOp },
    });
    expect(gate.proceed).toBe(false);
    const error = gate.proceed ? "" : gate.error;
    const [first, second] = error.split("\n");
    expect(first).toBe(
      "Could not read this key from 1Password. Open 1Password and sign in (or check the op:// reference), then save again.",
    );
    expect(second).toMatch(/^Details: OPENROUTER_API_KEY: op failed \(exit code 1\): \[ERROR\]/);
    // The reference never reached the service as a key.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the key with the value 1Password gives, never the reference", async () => {
    const fetchMock = stubOkFetch();
    const gate = await verifyWizardBeforeSave(wizard(OP_REF), {
      secretRefs: { sources: EMPTY_SECRET_SOURCES, spawn: signedInOp },
    });
    expect(gate).toEqual({ proceed: true, warning: null });
    const sent = sentAuthorizations(fetchMock);
    expect(sent.length).toBeGreaterThan(0);
    for (const header of sent) {
      expect(header).toBe("Bearer sk-or-real-value");
      expect(header).not.toContain("op://");
    }
  });

  it("leaves a plain key alone: no program runs", async () => {
    stubOkFetch();
    const spawn = vi.fn(lockedOp);
    const gate = await verifyWizardBeforeSave(wizard("sk-or-plain"), {
      secretRefs: { sources: EMPTY_SECRET_SOURCES, spawn },
    });
    expect(gate.proceed).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("probeWizardContract with a reference", () => {
  it("never sends an unreadable reference as the key", async () => {
    const fetchMock = stubOkFetch();
    const outcome = await probeWizardContract(
      { ...wizard(OP_REF), selectedChatModelId: "openai/gpt-4o-mini" },
      { secretRefs: { sources: EMPTY_SECRET_SOURCES, spawn: lockedOp } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.proven).toBe(false);
    expect(outcome.warning).toMatch(/^Could not read this key from 1Password\./);
  });
});

describe("readWizardKeyReference", () => {
  it("returns null for anything that is not a reference", async () => {
    expect(await readWizardKeyReference("", "OPENROUTER_API_KEY")).toBeNull();
    expect(await readWizardKeyReference("sk-or-plain", "OPENROUTER_API_KEY")).toBeNull();
  });

  it("names the missing cmd:// helper in plain words", async () => {
    const read = await readWizardKeyReference("cmd://openrouter", "OPENROUTER_API_KEY", {
      sources: EMPTY_SECRET_SOURCES,
    });
    expect(read?.ok).toBe(false);
    const error = read && !read.ok ? read.error : "";
    expect(error.split("\n")[0]).toBe(
      "The command for this key did not give a key. Check the cmd:// helper in secret-sources.json, then save again.",
    );
    expect(error).toContain("\nDetails: OPENROUTER_API_KEY");
  });

  // Review round 1 (F2102.4): the same reference typed again after a key
  // rotation is read again, so the check tests the new key, not the cached one.
  it("reads the reference again when it is typed again", async () => {
    const said =
      (v: string): SecretSpawner =>
      async () => ({ stdout: `${v}\n`, stderr: "", exitCode: 0, failure: null });
    const deps = { sources: EMPTY_SECRET_SOURCES };
    expect(await readWizardKeyReference(OP_REF, "OPENROUTER_API_KEY", { ...deps, spawn: said("sk-or-old") })).toEqual({
      ok: true,
      value: "sk-or-old",
    });
    expect(await readWizardKeyReference(OP_REF, "OPENROUTER_API_KEY", { ...deps, spawn: said("sk-or-new") })).toEqual({
      ok: true,
      value: "sk-or-new",
    });
  });
});

describe("describeUnreadableSecretRef", () => {
  it("says what to do for each source, then the reason", () => {
    expect(describeUnreadableSecretRef("bitwarden", "X: bw failed")).toBe(
      "Could not read this key from Bitwarden. Unlock Bitwarden (run `bw unlock` and set BW_SESSION) or check the bw:// reference, then save again.\nDetails: X: bw failed",
    );
    expect(describeUnreadableSecretRef("vault", "X: 403")).toMatch(
      /^Could not read this key from Vault\. .*\nDetails: X: 403$/,
    );
  });

  it("has no Details line when there is no reason", () => {
    expect(describeUnreadableSecretRef("1password", "  ")).not.toContain("Details");
  });
});
