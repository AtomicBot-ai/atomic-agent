/**
 * tide-server.mjs: a real stdio MCP server for the live smoke tier.
 *
 *   node tide-server.mjs <record-file>
 *
 * It offers one tool, `lookup_tide`, with no read-only hint, so the agent
 * treats it like any third-party tool that has to be approved. Every call is
 * appended to <record-file> as one JSON line before it is answered, and the
 * answer carries a value made up here at call time. A prompt holding that
 * value can only have got it from this process.
 *
 * The record path is passed as an argument on purpose: the live harness finds
 * leftovers by the run's temp path on a command line, so a server the app
 * forgot to stop fails the scenario.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const recordFile = process.argv[2];
if (!recordFile) throw new Error('usage: tide-server.mjs <record-file>');

const server = new Server({ name: 'tides', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'lookup_tide',
    description: 'Look up the next high water for a port.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'string', description: 'The port to look up' } },
      required: ['port'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const answer = `high-water-${randomUUID()}`;
  appendFileSync(recordFile, `${JSON.stringify({
    name: request.params.name,
    arguments: request.params.arguments ?? null,
    answer,
    pid: process.pid,
  })}\n`);
  return { content: [{ type: 'text', text: `Next tide: ${answer}` }] };
});

/* The client closing its end is the only stop signal stdio has. */
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

await server.connect(new StdioServerTransport());
