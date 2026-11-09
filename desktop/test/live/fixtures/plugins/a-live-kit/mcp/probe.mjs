// A minimal MCP server over stdio, one JSON message per line. It leaves a note
// in the file named on its command line, so a test can see whether it started.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.argv[2];
const mark = (what) => appendFileSync(log, `${what}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

mark('started');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'live-probe', version: '1.0.0' } } });
  } else if (m.method === 'tools/list') {
    mark('tools/list');
    send({ id: m.id, result: { tools: [{ name: 'live_ping_4471', description: 'Answers pong.',
      inputSchema: { type: 'object', properties: {} } }] } });
  } else if (m.method === 'tools/call') {
    send({ id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ id: m.id, error: { code: -32601, message: 'no such method' } });
  }
});
lines.on('close', () => process.exit(0));
