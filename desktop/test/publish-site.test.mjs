import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publishSiteFolder, publishSiteRequest, publishSiteMessage, publishSiteButtonHTML } = require('../renderer/publish-site.js');

/* ATO-594: Publish… on a page the agent made. */

test('the site is the folder the page is in, on every platform', () => {
  assert.equal(publishSiteFolder('/Users/me/site/index.html'), '/Users/me/site');
  assert.equal(publishSiteFolder('C:\\Users\\me\\site\\page.HTM'), 'C:\\Users\\me\\site');
  assert.equal(publishSiteFolder('/Users/me/notes.md'), '');
  assert.equal(publishSiteFolder('index.html'), '');
  assert.equal(publishSiteFolder(null), '');
});

test('the message loads the publish-site skill and asks it to wait for a yes', () => {
  const msg = publishSiteMessage('/Users/me/site/index.html');
  assert.match(msg, /"publish-site" skill/);
  assert.match(msg, /skill\.view\(\{"name":"publish-site"\}\)/);
  assert.match(msg, /"\/Users\/me\/site"/);
  assert.match(publishSiteRequest('/Users/me/site/index.html'), /wait for my yes before publishing anything/);
});

test('a path with quotes stays one quoted string in the request', () => {
  assert.match(publishSiteRequest('/a/b"c/index.html'), /"\/a\/b\\"c"/);
});

test('the page bar\'s button: only for a page in a folder, escaped', () => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  assert.equal(publishSiteButtonHTML('/a/notes.md', esc), '');
  const html = publishSiteButtonHTML('/a/"x"/index.html', esc);
  assert.match(html, /data-act="pubsite:\/a\/&quot;x&quot;\/index\.html"/);
  assert.match(html, /Publish…/);
});
