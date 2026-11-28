/* ---------------- ATO-2741: what an approval asks for, in words ----------------
   One table for the main window's approval card (renderer.js apprAsk, its
   last fallback) and the desktop pet's bubble (pet.js), so both ask
   "Allow it to run a command?" and neither shows a raw tool id. Moved here
   from renderer.js. Loaded before renderer.js (index.html) and before
   pet.js (pet.html); declares only. Every category the agent can send
   (approval-level.ts APPROVAL_CATEGORY_LABELS) but `other` has words here
   (test/approval-category-words.test.mjs). */

const APPR_FALLBACK = {
  fs_write_workspace:'change a file in this folder', fs_write_home:'change a file outside this folder',
  fs_trash:'move files to the Trash', http:'send a web request', shell:'run a command', shell_dangerous:'run a dangerous command',
  script:'run a skill script', proc_kill:'stop a process', browser_nonweb:'open a non-web address',
  trust_config:'change its own settings', fusion_fanout:'hand work to its workers', publish:'publish to GitHub',
  git_remote:'talk to a git remote', email:'send an e-mail', fs_read_outside:'read outside this folder',
  paid_generation:'make a paid image in the cloud',
  // ATO-1393
  browser_commit:'submit, publish or delete something on a website', browser_secret:'enter a password or payment details on a website',
  browser_offsite:'open a site outside the allowed list', state_secret:'touch its own secret files',
  screen_control:'click and type on your screen', screen_capture:'take a screenshot of your screen',
  local_model_restart:'restart the local model', hook_ask:'take a step one of your hooks asked about',
  http_write:'send data in a web request', browser_site_tool:'use a website\u2019s own tool',
  user_question:'ask you a question', session_cross:'read or write in another chat',
  browser_take_over:'hand you the browser to finish a step', shell_secret_input:'have you type a password into its command',
  logbook_cloud:'send your logbook notes to a cloud model',
};

/**
 * A request's action as the end of "Allow it to …?": the category's words,
 * a shell call's when the category is missing, else "go ahead" (what
 * apprAsk says for a category it has no words for).
 */
function apprActionWords(cat, tool) {
  const c = typeof cat === 'string' ? cat : '';
  if (c && Object.prototype.hasOwnProperty.call(APPR_FALLBACK, c)) return APPR_FALLBACK[c];
  if (tool === 'os.shell.run') return APPR_FALLBACK.shell;
  return 'go ahead';
}

if (typeof module !== 'undefined') module.exports = {APPR_FALLBACK, apprActionWords};
