from pathlib import Path
import json
root=Path('/tmp/atomic-e2e-tui')
rows=json.loads((root/'results.json').read_text())+json.loads((root/'navigation-results.json').read_text())
for r in rows:
 assert r['exitCode']==0 and not r['forcedTermination'],r
 assert all(r[k] for k in ['altEntered','altExited','mouseEnabled','mouseDisabled']),r
nav=rows[-1];assert nav['icanonRestored'] and nav['echoRestored'],nav
assert 'Local models' in (root/'onboarding/full.txt').read_text()
assert 'Cloud models' in (root/'onboarding/full.txt').read_text()
assert 'Custom endpoint' in (root/'onboarding/full.txt').read_text()
assert '/onboarding (aliases: /setup)' in (root/'main/full.txt').read_text()
for name in ['MCP','Skills','Privacy']:
 assert 'MANAGE ▸ '+name in (root/'navigation/full.txt').read_text(),name
report={'status':'PASS','node':'v25.7.0','target':'actual dist/cli/index.js process in Python pty','terminal':{'TERM':'xterm-256color','columns':100,'rows':32},'scenarios':rows,'limits':['No LLM generation, no real MCP server, no cloud credentials, no downloads, no mouse coordinates/resize exercise; startup/input/navigation/shutdown only.','Raw ANSI and flattened output saved; no native terminal screenshot or visual layout evaluation.','First attempts used invalid harness paste or sent slash commands while manage tab owned input; corrected to text + separate Enter and Esc back to Run.']}
(root/'verified-results.json').write_text(json.dumps(report,indent=2));print('PASS 3 TUI process smoke scenarios')
