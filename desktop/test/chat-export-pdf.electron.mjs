/* ATO-1054 (review F09-2): print a long chat's HTML to PDF in real Electron.

   Not part of test:unit (it needs Electron, not plain node). Run after a
   build, from desktop/:

     npm run build && npx electron test/chat-export-pdf.electron.mjs

   Prints a 100 KB and a ~1.7 MB page through printHtmlToPdf. The second is
   past what a base64 data: URL can carry under Chromium's 2 MiB URL cap,
   which is why the page goes through a temp file and loadFile. Also checks
   the temp folder is gone afterwards. Exits 0 on pass, 1 on fail. */

import { app } from 'electron';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { printHtmlToPdf } = require('../out/main/chat-export.js');

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('atag-chat-export-'));

async function main() {
  const before = new Set(leftovers());
  const fails = [];
  for (const [name, size] of [['100 KB', 100_000], ['1.7 MB', 1_700_000]]) {
    const html = '<!doctype html><meta charset="utf-8"><p>' + 'x'.repeat(size) + '</p>';
    try {
      const pdf = await printHtmlToPdf(html);
      const ok = Buffer.isBuffer(pdf) && pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.length > 1000;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name} page -> ${pdf.length} byte PDF`);
      if (!ok) fails.push(name);
    } catch (e) {
      console.log(`FAIL ${name} page -> ${e instanceof Error ? e.message : String(e)}`);
      fails.push(name);
    }
  }
  const left = leftovers().filter((n) => !before.has(n));
  console.log(`${left.length === 0 ? 'PASS' : 'FAIL'} temp folders removed${left.length ? ': ' + left.join(', ') : ''}`);
  if (left.length) fails.push('cleanup');
  return fails.length === 0 ? 0 : 1;
}

// Each print opens and destroys a hidden window; the app must not quit in between.
app.on('window-all-closed', () => {});
app.whenReady().then(main).then((code) => app.exit(code), (e) => { console.error(e); app.exit(1); });
