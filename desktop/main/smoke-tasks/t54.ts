/**
 * Release-fix checks for backlog item 54 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=54`.
 *
 * 54 (ATO-164) — the chat's service notices, in plain words. Danya and Valera
 * could not read three of them: "this session ran on local-llama — the window
 * is on openrouter/… (a switch restarts the agent, so it is refused while any
 * turn is running)", "a turn is still running here — the reply lands when it
 * finishes", and the receipt "Approved · 13:19:45 · fusion · fan-out".
 * Checked: the receipt names what was allowed and keeps the agent's label as
 * its tooltip; the stamp notice names providers by name and has no engine
 * words; the line for a chat still answering elsewhere is a sentence.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);
const JARGON = /\b(?:turn|session|local-llama|fan-out|refused)\b/i;

export async function checks54(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const host = document.createElement('div');
    host.innerHTML = apprCard({state: 'approved', at: '13:19:45', cat: 'fusion_fanout', kind: CATEGORY_LABEL.fusion_fanout});
    const badge = host.querySelector('.badge');
    const keep = {log: S.log, cfg: LIVE_CONFIG, want: SWX.want, stamp: CTX055.stamp};
    S.log = [];
    let stamp = [];
    try {
      // Staged: the window on OpenRouter, the chat stamped with a local model (the config file is not touched).
      const cfg = JSON.parse(JSON.stringify(LIVE_CONFIG || {}));
      cfg.llm = Object.assign({}, cfg.llm, {activeTextProvider: 'openrouter', providers: [{id: 'local-llama', kind: 'llama-server'},
        {id: 'openrouter', kind: 'openrouter', defaultChatModel: 'deepseek/deepseek-v4-flash'}]});
      LIVE_CONFIG = cfg; SWX.want = null;
      noteSessionModelStamp({metadata: {llm: {providerId: 'local-llama', chatModel: 'qwen-3.5-9b'}}});
      const live = selActiveProviderId();
      stamp = S.log.map((m) => { const d = document.createElement('div'); d.innerHTML = m.text; return d.textContent || ''; });
      return {badge: badge ? badge.textContent : null, title: badge ? badge.getAttribute('title') : null,
        live: LIVE_ELSEWHERE_LINE, stamp, liveProvider: live};
    } finally { S.log = keep.log; LIVE_CONFIG = keep.cfg; SWX.want = keep.want; CTX055.stamp = keep.stamp; render(); }
  })()`);
  check(
    "T54: an approval's receipt says what was allowed in words, with the agent's category label as its tooltip",
    r["badge"] === "split the work across helper models" && r["title"] === "fusion · fan-out",
    show(r),
  );
  check(
    "T54: a chat opened while it is still answering says so in a sentence, without engine words",
    typeof r["live"] === "string" && /^Still answering your last message\./.test(String(r["live"])) && !JARGON.test(String(r["live"])),
    show(r["live"]),
  );
  const stamp = (r["stamp"] ?? []) as string[];
  check(
    "T54: a chat that ran on another model names both by their provider's name — \"Local models\", not local-llama — with no engine words",
    r["liveProvider"] === "openrouter" && stamp.length === 1
      && stamp[0]!.startsWith("This chat ran on Local models · qwen-3.5-9b. New messages now go to OpenRouter")
      && !JARGON.test(stamp[0]!.replace("Switch to it", "")),
    show({ stamp, liveProvider: r["liveProvider"] }),
  );
}
