/* ---------------- ATO-2507: Deep research report card, and /research ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/research-card.test.mjs).

   research.deep (agent ATO-2133, ATO-2507) reads several web pages or the
   person's documents in My files, keeps only findings whose exact quote is
   on the page, and saves a Markdown report in the chat's folder. The reply
   that follows gets a card under its text, like ChatGPT's and Gemini's Deep
   Research report cards: what was researched, where (web, documents or
   both), how many findings were verified, left unverified and in conflict,
   and a chip for the report file (click previews it beside the chat,
   Cmd/Ctrl-click opens it, right-click is the file menu, as every .filechip).

   Live, the agent puts `research: {reportPath, question, sources, counts}`
   on the `tool_result` frame (src/http/research-frame.ts). The session store
   keeps no tool details, so a reopened chat reads the stored summary instead:
   its first line names the report path, and the report's own header line
   gives the counts. An older agent sends neither the frame nor the header:
   the card then shows the chip alone, or nothing when there is no path.

   `/research [--docs | --both] <question>` sends the same words as the
   terminal's /research (src/tui/commands/research-command.ts). */

const RESEARCH_TOOL = 'research.deep';
const RESEARCH_SOURCES = {web: 'Web', documents: 'Your documents', both: 'Web and your documents'};
const RESEARCH_USAGE = 'Usage: /research [--docs | --both] <question>. --docs looks only in your documents in My files; --both looks on the web and in your documents.';

function researchSourceOk(s) { return typeof s === 'string' && Object.prototype.hasOwnProperty.call(RESEARCH_SOURCES, s); }

function researchCount(n) { return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null; }

/** The frame's `research`, checked; null when there is none or its shape is off. */
function researchFromFrame(p) {
  const r = p && typeof p === 'object' ? p.research : null;
  if (!r || typeof r !== 'object') return null;
  const path = r.reportPath === null ? null : (typeof r.reportPath === 'string' && r.reportPath ? r.reportPath : undefined);
  if (path === undefined || typeof r.question !== 'string') return null;
  return {
    reportPath: path,
    question: r.question,
    sources: researchSourceOk(r.sources) ? r.sources : 'web',
    pagesRead: researchCount(r.pagesRead),
    verified: researchCount(r.verified),
    unverified: researchCount(r.unverified),
    contradictions: researchCount(r.contradictions),
    judged: researchCount(r.judged),
    stoppedEarly: r.stoppedEarly === true,
  };
}

/** The same facts out of the stored summary (a reopened chat); null when it is not a research result. */
function researchFromSummary(summary) {
  const text = typeof summary === 'string' ? summary : '';
  /* Only the tool's own first line, past the agent's outside-text framing
     ("[external content from …]", "<<<UNTRUSTED …>>>"): the report below it
     quotes outside pages, which could hold a line of the same shape. */
  const first = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[external content') && !l.startsWith('<<<')) || '';
  const saved = /^Saved the research report to (.+)$/.exec(first);
  const notSaved = /^Research report not saved:/.test(first);
  if (!saved && !notSaved) return null;
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  const q = /^# Research: (.+)$/m.exec(text);
  const src = /UTC\. Sources: (the web and your documents|your documents|the web)/.exec(text);
  const section = (name) => {
    const at = text.indexOf('\n## ' + name + '\n');
    if (at < 0) return '';
    const next = text.indexOf('\n## ', at + 4);
    return text.slice(at, next < 0 ? text.length : next);
  };
  const flags = section('Contradictions').split('\n').filter((l) => l.startsWith('- '));
  return {
    reportPath: saved ? saved[1].trim() : null,
    question: q ? q[1].trim() : '',
    sources: src ? (src[1] === 'the web' ? 'web' : src[1] === 'your documents' ? 'documents' : 'both') : 'web',
    pagesRead: num(/(\d+) (?:page|passage)\(s\) read/),
    verified: num(/(\d+) verified finding\(s\)/),
    unverified: num(/verified finding\(s\), (\d+) unverified/),
    contradictions: section('Contradictions') ? flags.length : null,
    judged: section('Contradictions') ? flags.filter((l) => l.includes(' Judge: ')).length : null,
    stoppedEarly: /^\*\*Stopped early:\*\*/m.test(text),
  };
}

/** Live: an ok research.deep card puts its report on the reply being written (`item`). */
function researchCardAttach(item, card, p) {
  if (!item || !card || card.name !== RESEARCH_TOOL || card.ok !== true) return;
  const r = researchFromFrame(p) || researchFromSummary(card.out);
  if (!r) return;
  item.research = (Array.isArray(item.research) ? item.research : []).concat([r]).slice(-5);
}

/** A reopened chat: each ok research.deep result goes on the next reply after it. */
function researchCardsLink(log) {
  if (!Array.isArray(log)) return;
  let waiting = [];
  for (const m of log) {
    if (!m) continue;
    if (m.k === 'tool' && m.name === RESEARCH_TOOL && m.ok === true) {
      const r = researchFromSummary(m.out);
      if (r) waiting.push(r);
    } else if (m.k === 'assistant' && waiting.length) {
      m.research = waiting.slice(-5);
      waiting = [];
    } else if (m.k === 'user') waiting = [];
  }
}

function researchPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

function researchCardHTML(r, deps) {
  const {esc, ic} = deps;
  const icon = (n) => (typeof ic === 'function' ? ic(n) : '');
  const stats = [];
  if (r.verified !== null) stats.push(researchPlural(r.verified, 'verified finding', 'verified findings'));
  if (r.unverified !== null) stats.push(r.unverified + ' unverified');
  if (r.contradictions !== null && r.contradictions > 0) {
    stats.push(researchPlural(r.contradictions, 'conflict', 'conflicts') + (r.judged ? ' (' + r.judged + ' judged)' : ''));
  }
  if (r.pagesRead !== null) stats.push(researchPlural(r.pagesRead, r.sources === 'documents' ? 'passage' : 'page', r.sources === 'documents' ? 'passages' : 'pages') + ' read');
  const name = r.reportPath ? (String(r.reportPath).split(/[\\/]/).pop() || r.reportPath) : '';
  return '<div class="rc-card" data-research-card="1">'
    + '<div class="rc-head">' + icon('search') + '<span class="rc-title">Research report</span>'
    + '<span class="rc-src">' + esc(RESEARCH_SOURCES[researchSourceOk(r.sources) ? r.sources : 'web']) + '</span></div>'
    + (r.question ? '<div class="rc-q">' + esc(r.question) + '</div>' : '')
    + (stats.length ? '<div class="rc-stats tnum">' + esc(stats.join(' · ')) + '</div>' : '')
    + (r.stoppedEarly ? '<div class="rc-warn">Stopped at its time limit. The report covers what was read by then.</div>' : '')
    + (r.reportPath
      ? '<div class="rc-acts"><button class="filechip" data-file="' + esc(r.reportPath) + '" data-reply="1" title="' + esc(r.reportPath) + '">'
        + icon('doc') + '<span>' + esc(name) + '</span></button></div>'
      : '<div class="rc-none">The report was not saved to a file. It is in the answer above.</div>')
    + '</div>';
}

/** The cards under a reply: '' when the turn ran no research. */
function researchCardsHTML(list, deps) {
  return Array.isArray(list) && list.length ? list.map((r) => researchCardHTML(r, deps)).join('') : '';
}

/** `/research` words to the message it sends, as the terminal's /research. */
function researchCommandFrom(words) {
  const parts = (Array.isArray(words) ? words : []).filter(Boolean);
  let scope = 'web';
  const flags = {'--web': 'web', '--docs': 'documents', '--documents': 'documents', '--files': 'documents', '--both': 'both'};
  if (parts.length && /^--/.test(parts[0])) {
    const known = flags[parts[0].toLowerCase()];
    if (!known) return {ok: false, error: RESEARCH_USAGE};
    scope = known;
    parts.shift();
  }
  const question = parts.join(' ').trim();
  if (!question) return {ok: false, error: RESEARCH_USAGE};
  if (scope === 'documents') return {ok: true, text: 'Research this in my documents in My files with the research.deep tool (sources: "documents", nothing online), then answer from its verified findings with their links: ' + question};
  if (scope === 'both') return {ok: true, text: 'Research this on the web and in my documents in My files with the research.deep tool (sources: "both"), then answer from its verified findings with their links: ' + question};
  return {ok: true, text: 'Research this with the research.deep tool, then answer from its verified findings with their links: ' + question};
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {RESEARCH_USAGE, researchFromFrame, researchFromSummary, researchCardAttach, researchCardsLink, researchCardHTML, researchCardsHTML, researchCommandFrom};
}
