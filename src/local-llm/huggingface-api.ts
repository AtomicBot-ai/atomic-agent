/**
 * The two calls the first-run flow makes against huggingface.co: list a
 * repo's files, and read the token that unlocks a gated one. Derived from
 * PR #38 by sachin-detrax, whose error wording for the 401/404 pair is
 * kept because Hugging Face genuinely does not distinguish "private" from
 * "does not exist" and the message has to cover both.
 */

const HF_API = "https://huggingface.co/api";

export interface HuggingFaceFile {
  path: string;
  sizeBytes: number;
}

export function huggingFaceToken(): string | null {
  const raw = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "").trim();
  return raw.length > 0 ? raw : null;
}

async function fetchHfJson(path: string, timeoutMs = 15_000): Promise<unknown> {
  const token = huggingFaceToken();
  let res: Response;
  try {
    res = await fetch(`${HF_API}${path}`, {
      headers: {
        "User-Agent": "atomic-agent/local-llm",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      `Could not reach huggingface.co: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Hugging Face returned ${res.status}: either no such repo, or it is gated. ` +
        (token
          ? "Your HF_TOKEN does not grant access — accept the licence on huggingface.co."
          : "If it is gated, accept its licence on huggingface.co and export HF_TOKEN."),
    );
  }
  if (res.status === 404) {
    throw new Error("Hugging Face returned 404: no repo or revision by that name.");
  }
  if (!res.ok) {
    throw new Error(`Hugging Face returned HTTP ${res.status} ${res.statusText}.`);
  }
  return res.json();
}

/** Every `.gguf` in a repo revision, with its real (LFS) size. */
export async function listHuggingFaceGgufFiles(
  repoId: string,
  revision = "main",
): Promise<HuggingFaceFile[]> {
  const raw = await fetchHfJson(
    `/models/${repoId}/tree/${encodeURIComponent(revision)}?recursive=true`,
  );
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : null;
    if (!path || !path.toLowerCase().endsWith(".gguf")) return [];
    // Everything over 10 MB is stored in LFS, where `size` on the tree
    // entry is the pointer file's size, not the model's.
    const lfs = record.lfs as Record<string, unknown> | undefined;
    const sizeBytes =
      typeof lfs?.size === "number"
        ? lfs.size
        : typeof record.size === "number"
          ? record.size
          : 0;
    return [{ path, sizeBytes }];
  });
}

export function resolveHuggingFaceFileUrl(
  repoId: string,
  revision: string,
  filePath: string,
): string {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repoId}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}
