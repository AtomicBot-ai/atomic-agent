/**
 * scripted-model.mjs: a loopback stand-in for llama-server whose answers are
 * written by the scenario.
 *
 * The live tier runs the real window, the real `atag serve` and the real
 * tools. Only the model is replaced, so a run is deterministic and needs no
 * GPU and no cloud key. The wire is llama.cpp's: `/health` and `/props` for
 * the probes, `POST /completion` for inference, SSE when the request streams.
 * The idea comes from scripts/smoke-e2e.mjs.
 *
 * A STEP is one model completion. The agent reads a completion as a JSON array
 * of calls, even for a single call (AGENTS.md: "production grammar emits an
 * array"), so `reply()` and `call()` build exactly that text:
 *
 *   model.script([
 *     call('os.fs.write', { path: 'a.txt', content: 'hi\n', mode: 'replace' }),
 *     'Done.',                         // a bare string is a reply
 *     { ...reply('Slow one'), delay: 300 },
 *     { hold: true },                  // never answers; a cancel closes it
 *     { content: 'not valid JSON' },   // exact bytes, for the repair path
 *   ]);
 *
 * Only the agent loop's own completions consume a step. Those are recognised
 * by the tool-call grammar they carry. Anything else that reaches
 * `/completion` (the session title, which sends an empty grammar) is recorded
 * as auxiliary and answered without touching the queue.
 *
 * A step queue that runs out does not hang and does not quietly return an
 * error the app might swallow: `whenBroken` rejects with the request shown,
 * and the harness fails the scenario on that.
 *
 * ROUTES are for requests that arrive in no fixed order, such as Fusion
 * workers calling the model at the same time. The first route whose `match`
 * hits a request owns it; a request no route matches takes the queue.
 *
 *   model.route([
 *     { name: 'alpha', match: /TASK alpha:/, steps: [call(...), reply('ok')] },
 *     { name: 'loop', match: () => true, steps: (record, n) => call(...) },
 *   ]);
 *
 * `match` is a string, a RegExp or a function of the request record. `steps`
 * is a list, which counts towards `pending`, or a function that answers
 * forever, for a scenario whose point is that the app stops asking.
 *
 * `serveChat()` opens the OpenAI-style `/v1/chat/completions` route, for a
 * provider of kind `openai-compatible`. It takes the same steps, sends them as
 * native tool calls, and reports `usage`, which is what the agent prices. Until
 * it is called, reaching that route fails the scenario, as it always did.
 */

import { createServer } from 'node:http';

/** One tool call, in the exact text the agent parses. */
export const call = (tool, args) => ({ content: JSON.stringify([{ tool, args }]) });
/** Several tool calls in one completion. */
export const calls = (list) => ({ content: JSON.stringify(list.map(({ tool, args }) => ({ tool, args }))) });
/** A reply to the person, which ends the turn. */
export const reply = (text) => call('reply', { text });

/* The literal `"tool"` key as it is spelled inside the GBNF source
   (grammars/tool-call.gbnf), which is backslash-quote on the wire. */
const AGENT_GRAMMAR_MARK = '\\"tool\\"';
const AUX_TEXT = 'Live smoke session';
const CHUNK = 13;

function normalize(step) {
  if (typeof step === 'string') return reply(step);
  if (step && step.hold === true) return { hold: true };
  if (step && typeof step.content === 'string') {
    return { content: step.content, ...(step.delay ? { delay: step.delay } : {}) };
  }
  throw new Error(`scripted model: not a step: ${JSON.stringify(step)}. `
    + 'Use a string, reply(), call(), calls(), { content }, or { hold: true }');
}

/** The text of a request on either route, for matching and for assertions. */
export const requestText = (record) => (typeof record.prompt === 'string' ? record.prompt : JSON.stringify(record.messages ?? ''));

function routeHits(match, record) {
  if (typeof match === 'function') return !!match(record);
  if (match instanceof RegExp) return match.test(requestText(record));
  return requestText(record).includes(String(match));
}

/* A step as native tool calls, or null when it is plain text. Dots are not
   allowed in an OpenAI function name; the agent escapes them the same way
   (src/llm/provider/openai/openai-tool-call-adapter.ts). */
function chatToolCalls(content, nextId) {
  let list;
  try { list = JSON.parse(content); } catch { return null; }
  if (!Array.isArray(list) || !list.length || !list.every((c) => c && typeof c.tool === 'string')) return null;
  return list.map((c, index) => ({ index, id: nextId(), type: 'function',
    function: { name: c.tool.replace(/\./g, '__'), arguments: JSON.stringify(c.args ?? {}) } }));
}

const ending = (text, n = 1500) => {
  const s = String(text ?? '');
  return s.length > n ? `[...${s.length - n} characters...]${s.slice(-n)}` : s;
};

/**
 * Start the server on an ephemeral loopback port.
 *
 * `requests` is every inference body in arrival order. Each entry has `kind`
 * ('agent' or 'auxiliary'), `prompt`, `messages`, `stream`, the whole `body`,
 * and `disconnected` once the client hung up before the answer was finished.
 * `other` lists the probes and anything else that was not inference.
 */
export async function startScriptedModel() {
  let queue = [];
  let routes = [];
  let chat = null;
  let totalSlots = 1;
  let callIds = 0;
  let consumed = 0;
  let broken = null;
  let closed = false;
  let rejectBroken;
  const whenBroken = new Promise((_, rej) => { rejectBroken = rej; });
  whenBroken.catch(() => {}); // a scenario that never looks must not crash the runner
  const requests = [];
  const other = [];
  const open = new Set();
  const sockets = new Set();
  const timers = new Set();

  function breakWith(message) {
    process.stderr.write(`\n[scripted-model] ${message}\n`);
    if (broken) return;
    broken = new Error(message);
    rejectBroken(broken);
  }

  const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  function answer(res, body, content) {
    if (res.destroyed) return;
    const stats = { tokens_cached: 0, tokens_evaluated: 100, tokens_predicted: 15, slot_id: 0,
      truncated: false, model: 'live-plain',
      timings: { prompt_ms: 1, predicted_ms: 1, prompt_n: 100, predicted_n: 15 } };
    if (!body.stream) { json(res, 200, { content, stop: true, ...stats }); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let at = 0; at < content.length; at += CHUNK) {
      res.write(`data: ${JSON.stringify({ content: content.slice(at, at + CHUNK), stop: false, ...stats })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ content: '', stop: true, ...stats })}\n\ndata: [DONE]\n\n`);
    res.end();
  }

  function answerChat(res, body, content) {
    if (res.destroyed) return;
    const toolCalls = chatToolCalls(content, () => `call_${++callIds}`);
    const model = typeof body.model === 'string' ? body.model : 'live-plain';
    const usage = chat.usage;
    const finish = toolCalls ? 'tool_calls' : 'stop';
    if (!body.stream) {
      json(res, 200, { id: 'live-chat', model, usage, choices: [{ index: 0, finish_reason: finish,
        message: { role: 'assistant', content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (chunk) => res.write(`data: ${JSON.stringify({ id: 'live-chat', model, ...chunk })}\n\n`);
    if (toolCalls) {
      for (const tool of toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    send({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /* The owning route's next step, `undefined` when no route wants this
     request, or `null` when the route ran dry and the run is already broken. */
  function routedStep(record) {
    const route = routes.find((r) => routeHits(r.match, record));
    if (!route) return undefined;
    route.used += 1;
    record.route = route.name;
    if (typeof route.steps === 'function') return normalize(route.steps(record, route.used));
    const step = route.steps.shift();
    if (step !== undefined) return step;
    breakWith(`route "${route.name}" ran out: request #${record.n} arrived after its ${route.used - 1} step(s) were used.\n`
      + `  request ended with:\n${ending(requestText(record))}`);
    return null;
  }

  async function inference(req, res, raw) {
    let body;
    try { body = JSON.parse(raw); } catch {
      breakWith(`${req.method} ${req.url} sent a body that is not JSON: ${ending(raw, 400)}`);
      res.writeHead(400); res.end('not JSON');
      return;
    }
    const onChat = req.url.startsWith('/v1/chat/completions');
    /* On the chat route the agent loop is the caller that sends a tool list. */
    const isAgentStep = onChat && chat
      ? Array.isArray(body.tools) && body.tools.length > 0
      : typeof body.grammar === 'string' && body.grammar.includes(AGENT_GRAMMAR_MARK);
    const record = { n: requests.length + 1, kind: isAgentStep ? 'agent' : 'auxiliary', method: req.method, url: req.url,
      stream: !!body.stream, prompt: body.prompt, messages: body.messages, body, disconnected: false, at: Date.now() };
    requests.push(record);
    open.add(record);
    res.on('close', () => { record.disconnected = !res.writableEnded; record.closedAt = Date.now(); open.delete(record); });

    /* This tier points the agent at the grammar route, where the chat endpoint
       is only used for vision. Reaching it means the route is not the one the
       harness set up, so say so rather than guess at an answer. A scenario that
       wants this route says so with serveChat(). */
    if (onChat && !chat) {
      breakWith(`the app called ${req.url}, but this tier configures the /completion route. `
        + `Request body ended with: ${ending(raw, 800)}`);
      res.writeHead(500); res.end('unexpected route');
      return;
    }
    const respond = onChat ? answerChat : answer;
    if (!isAgentStep) { respond(res, body, AUX_TEXT); return; }

    const routed = routedStep(record);
    if (routed === null) { res.writeHead(500); res.end('scripted model: this route has no step left'); return; }
    const step = routed === undefined ? queue.shift() : routed;
    if (step === undefined) {
      breakWith(`the script ran out: agent request #${record.n} arrived after all ${consumed} step(s) were used.\n`
        + `  stream=${record.stream}\n  prompt ended with:\n${ending(body.prompt)}`);
      res.writeHead(500); res.end('scripted model: no step left for this request');
      return;
    }
    consumed += 1;
    record.step = consumed;
    if (step.hold) { record.held = true; return; }
    if (step.delay) {
      const t = setTimeout(() => { timers.delete(t); respond(res, body, step.content); }, step.delay);
      timers.add(t);
      return;
    }
    respond(res, body, step.content);
  }

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'POST' && (req.url === '/completion' || req.url.startsWith('/v1/chat/completions'))) {
      await inference(req, res, raw);
      return;
    }
    const path = req.url.split('?')[0];
    const probes = {
      '/health': { status: 'ok' },
      '/props': { model_path: 'live-plain.gguf', default_generation_settings: { n_ctx: 32768 }, total_slots: totalSlots },
      '/slots': [],
      '/v1/models': { object: 'list', data: [{ id: 'live-plain', object: 'model' }] },
    };
    const known = req.method === 'GET' && Object.hasOwn(probes, path);
    other.push({ method: req.method, url: req.url, status: known ? 200 : 404 });
    if (known) { json(res, 200, probes[path]); return; }
    /* `/apply-template` and the embedding routes land here. A 404 is what the
       agent falls back from, and none of them can touch the step queue. */
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const { port } = server.address();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    other,
    whenBroken,
    get broken() { return broken; },
    /** What the agent loop asked for, without the auxiliary requests. */
    get agentRequests() { return requests.filter((r) => r.kind === 'agent'); },
    /** Steps not consumed yet. */
    get pending() { return queue.length + routes.reduce((n, r) => n + (Array.isArray(r.steps) ? r.steps.length : 0), 0); },
    /** The slot count `/props` reports. Set it before the window opens. */
    get totalSlots() { return totalSlots; },
    set totalSlots(n) { totalSlots = n; },
    /** Answer `/v1/chat/completions` from now on, reporting this `usage` on every completion. */
    serveChat({ promptTokens = 100, completionTokens = 15 } = {}) {
      chat = { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } };
    },
    /** Set the routes. See the header. */
    route(list) {
      routes = list.map(({ name, match, steps }) => ({ name, match, used: 0,
        steps: typeof steps === 'function' ? steps : steps.map(normalize) }));
    },
    /** Requests the server has not finished answering, held ones included. */
    get inFlight() { return open.size; },
    /** Set the next steps. A script that was not fully used is an error. */
    script(steps) {
      if (queue.length) throw new Error(`scripted model: ${queue.length} step(s) from the previous script were never used`);
      queue = steps.map(normalize);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await new Promise((res) => server.close(res));
    },
  };
}
