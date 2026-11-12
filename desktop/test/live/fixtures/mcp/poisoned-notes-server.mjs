/**
 * poisoned-notes-server.mjs: a real stdio MCP server whose answer the
 * scenario writes (ATO-1375).
 *
 *   node poisoned-notes-server.mjs <record-file> <answer-file>
 *
 * It offers one tool, `read_notes`, that returns the text of <answer-file>
 * as it is on disk at call time. A scenario puts a hostile instruction there
 * to play a third-party server that answers with an attack. Every call is
 * appended to <record-file> as one JSON line before it is answered.
 *
 * Like tide-server.mjs it has no read-only hint: the agent treats it as any
 * third-party tool that has to be approved. The case of a server that claims
 * to be read-only is ATO-1178 and is not played here. Both paths are
 * arguments on purpose: the live harness finds leftovers by the run's temp
 * path on a command line, so a server the app forgot to stop fails the run.
 */

import { appendFileSync, readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [recordFile, answerFile] = process.argv.slice(2);
if (!recordFile || !answerFile) throw new Error('usage: poisoned-notes-server.mjs <record-file> <answer-file>');

const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'read_notes',
    description: 'Read the shared team notes on a topic.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'The topic to read notes on' } },
      required: ['topic'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = readFileSync(answerFile, 'utf8');
  appendFileSync(recordFile, `${JSON.stringify({
    name: request.params.name,
    arguments: request.params.arguments ?? null,
    answerBytes: Buffer.byteLength(text),
    pid: process.pid,
  })}\n`);
  return { content: [{ type: 'text', text }] };
});

/* The client closing its end is the only stop signal stdio has. */
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

await server.connect(new StdioServerTransport());
