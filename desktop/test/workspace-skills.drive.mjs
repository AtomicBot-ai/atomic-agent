// Real Electron + real serve/CLI, disposable state, deterministic loopback
// inference. Actions use trusted pointer/keyboard events; eval observes only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, REPO_DIR } from './drive.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'atag-workspace-skills-')));
const stateDir = join(root, 'state'), workspace = join(root, 'project-A'), other = join(root, 'project-B');
const cli = join(REPO_DIR, 'dist/cli/index.js');
const env = {...process.env, ATOMIC_AGENT_STATE_DIR:stateDir};
const prompts = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/completion') {
    const input = JSON.parse(body); prompts.push(input.prompt);
    const content = prompts.length === 1 ? '[{"tool":"skill.view","args":{"name":"openspec-explore"}}]'
      : '[{"tool":"reply","args":{"text":"Workspace skill loaded successfully"}}]';
    if (input.stream) {
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.end('data: ' + JSON.stringify({content, stop:false}) + '\n\ndata: ' + JSON.stringify({content:'', stop:true, tokens_predicted:20, tokens_evaluated:100, timings:{prompt_n:100,predicted_n:20}}) + '\n\n');
    } else { res.setHeader('content-type','application/json'); res.end(JSON.stringify({content, stop:true, tokens_predicted:20, tokens_evaluated:100})); }
    return;
  }
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url === '/props' ? {default_generation_settings:{n_ctx:32768}, total_slots:1} : {status:'ok', data:[{id:'fixture'}]}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${server.address().port}`;
function stage(base, source, name, text, manual = false) {
  const dir = join(base, source, name); mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir,'SKILL.md'), `---\nname: ${name}\ndescription: Explore this workspace\n${manual ? 'disable-model-invocation: true\n' : ''}---\n${text}`);
}
stage(workspace, '.agents/skills', 'openspec-explore', 'PROJECT A BODY');
stage(workspace, '.claude/skills', 'openspec-explore', 'SHADOWED BODY');
stage(workspace, '.claude/skills', 'manual-only', 'MANUAL BODY', true);
stage(other, '.pi/skills', 'other-project', 'PROJECT B BODY');
execFileSync(process.execPath, [cli,'config','get'], {env, stdio:'ignore'});
const configFile = join(stateDir,'config.json'), config = JSON.parse(readFileSync(configFile,'utf8'));
config.tui.onboarding = {completedAt:new Date().toISOString()};
config.analytics.enabled = false;
config.llm = {...config.llm, activeTextProvider:'fixture', activeEmbeddingProvider:'local-llama', toolTransport:'grammar',
  providers:[{id:'local-llama',kind:'llama-server'}, {id:'fixture',kind:'llama-server',url:modelUrl,modelMode:'cloud'}]};
config.localModels.url = modelUrl; config.agent.approvalLevel = 5;
config.agent.nameSessions = false;
writeFileSync(configFile, JSON.stringify(config,null,2));
stage(stateDir, 'skills', 'global-guide', 'GLOBAL BODY');
const readConfig = () => JSON.parse(readFileSync(configFile,'utf8'));
let app;
try {
  app = await launch({port:Number(process.env.ATAG_SKILLS_PORT || 9487),stateDir,workspace,verbose:false});
  await app.waitFor(`document.querySelector('#entry') && document.querySelector('#toolbar')?.textContent`, 'composer ready', {timeout:90000});
  await app.clickSel('[data-act="settings:open"]'); await app.clickSel('[data-act="settings:skills"]');
  await app.waitFor(`document.querySelector('[data-skill-row="openspec-explore"]')`, 'project skill before first chat', {timeout:60000});
  assert.equal(await app.eval(`document.querySelectorAll('[data-skill-row="openspec-explore"]').length`), 1);
  await app.clickSel('[data-skill-row="openspec-explore"]');
  await app.waitFor(`document.querySelector('.set-skmd')?.textContent.includes('PROJECT A BODY')`, 'selected source body');
  assert.equal(await app.eval(`document.querySelector('.set-skmd').textContent.includes('SHADOWED BODY')`),false);
  await app.screenshot(join(root,'skill-detail.png'));
  console.log('UI workspace scope action');
  await app.clickSel('[data-act="skills:scope:workspace:openspec-explore"]');
  await app.waitFor(`document.querySelector('.set-skills')?.textContent.includes('disabled in workspace')`, 'workspace disable');
  assert.ok(readConfig().skills.cloudWorkspaces.find(p => p.workingDir === workspace).disabled.includes('openspec-explore'));
  await app.clickSel('[data-act="skills:scope:workspace:openspec-explore"]');
  await app.waitFor(`document.querySelector('.set-skills')?.textContent.includes('Available to the model')`, 'workspace enable');
  await app.clickSel('[data-act="skills:scope:global:openspec-explore"]');
  await app.waitFor(`document.querySelector('.set-skills')?.textContent.includes('disabled globally')`, 'global disable');
  await app.clickSel('[data-act="skills:scope:global:openspec-explore"]');
  await app.waitFor(`document.querySelector('.set-skills')?.textContent.includes('Available to the model')`, 'global enable');
  await app.clickSel('[data-act="skills:project"]');
  await app.waitFor(`document.querySelector('[data-act="skills:project"]')?.textContent.includes('Enable project')`, 'bulk disable');
  assert.equal(readConfig().skills.cloudWorkspaces.find(p => p.workingDir === workspace).projectSkillsEnabled,false);
  await app.clickSel('[data-act="skills:back"]');
  assert.ok(await app.eval(`document.querySelector('[data-skill-row="global-guide"] [role="switch"]')?.getAttribute('aria-checked') === 'true'`));
  await app.clickSel('[data-act="skills:project"]');
  await app.waitFor(`document.querySelector('[data-act="skills:project"]')?.textContent.includes('Disable project')`, 'bulk enable');
  console.log('PASS discovery, detail and all scope controls');
  await app.screenshot(join(root,'skills.png'));
  await app.press('Escape');
  await app.clickSel('[data-act="palette"]'); await app.clickSel('#palq'); await app.type('openspec');
  await app.waitFor(`document.querySelector('#pallist')?.textContent.includes('openspec-explore')`, 'skill in command palette');
  await app.clickText('openspec-explore', {scope:'#pallist'});
  await app.waitFor(`document.querySelector('#entry')?.value === '/openspec-explore '`, 'palette prepares skill command');
  await app.clickSel('#entry');
  await app.press('Backspace');
  for (let i=0; i<'/openspec-explore'.length; i++) await app.press('Backspace');
  await app.type('/openspec');
  await app.waitFor(`document.querySelector('[data-slash="openspec-explore"]')`, 'skill slash completion');
  assert.equal(await app.eval(`document.querySelector('#entry').value`), '/openspec');
  assert.equal(await app.eval(`!!document.querySelector('[data-slash="manual-only"]')`),false);
  await app.screenshot(join(root,'slash-skills.png'));
  await app.clickSel('[data-slash="openspec-explore"]');
  // Disable behind an already displayed command. Enter must read fresh policy.
  execFileSync(process.execPath,[cli,'skill','disable','openspec-explore','--workspace',workspace],{env,stdio:'ignore'});
  await app.press('Enter');
  await app.waitFor(`document.querySelector('#toasts')?.textContent.includes('Skill unavailable')`, 'stale command blocked');
  assert.equal(prompts.length,0);
  execFileSync(process.execPath,[cli,'skill','enable','openspec-explore','--workspace',workspace],{env,stdio:'ignore'});
  console.log('PASS stale slash blocked; invoking current skill');
  await app.press('Enter');
  await app.waitFor(`document.querySelector('#content')?.textContent.includes('Workspace skill loaded successfully')`, 'real runtime skill.view then reply',{timeout:90000});
  console.log('PASS inference and skill.view');
  assert.ok(prompts[0].includes('skill.view({"name":"openspec-explore"})'));
  assert.ok(prompts[1].includes('PROJECT A BODY'));
  assert.ok(!prompts[1].includes('SHADOWED BODY'));
  await app.close(); app = null;
  // The same user config, another workspace: project disable cannot leak.
  execFileSync(process.execPath,[cli,'skill','disable','global-guide','--workspace',workspace],{env,stdio:'ignore'});
  app = await launch({port:Number(process.env.ATAG_SKILLS_PORT || 9487),stateDir,workspace:other,verbose:false});
  await app.waitFor(`document.querySelector('#entry')`, 'second workspace ready',{timeout:90000});
  await app.clickSel('[data-act="settings:open"]'); await app.clickSel('[data-act="settings:skills"]');
  await app.waitFor(`document.querySelector('[data-skill-row="other-project"]')`, 'Pi skill in second workspace',{timeout:60000});
  assert.equal(await app.eval(`!!document.querySelector('[data-skill-row="openspec-explore"]')`),false);
  assert.ok(await app.eval(`document.querySelector('[data-skill-row="global-guide"] [role="switch"]')?.getAttribute('aria-checked') === 'true'`));
  console.log(`PASS desktop cloud workspace skills: discovery, source, scopes, stale invocation, skill.view, workspace isolation. Artifacts: ${root}`);
} catch (error) {
  console.error('Artifacts:', root);
  if (app) { console.error(app.output().slice(-5000)); await app.screenshot(join(root,'failure.png')).catch(()=>{}); }
  throw error;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
