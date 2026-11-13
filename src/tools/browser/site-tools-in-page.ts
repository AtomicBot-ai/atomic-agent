/**
 * WebMCP in the agent's page (ATO-521). A site declares tools for agents
 * with `document.modelContext.registerTool(...)` (the W3C Web Machine
 * Learning draft) or the older `navigator.modelContext` shape
 * (`provideContext` / `registerTool` / `unregisterTool` / `clearContext`).
 *
 * The scripts below are JS source strings, not functions: the SEA bundle
 * keeps names (`keepNames`), which would wrap nested helpers in
 * `__name(...)` calls the page does not have. A string is sent as is.
 *
 * - {@link SITE_TOOLS_INIT_SCRIPT} runs before the page's own scripts
 *   (Playwright init script). It records every tool the page registers,
 *   through the browser's own `modelContext` when there is one (it wraps
 *   the methods and still calls them) and through a small stand-in when
 *   there is none, so a site written for WebMCP works today.
 * - {@link listSiteToolsExpression} / {@link callSiteToolExpression} read
 *   and run them. A page that registered nothing through us is asked
 *   with the browser's own `getTools` / `executeTool`, then Chrome's
 *   testing API (`navigator.modelContextTesting`).
 *
 * Everything the page hands back is untrusted: the Node side checks
 * names, sizes and schemas (`site-tools-sanitize.ts`) and frames the text
 * as outside data.
 */

/** Hidden global the init script keeps the recorded tools in. */
export const SITE_TOOLS_REGISTRY_KEY = "__atomicAgentSiteTools";

export const SITE_TOOLS_INIT_SCRIPT = String.raw`(() => {
  const g = globalThis;
  const KEY = "${SITE_TOOLS_REGISTRY_KEY}";
  if (g[KEY]) return;
  const tools = new Map();
  const registry = { tools: tools, changes: 0 };
  try {
    Object.defineProperty(g, KEY, { value: registry, enumerable: false, configurable: false, writable: false });
  } catch (e) {
    return;
  }
  const record = (tool, signal) => {
    if (!tool || typeof tool !== "object") return;
    let name;
    try { name = tool.name; } catch (e) { return; }
    if (typeof name !== "string" || typeof tool.execute !== "function") return;
    tools.set(name, tool);
    registry.changes += 1;
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", () => {
        if (tools.get(name) === tool) { tools.delete(name); registry.changes += 1; }
      });
    }
  };
  const forget = (name) => { if (tools.delete(String(name))) registry.changes += 1; };
  const clearAll = () => { tools.clear(); registry.changes += 1; };
  const describe = (tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  });
  const install = (mc, native) => {
    const orig = {
      registerTool: native ? mc.registerTool : null,
      unregisterTool: native ? mc.unregisterTool : null,
      provideContext: native ? mc.provideContext : null,
      clearContext: native ? mc.clearContext : null,
    };
    const define = (key, value) => {
      try { Object.defineProperty(mc, key, { value: value, configurable: true, writable: true }); } catch (e) {}
    };
    define("registerTool", function (tool, options) {
      record(tool, options && options.signal);
      const name = tool && tool.name;
      if (typeof orig.registerTool === "function") {
        try {
          return orig.registerTool.call(mc, tool, options);
        } catch (e) {
          forget(name);
          throw e;
        }
      }
      const done = Promise.resolve(undefined);
      done.unregister = () => forget(name);
      return done;
    });
    define("unregisterTool", function (name) {
      forget(name);
      if (typeof orig.unregisterTool === "function") return orig.unregisterTool.call(mc, name);
      return undefined;
    });
    define("provideContext", function (context) {
      clearAll();
      const list = context && Array.isArray(context.tools) ? context.tools : [];
      for (const tool of list) record(tool, undefined);
      if (typeof orig.provideContext === "function") return orig.provideContext.call(mc, context);
      return undefined;
    });
    define("clearContext", function () {
      clearAll();
      if (typeof orig.clearContext === "function") return orig.clearContext.call(mc);
      return undefined;
    });
    if (!native) {
      define("getTools", function () {
        return Promise.resolve(Array.from(tools.values()).map(describe));
      });
      define("executeTool", function (tool, input) {
        const name = tool && typeof tool === "object" ? tool.name : tool;
        const found = tools.get(String(name));
        if (!found) return Promise.reject(new Error("unknown tool"));
        return Promise.resolve().then(() => found.execute(input, {}));
      });
    }
  };
  let fallback = null;
  const ensureFallback = () => {
    if (fallback) return fallback;
    fallback = typeof EventTarget === "function" ? new EventTarget() : {};
    install(fallback, false);
    return fallback;
  };
  for (const owner of [g.document, g.navigator]) {
    if (!owner) continue;
    let existing = null;
    try { existing = owner.modelContext; } catch (e) { existing = null; }
    if (existing && typeof existing === "object") {
      install(existing, true);
    } else {
      try {
        Object.defineProperty(owner, "modelContext", { value: ensureFallback(), configurable: true, enumerable: true, writable: false });
      } catch (e) {}
    }
  }
})();`;

/** Limits the list script applies in the page, so a huge declaration never crosses over. */
export interface ListSiteToolsInPageArg {
  maxScan: number;
  maxSchemaChars: number;
  maxDescriptionChars: number;
}

const LIST_SITE_TOOLS_SOURCE = String.raw`async (arg) => {
  const g = globalThis;
  const reg = g["${SITE_TOOLS_REGISTRY_KEY}"];
  let list = [];
  if (reg && reg.tools && reg.tools.size > 0) {
    list = Array.from(reg.tools.values());
  } else {
    const mc = g.document && g.document.modelContext;
    if (mc && typeof mc.getTools === "function") {
      try { list = Array.from(await mc.getTools()); } catch (e) { list = []; }
    }
    const testing = g.navigator && g.navigator.modelContextTesting;
    if (list.length === 0 && testing && typeof testing.listTools === "function") {
      try { list = Array.from(await testing.listTools()); } catch (e) { list = []; }
    }
  }
  const out = [];
  for (const tool of list.slice(0, arg.maxScan)) {
    try {
      if (!tool || typeof tool !== "object") continue;
      let schema = null;
      const raw = tool.inputSchema;
      if (typeof raw === "string") schema = raw;
      else if (raw !== undefined && raw !== null) {
        try { schema = JSON.stringify(raw); } catch (e) { schema = "\u0000"; }
      }
      const notes = tool.annotations && typeof tool.annotations === "object" ? tool.annotations : {};
      out.push({
        name: typeof tool.name === "string" ? tool.name.slice(0, 200) : "",
        title: typeof tool.title === "string" ? tool.title.slice(0, 400) : "",
        description: typeof tool.description === "string" ? tool.description.slice(0, arg.maxDescriptionChars + 1) : "",
        inputSchema: typeof schema === "string" ? schema.slice(0, arg.maxSchemaChars + 1) : null,
        readOnlyHint: notes.readOnlyHint === true,
      });
    } catch (e) {}
  }
  return { total: list.length, tools: out };
}`;

/** `page.evaluate` source that lists the page's tools (`arg` is inlined as JSON). */
export function listSiteToolsExpression(arg: ListSiteToolsInPageArg): string {
  return `(${LIST_SITE_TOOLS_SOURCE})(${JSON.stringify(arg)})`;
}

export interface CallSiteToolInPageArg {
  name: string;
  argsJson: string;
  timeoutMs: number;
  maxResultChars: number;
  /** Approved host; the tool runs only while the page is still on it. */
  host?: string;
}

const CALL_SITE_TOOL_SOURCE = String.raw`async (arg) => {
  const g = globalThis;
  const reg = g["${SITE_TOOLS_REGISTRY_KEY}"];
  if (typeof arg.host === "string") {
    let here = "";
    try { here = String(g.location.hostname).trim().toLowerCase().replace(/\.+$/, ""); } catch (e) { here = ""; }
    if (here !== arg.host) return { ok: false, error: "wrong_host" };
  }
  let input;
  try { input = JSON.parse(arg.argsJson); } catch (e) { return { ok: false, error: "bad_args" }; }
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const signal = ctrl ? ctrl.signal : undefined;
  let run = null;
  const captured = reg && reg.tools ? reg.tools.get(arg.name) : undefined;
  if (captured) {
    run = Promise.resolve().then(() => captured.execute(input, {
      signal: signal,
      requestUserInteraction: (callback) => Promise.resolve().then(() => callback()),
    }));
  } else {
    const mc = g.document && g.document.modelContext;
    const testing = g.navigator && g.navigator.modelContextTesting;
    if (mc && typeof mc.getTools === "function" && typeof mc.executeTool === "function") {
      run = Promise.resolve(mc.getTools()).then((all) => {
        const found = Array.from(all).find((tool) => tool && tool.name === arg.name);
        if (!found) throw { atomicNotFound: true };
        return mc.executeTool(found, input, signal ? { signal: signal } : {});
      });
    } else if (testing && typeof testing.executeTool === "function") {
      run = Promise.resolve().then(() => testing.executeTool(arg.name, arg.argsJson));
    }
  }
  if (!run) return { ok: false, error: "not_found" };
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      reject({ atomicTimeout: true });
    }, arg.timeoutMs);
  });
  let value;
  try {
    value = await Promise.race([run, timeout]);
  } catch (e) {
    if (timer !== null) clearTimeout(timer);
    if (e && e.atomicTimeout === true) return { ok: false, error: "timeout" };
    if (e && e.atomicNotFound === true) return { ok: false, error: "not_found" };
    let message = "";
    try { message = String((e && e.message) || e); } catch (e2) { message = ""; }
    return { ok: false, error: "threw", message: message.slice(0, 500) };
  }
  if (timer !== null) clearTimeout(timer);
  let text = "";
  let isError = false;
  try {
    if (typeof value === "string") text = value;
    else if (value === undefined || value === null) text = "";
    else if (typeof value === "object" && Array.isArray(value.content)) {
      isError = value.isError === true;
      text = value.content.map((item) => {
        if (item && item.type === "text" && typeof item.text === "string") return item.text;
        if (item && typeof item.type === "string") return "[" + item.type.slice(0, 40) + " content not shown]";
        return "";
      }).join("\n");
    } else text = JSON.stringify(value);
  } catch (e) {
    text = "[the result could not be read]";
  }
  if (typeof text !== "string") text = "";
  return { ok: true, isError: isError, text: text.slice(0, arg.maxResultChars + 1) };
}`;

/** `page.evaluate` source that runs one tool (`arg` is inlined as JSON). */
export function callSiteToolExpression(arg: CallSiteToolInPageArg): string {
  return `(${CALL_SITE_TOOL_SOURCE})(${JSON.stringify(arg)})`;
}
