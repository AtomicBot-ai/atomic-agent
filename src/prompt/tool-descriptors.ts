import type { ToolDescriptor } from "./stable-prefix.js";

/**
 * JSON-Schema-ish descriptors for every tool registered by default.
 * We keep them as plain strings (compact JSON) instead of full JSON Schema
 * trees so the stable prefix stays readable and cheap to tokenise. The
 * descriptors mirror the validation performed at runtime inside each tool
 * — they are the contract for the LLM.
 */
export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "browser.navigate",
    summary: "Open a URL in the controlled browser tab.",
    argsSchema: '{"url": "string"}',
  },
  {
    name: "browser.click",
    summary: "Click on a snapshot element by its aria-ref identifier.",
    argsSchema: '{"ref": "string (from latest read_aria)"}',
  },
  {
    name: "browser.type",
    summary: "Type text into a snapshot element; optionally press Enter.",
    argsSchema:
      '{"ref": "string", "text": "string", "pressEnter": "bool (optional)"}',
  },
  {
    name: "browser.read_aria",
    summary: "Capture the current page as a compact ARIA text snapshot.",
    argsSchema: "{}",
  },
  {
    name: "browser.search",
    summary: "Run a high-level web search and return the result page.",
    argsSchema: '{"query": "string", "engine": "string (optional)"}',
  },
  {
    name: "browser.tabs",
    summary: "Manage browser tabs.",
    argsSchema:
      '{"action": "list|switch|close|new", "index": "number (optional)", "url": "string (optional)"}',
  },
  {
    name: "browser.scroll",
    summary:
      "Scroll the active page up/down/top/bottom. Does not refresh ARIA; call browser.read_aria after to observe new content.",
    argsSchema:
      '{"direction": "up|down|top|bottom", "amount": "page|half|number (optional)"}',
  },
  {
    name: "os.shell.run",
    summary: "Run an OS command in the working directory (requires approval).",
    argsSchema:
      '{"cmd": "string", "args": "string[]", "cwd": "string (optional)", "timeoutMs": "number (optional)"}',
  },
  {
    name: "os.fs.read",
    summary: "Read a UTF-8 text file.",
    argsSchema: '{"path": "string", "maxBytes": "number (optional)"}',
  },
  {
    name: "os.fs.write",
    summary: "Write content to a file (requires approval).",
    argsSchema:
      '{"path": "string", "content": "string", "mode": "replace|append (optional)"}',
  },
  {
    name: "os.fs.list",
    summary: "List entries in a directory.",
    argsSchema: '{"path": "string", "maxEntries": "number (optional)"}',
  },
  {
    name: "os.clipboard.read",
    summary: "Read the system clipboard as text.",
    argsSchema: "{}",
  },
  {
    name: "os.clipboard.write",
    summary: "Write text to the system clipboard.",
    argsSchema: '{"value": "string"}',
  },
  {
    name: "os.window.list",
    summary: "List visible window titles on the host OS.",
    argsSchema: "{}",
  },
  {
    name: "os.window.focus",
    summary: "Focus a window whose title contains the given substring.",
    argsSchema: '{"title": "string"}',
  },
  {
    name: "os.notify",
    summary: "Show a system notification (title + message).",
    argsSchema:
      '{"title": "string", "message": "string", "sound": "bool (optional)"}',
  },
  {
    name: "skill.view",
    summary:
      "Load the body of an installed skill into the session (progressive loading).",
    argsSchema: '{"name": "string"}',
  },
  {
    name: "skill.run_script",
    summary:
      "Run a script declared in a skill's requires_scripts (requires approval).",
    argsSchema:
      '{"skill": "string", "script": "string", "args": "string[] (optional)", "timeoutMs": "number (optional)"}',
  },
  {
    name: "reply",
    summary:
      "Send the FINAL natural-language answer to the user. Ends the current turn — the session stays open for the next user message. NEVER use `reply` to announce an action you are about to take (e.g. do NOT write 'I will now click X'); emit that action's tool call directly instead. Call only when the task is fully done, it is small-talk, or you need a clarifying question from the user.",
    argsSchema: '{"text": "string"}',
  },
  {
    name: "finish",
    summary:
      "Close the whole session with a final summary. Use only when the user explicitly asks to end the session.",
    argsSchema: '{"summary": "string"}',
  },
];
