/**
 * The fixed prompts of the tool-call reliability bench (ATO-1092).
 *
 * Every case offers the same small toolbox, so "picked the right tool"
 * means something, and names the one tool a careful model calls plus the
 * arguments that call cannot do without. The set is small on purpose: it
 * is a quick per-model signal (does this model call tools at all, with
 * valid JSON, the right name and the needed fields), not a benchmark of
 * task skill. Changing a case changes every past score, so add new ones
 * at the end and keep the old ones as they are.
 */

export interface BenchTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface BenchCase {
  id: string;
  prompt: string;
  expectedTool: string;
  requiredArgs: readonly string[];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, string>,
): BenchTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, text]) => [
            key,
            { type: "string", description: text },
          ]),
        ),
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
  };
}

export const BENCH_TOOLS: readonly BenchTool[] = [
  tool("read_file", "Read a text file from the workspace.", {
    path: "Path of the file, relative to the workspace.",
  }),
  tool("write_file", "Create or overwrite a text file in the workspace.", {
    path: "Path of the file, relative to the workspace.",
    content: "The full text to write.",
  }),
  tool("list_dir", "List the entries of a folder in the workspace.", {
    path: "Path of the folder, relative to the workspace.",
  }),
  tool("web_search", "Search the web and return the top results.", {
    query: "What to search for.",
  }),
  tool("send_email", "Send an email.", {
    to: "Recipient address.",
    subject: "Subject line.",
    body: "Message text.",
  }),
];

export const BENCH_CASES: readonly BenchCase[] = [
  {
    id: "read-file",
    prompt: "Show me what is written in notes/todo.md.",
    expectedTool: "read_file",
    requiredArgs: ["path"],
  },
  {
    id: "write-file",
    prompt: "Save the text 'buy milk' into a file called shopping.txt.",
    expectedTool: "write_file",
    requiredArgs: ["path", "content"],
  },
  {
    id: "list-dir",
    prompt: "Which files are in the src folder?",
    expectedTool: "list_dir",
    requiredArgs: ["path"],
  },
  {
    id: "web-search",
    prompt: "Look up on the web who won the 2022 football World Cup.",
    expectedTool: "web_search",
    requiredArgs: ["query"],
  },
  {
    id: "send-email",
    prompt:
      "Email anna@example.com with the subject 'Lunch' and say: see you at noon.",
    expectedTool: "send_email",
    requiredArgs: ["to", "subject", "body"],
  },
];

/** The instruction every bench prompt is sent with. */
export const BENCH_SYSTEM_HINT =
  "You are an assistant with tools. Answer the request by calling exactly one tool.";
