/**
 * Turn whatever a person pastes into a Hugging Face repo (and possibly a
 * file) they meant. Ported from PR #38 by sachin-detrax, which worked
 * this shape out against the forms people actually copy off a model card.
 */

const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

/** A repo, plus the one file inside it the reference named, if any. */
export interface HuggingFaceModelRef {
  /** `owner/name`. */
  repoId: string;
  /** Git revision — branch, tag or sha. `main` when the reference omits one. */
  revision: string;
  /** Path of a specific `.gguf` inside the repo, when one was named. */
  filePath: string | null;
}

const REPO_ID_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Strip a copied `hf download …` line down to its argument and drop any
 * trailing flags. The model card prints the whole command, so that is
 * what lands on the clipboard.
 */
function stripDownloadCommand(raw: string): string {
  return raw
    .replace(/^(?:hf|huggingface-cli|huggingface_hub)\s+download\s+/i, "")
    .split(/\s+--/)[0]!
    .trim();
}

/**
 * `hf://owner/repo[@revision]/path/to/file.gguf`, the scheme the `hf` CLI
 * accepts.
 *
 * Parsed by hand rather than with `new URL`: that puts the owner in the
 * host slot and lowercases it, and Hugging Face owners are
 * case-sensitive, so `hf://Qwen/…` would silently resolve to nothing.
 */
function parseHfSchemeRef(raw: string): HuggingFaceModelRef {
  const segments = raw.replace(/^hf:\/\//i, "").split("/").filter(Boolean);
  const head = segments[0]?.toLowerCase();
  if (head === "datasets" || head === "spaces") {
    throw new Error(
      `hf://${head}/… points at a ${head.replace(/s$/, "")}, not a model repo`,
    );
  }
  if (head === "models") segments.shift();
  const [owner, repoAndRevision, ...fileSegments] = segments;
  if (!owner || !repoAndRevision) {
    throw new Error(`hf:// reference is missing <owner>/<name>: ${JSON.stringify(raw)}`);
  }
  // Only the simple `repo@rev` form is supported, which is the one the
  // CLI prints; a revision containing a slash (`refs/pr/1`) would be
  // indistinguishable from the file path that follows it.
  const at = repoAndRevision.lastIndexOf("@");
  const name = at > 0 ? repoAndRevision.slice(0, at) : repoAndRevision;
  const revision = at > 0 ? repoAndRevision.slice(at + 1) : "main";
  return {
    repoId: `${owner}/${name}`,
    revision: revision || "main",
    filePath: fileSegments.length > 0 ? fileSegments.join("/") : null,
  };
}

/**
 * Accepts, in order of how often they get pasted:
 *   https://huggingface.co/<owner>/<name>
 *   https://huggingface.co/<owner>/<name>/tree/<rev>
 *   https://huggingface.co/<owner>/<name>/blob|resolve/<rev>/<file>.gguf
 *   hf.co/<owner>/<name>
 *   hf://<owner>/<name>[@rev][/<file>.gguf]
 *   hf download <owner>/<name> <file>.gguf
 *   <owner>/<name>
 *
 * Anything else throws with a message meant for the screen: the caller
 * shows it verbatim rather than turning it into "invalid input".
 */
export function parseHuggingFaceModelRef(raw: string): HuggingFaceModelRef {
  const command = stripDownloadCommand(raw.trim());
  const trimmed = command.replace(/[?#].*$/, "");
  if (trimmed.length === 0) throw new Error("Type a repo id or a huggingface.co URL.");

  if (/^hf:\/\//i.test(trimmed)) return parseHfSchemeRef(trimmed);

  // The two-argument `hf download` form. Narrow on purpose: the first
  // token has to look like a repo id, so an ordinary two-word phrase
  // still falls through to the URL branch and is rejected there.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 2 && REPO_ID_RE.test(tokens[0]!) && /\.gguf$/i.test(tokens[1]!)) {
    return { repoId: tokens[0]!, revision: "main", filePath: tokens[1]! };
  }

  if (REPO_ID_RE.test(trimmed)) {
    return { repoId: trimmed, revision: "main", filePath: null };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(
      `Not a Hugging Face URL or an owner/name id: ${JSON.stringify(raw.trim())}`,
    );
  }
  if (!HF_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Not a huggingface.co URL: ${JSON.stringify(raw.trim())}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "models") segments.shift();
  const [owner, name, verb, revision, ...rest] = segments;
  if (!owner || !name) {
    throw new Error(`That URL names no repo: ${JSON.stringify(raw.trim())}`);
  }
  const repoId = `${owner}/${name}`;
  if (verb === "resolve" || verb === "blob") {
    const filePath = rest.join("/");
    if (!filePath) {
      throw new Error(`That URL names no file: ${JSON.stringify(raw.trim())}`);
    }
    return { repoId, revision: revision || "main", filePath };
  }
  if (verb === "tree") return { repoId, revision: revision || "main", filePath: null };
  return { repoId, revision: "main", filePath: null };
}
