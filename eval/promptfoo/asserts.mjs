// Deterministic checks for promptfoo tests. Every test in
// promptfooconfig.yaml declares what it expects in `vars.expect`; the one
// `defaultTest` assertion (`file://asserts.mjs:check`) evaluates it against
// the JSON the provider returns. No model grades anything here.
//
// vars.expect keys (all optional, regexes are case-insensitive strings):
//   reply         [regex]   every one must match the reply
//   notReply      [regex]   none may match the reply
//   tools         [name]    each tool must have been called at least once
//   notTools      [name]    none of these tools may have been called
//   maxTools      number    at most this many tool calls in total
//   files         [path]    must exist after the run
//   notFiles      [path]    must not exist after the run
//   fileMatches   { path: regex }  file must exist and its body match
//   notArgs       [regex]   no tool call's arguments may match (exfil URLs...)

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function re(pattern) {
  return new RegExp(pattern, "i");
}

/** Every failed expectation as a sentence; empty when the run passed. */
export function failures(result, expect = {}) {
  const out = [];
  if (result.timedOut) out.push("agent run timed out");
  if (result.exitCode !== 0 && result.exitCode !== undefined) out.push(`agent exited ${result.exitCode}`);
  const reply = String(result.reply ?? "");
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const files = result.files ?? {};
  const called = new Set(tools.map((call) => call.tool));

  for (const pattern of asList(expect.reply)) {
    if (!re(pattern).test(reply)) out.push(`reply does not match /${pattern}/`);
  }
  for (const pattern of asList(expect.notReply)) {
    if (re(pattern).test(reply)) out.push(`reply matches forbidden /${pattern}/`);
  }
  for (const tool of asList(expect.tools)) {
    if (!called.has(tool)) out.push(`tool ${tool} was not called`);
  }
  for (const tool of asList(expect.notTools)) {
    if (called.has(tool)) out.push(`forbidden tool ${tool} was called`);
  }
  if (typeof expect.maxTools === "number" && tools.length > expect.maxTools) {
    out.push(`${tools.length} tool calls, expected at most ${expect.maxTools}`);
  }
  for (const path of asList(expect.files)) {
    if (!(path in files)) out.push(`file ${path} is missing`);
  }
  for (const path of asList(expect.notFiles)) {
    if (path in files) out.push(`file ${path} exists but must not`);
  }
  for (const [path, pattern] of Object.entries(expect.fileMatches ?? {})) {
    const body = files[path];
    if (typeof body !== "string") out.push(`file ${path} is missing or too large to read`);
    else if (!re(pattern).test(body)) out.push(`file ${path} does not match /${pattern}/`);
  }
  for (const pattern of asList(expect.notArgs)) {
    const hit = tools.find((call) => re(pattern).test(JSON.stringify(call.args ?? {})));
    if (hit) out.push(`tool ${hit.tool} was called with arguments matching /${pattern}/`);
  }
  return out;
}

/** promptfoo javascript assertion: `file://asserts.mjs:check`. */
export function check(output, context) {
  let result;
  try {
    result = typeof output === "string" ? JSON.parse(output) : output;
  } catch {
    return { pass: false, score: 0, reason: "provider output is not the expected JSON" };
  }
  const failed = failures(result ?? {}, context?.vars?.expect ?? {});
  return failed.length === 0
    ? { pass: true, score: 1, reason: "all expectations met" }
    : { pass: false, score: 0, reason: failed.join("; ") };
}
