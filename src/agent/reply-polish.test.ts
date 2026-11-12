import { describe, expect, it } from "vitest";

import {
  polishReply,
  replyChannelForAnswer,
  splitFences,
  tablesToLists,
  type PolishReplyOptions,
} from "./reply-polish.js";

const HOME = "/Users/me";
const tui: PolishReplyOptions = { channel: "tui", homeDir: HOME };
const small: PolishReplyOptions = { channel: "tui", smallModel: true, homeDir: HOME };
const telegram: PolishReplyOptions = { channel: "telegram", homeDir: HOME };

describe("polishReply: safety", () => {
  it("returns empty and blank input unchanged", () => {
    expect(polishReply("", tui)).toBe("");
    expect(polishReply("   \n\n", tui)).toBe("   \n\n");
  });

  it("leaves a clean reply byte-for-byte", () => {
    const clean = "The build passes.\n\n- `npm test`: 412 passed\n- lint: clean\n\nNext I will open the PR.";
    expect(polishReply(clean, tui)).toBe(clean);
    expect(polishReply(clean, telegram)).toBe(clean);
    expect(polishReply(clean, small)).toBe(clean);
  });

  it("never returns an empty string for a reply made only of filler", () => {
    expect(polishReply("I hope this helps!", tui)).toBe("I hope this helps!");
    expect(polishReply("Sure!", tui)).toBe("Sure!");
    expect(polishReply("Great question!", tui)).toBe("Great question!");
  });

  it("returns the input when a pass throws", () => {
    const hostile = { channel: "tui" } as PolishReplyOptions;
    Object.defineProperty(hostile, "smallModel", {
      get() {
        throw new Error("boom");
      },
    });
    expect(polishReply("a\n\n\n\nb", hostile)).toBe("a\n\n\n\nb");
  });

  it("normalises CRLF line endings", () => {
    expect(polishReply("text\r\n\r\n\r\n\r\nmore", tui)).toBe("text\n\nmore");
  });
});

describe("polishReply: code is never rewritten", () => {
  it("treats a fence indented four or more spaces as code", () => {
    const reply =
      "1. Step one\n    - run:\n\n      ```sh\n      cd /Users/me/projects/atomic/src/agent/deep/folder\n      ```\n\nDone.";
    expect(polishReply(reply, tui)).toBe(reply);
    const segs = splitFences(reply);
    expect(segs.some((s) => s.kind === "code" && s.text.includes("cd /Users/me/projects"))).toBe(true);
  });

  it("keeps blank lines, repeats and filler inside a fenced block", () => {
    const reply = [
      "Here is the script:",
      "",
      "```sh",
      "echo hi",
      "echo hi",
      "echo hi",
      "",
      "",
      "",
      "# I hope this helps!",
      "cat /Users/me/projects/atomic-agent/src/agent/reply-polish.ts",
      "```",
    ].join("\n");
    expect(polishReply(reply, small)).toBe(reply);
  });

  it("keeps a table inside a fence on Telegram", () => {
    const reply = "Raw output:\n\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(polishReply(reply, telegram)).toBe(reply);
  });

  it("keeps a long home path inside inline code", () => {
    const reply = "Saved to `/Users/me/projects/atomic-agent/src/agent/reply-polish.ts`.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("closes a fence the model never closed", () => {
    const reply = "Here:\n```ts\nconst a = 1;\n\n\n\nconst b = 2;";
    expect(polishReply(reply, tui)).toBe("Here:\n```ts\nconst a = 1;\n\n\n\nconst b = 2;\n```");
  });

  it("closes a ~~~ fence with its own marker", () => {
    expect(polishReply("Log:\n~~~\nline one\n\n", tui)).toBe("Log:\n~~~\nline one\n~~~");
  });

  it("does not take a shorter inner fence as the close of a longer one", () => {
    const reply = "````md\n```js\nx\n```\n````\n\nDone.";
    expect(polishReply(reply, tui)).toBe(reply);
  });
});

describe("polishReply: open markup", () => {
  it("closes open bold, strike and code at the end", () => {
    expect(polishReply("Run **this command", tui)).toBe("Run **this command**");
    expect(polishReply("old ~~api", tui)).toBe("old ~~api~~");
    expect(polishReply("call `foo(", tui)).toBe("call `foo(`");
  });

  it("drops a dangling opener with nothing after it", () => {
    expect(polishReply("Done **", tui)).toBe("Done");
  });

  it("keeps a glob or a star at the very end", () => {
    expect(polishReply("Matches everything under src/**", tui)).toBe("Matches everything under src/**");
    expect(polishReply("The pattern is: *", tui)).toBe("The pattern is: *");
  });

  it("does not close a marker inside a word, like x**2", () => {
    expect(polishReply("The area is x**2", tui)).toBe("The area is x**2");
    expect(polishReply("In Python, write 2**10", tui)).toBe("In Python, write 2**10");
  });

  it("does not close a lone star, which is as likely a glob", () => {
    expect(polishReply("Use the glob src/*.ts", tui)).toBe("Use the glob src/*.ts");
  });

  it("does not rewrite a half-written link in a final reply", () => {
    expect(polishReply("see [docs", tui)).toBe("see [docs");
  });

  it("does not touch markup after a closing code block", () => {
    const reply = "```py\nf(*args, **kw)\n```";
    expect(polishReply(reply, tui)).toBe(reply);
  });
});

describe("polishReply: filler at the edges", () => {
  it.each([
    ["As an AI language model, I can't browse. Here is what I know.", "I can't browse. Here is what I know."],
    ["As an AI assistant, I recommend the 9B model.", "I recommend the 9B model."],
    ["Great question! The answer is 42.", "The answer is 42."],
    ["That's a great question! It depends on VRAM.", "It depends on VRAM."],
    ["Certainly! Here is the list:\n\n- a\n- b", "Here is the list:\n\n- a\n- b"],
    ["Sure! As an AI, I will start with the logs.", "I will start with the logs."],
    ["Как ИИ, я не могу открыть сайт. Вот что я знаю.", "Я не могу открыть сайт. Вот что я знаю."],
    ["Как языковая модель, я не помню прошлых чатов.", "Я не помню прошлых чатов."],
    ["Отличный вопрос! Всё зависит от памяти.", "Всё зависит от памяти."],
  ])("drops the opener: %j", (input, expected) => {
    expect(polishReply(input, tui)).toBe(expected);
  });

  it.each([
    ["The answer is 42.\n\nI hope this helps!", "The answer is 42."],
    ["The answer is 42. Hope this helps!", "The answer is 42."],
    ["The answer is 42.\n\nI hope this helps! Let me know if you have any other questions.", "The answer is 42."],
    ["Done.\n\nIf you have any further questions, feel free to ask! 😊", "Done."],
    ["Ответ: 42.\n\nНадеюсь, это поможет!", "Ответ: 42."],
    ["Готово.\n\nЕсли у вас есть ещё вопросы, обращайтесь!", "Готово."],
  ])("drops the closing pleasantry: %j", (input, expected) => {
    expect(polishReply(input, tui)).toBe(expected);
  });

  it("keeps a closing offer that says something", () => {
    const reply = "Fixed the import.\n\nLet me know if you want me to run the tests.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("keeps a phrase that only looks like filler mid-sentence", () => {
    expect(polishReply("We hope this helps", tui)).toBe("We hope this helps");
    expect(polishReply("The team said we hope this helps!", tui)).toBe("The team said we hope this helps!");
  });

  it("keeps filler in the middle of a reply", () => {
    const reply = "Step one.\n\nI hope this helps so far.\n\nStep two.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("keeps an 'as an AI' that is not the opening clause", () => {
    const reply = "The paper describes the model as an AI, trained on code.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("does not drop a closing line right after a code block", () => {
    const reply = "Run:\n\n```sh\nnpm test\n```\n\nI hope this helps!";
    expect(polishReply(reply, tui)).toBe("Run:\n\n```sh\nnpm test\n```");
  });
});

describe("polishReply: echoed question", () => {
  const asked = "How do I install the agent on Linux?";

  it.each([
    ["How do I install the agent on Linux?\n\nRun the install script."],
    ["how do i install the agent on linux\n\nRun the install script."],
    ["**Question:** How do I install the agent on Linux?\n\nRun the install script."],
    ["You asked: how do I install the agent on Linux?\n\nRun the install script."],
    ["> How do I install the agent on Linux?\n\nRun the install script."],
    ["# How do I install the agent on Linux?\n\nRun the install script."],
  ])("drops the restated question: %j", (input) => {
    expect(polishReply(input, { ...tui, userMessage: asked })).toBe("Run the install script.");
  });

  it("drops a Russian restatement", () => {
    const reply = "Вы спросили: как поставить агента на Linux?\n\nЗапустите скрипт установки.";
    expect(polishReply(reply, { ...tui, userMessage: "Как поставить агента на Linux?" })).toBe(
      "Запустите скрипт установки.",
    );
  });

  it("never drops a greeting answering a short message", () => {
    expect(polishReply("Hi!\n\nHow can I help?", { ...tui, userMessage: "hi" })).toBe("Hi!\n\nHow can I help?");
  });

  it("keeps the paragraph when nothing follows it", () => {
    expect(polishReply(asked, { ...tui, userMessage: asked })).toBe(asked);
  });

  it("keeps a first paragraph that only shares words with the question", () => {
    const reply = "To install the agent on Linux, run the script.\n\nThat is all.";
    expect(polishReply(reply, { ...tui, userMessage: asked })).toBe(reply);
  });
});

describe("polishReply: repeats", () => {
  it("drops a paragraph repeated right after itself", () => {
    expect(polishReply("Para A.\n\nPara A.\n\nPara B.", small)).toBe("Para A.\n\nPara B.");
  });

  it("treats whitespace-only differences as the same paragraph", () => {
    expect(polishReply("The  build\npasses.\n\nThe build passes.", small)).toBe("The  build\npasses.");
  });

  it("keeps a paragraph repeated with something between", () => {
    const reply = "Check.\n\nRun it.\n\nCheck.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("drops a second half that restates the whole answer", () => {
    expect(polishReply("First.\n\nSecond.\n\nFirst.\n\nSecond.", small)).toBe("First.\n\nSecond.");
  });

  it("drops the whole answer restated around a code block", () => {
    const once = "Use this:\n```\nnpm ci\n```";
    expect(polishReply(`${once}\n${once}`, small)).toBe(once);
  });

  it("keeps repeated paragraphs for a cloud model, which repeats only when asked", () => {
    expect(polishReply("Para A.\n\nPara A.\n\nPara B.", tui)).toBe("Para A.\n\nPara A.\n\nPara B.");
    const halves = "First.\n\nSecond.\n\nFirst.\n\nSecond.";
    expect(polishReply(halves, tui)).toBe(halves);
  });

  it("keeps two identical code blocks with no prose between", () => {
    const reply = "```\nA\n```\n\n```\nA\n```";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("collapses a decoding loop of one line for a small model", () => {
    expect(polishReply("Checking.\nChecking.\nChecking.\nChecking.\nDone.", small)).toBe("Checking.\nDone.");
  });

  it("leaves repeated lines alone for a cloud model", () => {
    const reply = "Checking.\nChecking.\nChecking.\nDone.";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("keeps a line said twice, which can be deliberate", () => {
    const reply = "yes\nyes\nno";
    expect(polishReply(reply, small)).toBe(reply);
  });

  it("keeps repeated table rows", () => {
    const reply = "| a | b |\n|---|---|\n| x | 1 |\n| x | 1 |\n| x | 1 |";
    expect(polishReply(reply, small)).toBe(reply);
  });
});

describe("polishReply: blank lines", () => {
  it("collapses runs of blank lines to one", () => {
    expect(polishReply("one\n\n\n\n\ntwo\n\n\nthree", tui)).toBe("one\n\ntwo\n\nthree");
  });

  it("collapses lines holding only spaces", () => {
    expect(polishReply("one\n  \n\t\n  \ntwo", tui)).toBe("one\n\ntwo");
  });

  it("trims leading blank lines and trailing whitespace", () => {
    expect(polishReply("\n\n\nHello.\n\n\n  ", tui)).toBe("Hello.");
  });
});

describe("polishReply: home paths", () => {
  it("shortens a long path under the home folder in prose", () => {
    expect(polishReply("Saved to /Users/me/projects/atomic/src/agent/reply-polish.ts now", tui)).toBe(
      "Saved to ~/projects/atomic/src/agent/reply-polish.ts now",
    );
  });

  it("shortens a path in parentheses", () => {
    expect(polishReply("(see /Users/me/projects/atomic/docs/architecture.md)", tui)).toBe(
      "(see ~/projects/atomic/docs/architecture.md)",
    );
  });

  it("keeps the full path when the user asked for it", () => {
    const reply = "Saved to /Users/me/projects/atomic/src/agent/reply-polish.ts now";
    expect(polishReply(reply, { ...tui, userMessage: "What is the full path of the polish file?" })).toBe(reply);
    expect(polishReply(reply, { ...tui, userMessage: "give me the absolute path" })).toBe(reply);
    expect(polishReply(reply, { ...tui, userMessage: "Напиши полный путь к файлу" })).toBe(reply);
  });

  it("leaves a short path alone", () => {
    expect(polishReply("see /Users/me/a.ts", tui)).toBe("see /Users/me/a.ts");
  });

  it("leaves a link target and a file URL alone", () => {
    const link = "[file](/Users/me/projects/atomic/src/agent/reply-polish.ts)";
    expect(polishReply(link, tui)).toBe(link);
    const url = "Open file:///Users/me/projects/atomic/src/agent/reply-polish.ts";
    expect(polishReply(url, tui)).toBe(url);
  });

  it("leaves another user's folder alone", () => {
    const reply = "Found /Users/other/projects/atomic/src/agent/reply-polish.ts";
    expect(polishReply(reply, tui)).toBe(reply);
  });

  it("does nothing when the home folder is not a plain user folder", () => {
    const reply = "Saved to /root/projects/atomic/src/agent/reply-polish.ts";
    expect(polishReply(reply, { channel: "tui", homeDir: "/root" })).toBe(reply);
  });

  it("works for a Linux home", () => {
    expect(
      polishReply("Wrote /home/dev/work/atomic-agent/src/agent/reply-polish.ts", { channel: "tui", homeDir: "/home/dev" }),
    ).toBe("Wrote ~/work/atomic-agent/src/agent/reply-polish.ts");
  });
});

describe("polishReply: tables on Telegram", () => {
  const table = "| Model | Size | Speed |\n|---|---|---|\n| Qwen | 4B | fast |\n| Gemma | 9B | slow |\n\nDone.";

  it("turns a table into a list on Telegram", () => {
    expect(polishReply(table, telegram)).toBe(
      "- **Qwen**: Size: 4B; Speed: fast\n- **Gemma**: Size: 9B; Speed: slow\n\nDone.",
    );
  });

  it("keeps the table on the TUI and desktop, which draw tables", () => {
    expect(polishReply(table, tui)).toBe(table);
    expect(polishReply(table, { channel: "desktop", homeDir: HOME })).toBe(table);
  });

  it("uses a short form for two columns", () => {
    expect(polishReply("| Key | Value |\n|:--|--:|\n| port | 8080 |", telegram)).toBe("- **port**: 8080");
  });

  it("keeps a pipe inside inline code in its cell", () => {
    expect(polishReply("| Cmd | Use |\n|---|---|\n| `a|b` | pipe |", telegram)).toBe("- **`a|b`**: pipe");
  });

  it("does not double the bold of a bold first cell", () => {
    expect(tablesToLists("| A | B |\n|---|---|\n| **x** | y |")).toBe("- **x**: y");
  });

  it("skips empty cells", () => {
    expect(tablesToLists("| A | B | C |\n|---|---|---|\n| x |  | z |")).toBe("- **x**: C: z");
    expect(tablesToLists("| A | B |\n|---|---|\n|  | y |")).toBe("- y");
  });

  it("leaves a setext heading under a line with a pipe alone", () => {
    const text = "Use a | b\n---";
    expect(tablesToLists(text)).toBe(text);
  });

  it("leaves a header with no body rows alone", () => {
    const text = "| A | B |\n|---|---|\n\nNothing found.";
    expect(tablesToLists(text)).toBe(text);
  });
});

describe("polishReply: ugly small-model samples", () => {
  it("cleans a typical 4B reply end to end", () => {
    const raw = [
      "What is the largest file in the repo?",
      "",
      "",
      "",
      "As an AI language model, I looked at the files.",
      "",
      "The largest file is /Users/me/projects/atomic-agent/package-lock.json (1.2 MB).",
      "",
      "The largest file is /Users/me/projects/atomic-agent/package-lock.json (1.2 MB).",
      "",
      "",
      "I hope this helps! Let me know if you have any other questions.",
    ].join("\n");
    expect(
      polishReply(raw, { ...small, userMessage: "what is the largest file in the repo" }),
    ).toBe(
      "I looked at the files.\n\nThe largest file is ~/projects/atomic-agent/package-lock.json (1.2 MB).",
    );
  });

  it("cleans a reply that loops and leaves bold open", () => {
    const raw = "**Summary**\n\nAll tests pass.\nAll tests pass.\nAll tests pass.\n\n**Next step: open the PR";
    expect(polishReply(raw, small)).toBe("**Summary**\n\nAll tests pass.\n\n**Next step: open the PR**");
  });

  it("cleans a Russian reply for Telegram", () => {
    const raw = [
      "Конечно! Вот сравнение:",
      "",
      "| Модель | Память |",
      "|---|---|",
      "| Qwen 4B | 3 ГБ |",
      "| Gemma 9B | 6 ГБ |",
      "",
      "",
      "",
      "Надеюсь, это поможет!",
    ].join("\n");
    expect(polishReply(raw, { ...telegram, smallModel: true })).toBe(
      "Вот сравнение:\n\n- **Qwen 4B**: 3 ГБ\n- **Gemma 9B**: 6 ГБ",
    );
  });

  it("closes an unfinished code answer and keeps its body", () => {
    const raw = "Sure! Here is the fix:\n\n```ts\nexport const x = 1;\n";
    expect(polishReply(raw, small)).toBe("Here is the fix:\n\n```ts\nexport const x = 1;\n```");
  });
});

describe("splitFences", () => {
  it("splits prose and code and closes an open fence", () => {
    expect(splitFences("a\n```\nb")).toEqual([
      { kind: "prose", text: "a" },
      { kind: "code", text: "```\nb\n```" },
    ]);
  });
});

describe("replyChannelForAnswer", () => {
  it("polishes only for a surface a person reads", () => {
    expect(replyChannelForAnswer("terminal")).toBe("tui");
    expect(replyChannelForAnswer("desktop")).toBe("desktop");
    expect(replyChannelForAnswer("telegram")).toBe("telegram");
    expect(replyChannelForAnswer("discord")).toBe("telegram");
    expect(replyChannelForAnswer(undefined)).toBeUndefined();
  });
});
