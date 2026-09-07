/**
 * 01 — build a small website.
 *
 * The person: opens the app for the first time, sets up a cloud provider,
 * and asks for a one-page site in the folder the app is open on.
 *
 * The human result: two files on disk, an index.html carrying the heading
 * they asked for, a stylesheet it actually links to, and a page that a
 * browser engine parses into that heading. Nothing in here looks at an
 * internal flag; the assertions are the same ones a person makes by
 * opening the folder and double-clicking the file.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  scenario, main, ask, waitTurn, check, modelDidNot, SCENARIO_NAME,
} from '../harness.mjs';

const HEADING = 'Cape Wrath Lighthouse';

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  const site = join(workspace, 'site');

  await ask(app,
    `Please build me a tiny one-page website in a new folder called "site" here. `
    + `It needs exactly two files: site/index.html and site/style.css. `
    + `The page's main heading must read exactly "${HEADING}". `
    + `index.html must link style.css with a <link rel="stylesheet"> tag, and style.css `
    + `must actually set a background colour and a font. Write the files, then tell me you are done.`);

  const turn = await waitTurn(app, { timeout: 420000 });
  app.log(`the agent finished; ${turn.approvals} approval(s) clicked along the way`);

  // ---- what a person looks at: the folder ----------------------------------
  check(existsSync(site), 'a "site" folder appeared in the workspace',
    `looked in ${workspace}, found: ${readdirSync(workspace).join(', ') || '(nothing)'}`);
  const files = readdirSync(site);
  const html = join(site, 'index.html');
  const css = join(site, 'style.css');
  if (!existsSync(html)) modelDidNot('write site/index.html', `the folder holds: ${files.join(', ')}`);
  if (!existsSync(css)) modelDidNot('write site/style.css', `the folder holds: ${files.join(', ')}`);
  check(true, 'both site/index.html and site/style.css exist');

  const source = readFileSync(html, 'utf8');
  const styles = readFileSync(css, 'utf8');
  check(source.includes(HEADING), `index.html contains the heading “${HEADING}”`,
    `the file starts: ${JSON.stringify(source.slice(0, 200))}`);
  check(/[{][^}]*[:][^}]*[}]/.test(styles), 'style.css holds at least one real CSS rule',
    JSON.stringify(styles.slice(0, 160)));

  // ---- and then opens it ----------------------------------------------------
  /* Parsed by the same engine that would render it. The page's own HTML is
     passed in as data and read back out; nothing is executed, and nothing in
     the running app is navigated or touched. */
  const parsed = await app.eval(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(source)}, 'text/html');
    const h = doc.querySelector('h1, h2, header h1, .title');
    const link = [...doc.querySelectorAll('link[rel~="stylesheet"]')].map((n) => n.getAttribute('href'));
    return { heading: h ? h.textContent.trim() : null, sheets: link, title: (doc.title || '').trim(),
             text: (doc.body ? doc.body.textContent : '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
  })()`);
  app.log(`the page parses as: heading=${JSON.stringify(parsed.heading)} stylesheets=${JSON.stringify(parsed.sheets)}`);

  check(parsed.heading === HEADING,
    'a browser engine parses the page and finds that heading at the top',
    `it found ${JSON.stringify(parsed.heading)}; body text: ${JSON.stringify(parsed.text)}`);
  const linked = parsed.sheets.map((h) => join(site, String(h).replace(/^\.?\//, '')));
  check(linked.some((p) => existsSync(p)),
    'the stylesheet the page links to is really there — the page opens unbroken',
    `linked ${JSON.stringify(parsed.sheets)}, which resolves to ${JSON.stringify(linked)}`);

  const reply = turn.reply.toLowerCase();
  check(reply.length > 0, 'the agent answered in the chat rather than going quiet',
    JSON.stringify(turn.reply.slice(0, 200)));
  check(/index\.html|site|done|built|created/.test(reply),
    'the reply says what it built', JSON.stringify(turn.reply.slice(0, 200)));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
