// ATO-1146: drag a chat into a project. The pure half of renderer/chat-drag.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chatDropPlan, chatDropZone } = createRequire(import.meta.url)("../renderer/chat-drag.js");

test("a drop on another project moves the chat through the menu's own act", () => {
  assert.deepEqual(chatDropPlan("s1", "p1", ""), { act: "fput:p1:s1", out: false });
  assert.deepEqual(chatDropPlan("s1", "fwork", "p1"), { act: "fput:fwork:s1", out: false });
});

test("a drop on the Chats list takes the chat out of its project", () => {
  assert.deepEqual(chatDropPlan("s1", "", "p1"), { act: "fput::s1", out: true });
});

test("a drop where the chat already is does nothing", () => {
  assert.equal(chatDropPlan("s1", "p1", "p1"), null);
  assert.equal(chatDropPlan("s1", "", ""), null);
  assert.equal(chatDropPlan("s1", "", undefined), null);
});

test("no chat id or no target: nothing", () => {
  assert.equal(chatDropPlan("", "p1", ""), null);
  assert.equal(chatDropPlan("s1", undefined, ""), null);
});

// A tiny stand-in for DOM nodes: closest() matches by a selector table.
const node = (matches, extra = {}) => ({
  closest: (sel) => matches[sel] || null,
  ...extra,
});

test("the zone under the pointer: a header itself, a project's chats, the Chats list", () => {
  const head = { dataset: { fdrop: "p1" } };
  assert.equal(chatDropZone(node({ "#sidebar [data-fdrop]": head })), head);

  const group = { querySelector: (sel) => (sel === "[data-fdrop]" ? head : null) };
  assert.equal(chatDropZone(node({ "#sidebar .sb-project": group })), head);

  const chatsHead = { dataset: { fdrop: "" } };
  const list = { querySelector: () => chatsHead };
  assert.equal(chatDropZone(node({ '#sidebar [data-list="chats"]': list })), chatsHead);

  assert.equal(chatDropZone(node({})), null);
  assert.equal(chatDropZone(null), null);
});

test("wiring: one set of drag listeners, loaded after the projects and before renderer.js", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at("chat-drag.js") > at("chat-projects.js") && at("chat-projects.js") > 0);
  assert.ok(at("chat-drag.js") < at("renderer.js"));
  const folders = readFileSync(new URL("../renderer/chat-folders.js", import.meta.url), "utf8");
  assert.match(folders, /const FOLDER_DRAG_TYPE = 'application\/x-atomic-chat';/);
  assert.doesNotMatch(folders, /addEventListener\('dragstart'/);
});
