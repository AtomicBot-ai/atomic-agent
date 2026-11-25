/** Test helper: a minimal ChatGPT `conversations.json` with one chat of the person's messages. */
export function chatGptExportFixture(userTexts: readonly string[], nowMs = Date.now()): unknown[] {
  const t = Math.floor(nowMs / 1000) - 3600;
  const mapping: Record<string, unknown> = { root: { id: "root", parent: null, children: ["m0"], message: null } };
  let parent = "root";
  userTexts.forEach((text, i) => {
    const id = `m${i}`;
    mapping[id] = {
      id,
      parent,
      children: i + 1 < userTexts.length ? [`m${i + 1}`] : [],
      message: { author: { role: "user" }, create_time: t + i, content: { content_type: "text", parts: [text] }, metadata: {} },
    };
    parent = id;
  });
  return [{ id: "chat-1", title: "t", create_time: t, current_node: parent, mapping }];
}
