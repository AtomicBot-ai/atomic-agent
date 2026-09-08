import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../agent/agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { formatAgentErrorForChat } from "./format-agent-error-for-chat.js";

describe("formatAgentErrorForChat", () => {
  it("prefixes category and message", () => {
    expect(formatAgentErrorForChat("transport", "connection reset")).toBe(
      "Turn failed [transport]: connection reset",
    );
  });

  it("replaces HTML error bodies with a short hint", () => {
    const html =
      "chat completion stream failed: 404 <!DOCTYPE html><html><body>x</body></html>";
    expect(formatAgentErrorForChat("grammar", html)).toBe(
      "Turn failed [grammar]: upstream HTTP 404 (wrong API URL or provider config)",
    );
  });

  it("appends the llama-server hint for transport failures on a local provider", () => {
    const text = formatAgentErrorForChat("transport", "fetch failed", {
      activeProviderIsLocal: true,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: fetch failed");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
    expect(text).toContain("atomic-agent models start");
  });

  it("keeps every hint away from a cloud `fetch failed` — nothing was in flight", () => {
    // `fetch failed` is undici's outer catch-all and is ALSO what it
    // throws when the connection never opened at all: verified on Node
    // 22.22.2, both `ENOTFOUND` (unresolvable host) and `ECONNREFUSED`
    // (closed port) produce exactly this message, with the errno only on
    // `cause`. So neither hint may fire on it — not the llama one (wrong
    // server on a cloud route) and not the drop one, whose first line
    // claims a reply was cut off.
    expect(
      formatAgentErrorForChat("transport", "fetch failed", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [transport]: fetch failed");
  });

  it("keeps every hint away from a cloud transport failure that is not a drop", () => {
    expect(
      formatAgentErrorForChat("transport", "upstream HTTP 503", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [transport]: upstream HTTP 503");
  });

  // The reported failure: a multi-step research turn whose LLM call died
  // mid-body on a cloud provider. undici's bare word for it is
  // `terminated`, and that single word was the entire message the
  // operator got — nothing about the connection, nothing about the six
  // steps that had already succeeded.
  // Source: Discord #feedback-and-bugs, 2026-09-03.
  it("explains a mid-stream drop and where the finished steps went", () => {
    const text = formatAgentErrorForChat("transport", "terminated", {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: terminated");
    expect(text).toContain(
      "the connection to the model dropped before the reply finished",
    );
    expect(text).toContain("kept in this session");
    expect(text).toContain("ask to continue from there");
    expect(text).toContain("re-sending the whole task starts it over");
  });

  it.each([
    "terminated",
    "read ECONNRESET: socket hang up",
    "other side closed",
  ])("recognises the drop family: %s", (message) => {
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toContain("the steps that already finished are kept in this session");
  });

  it.each([
    "connection reset",
    "upstream HTTP 502 (bad gateway)",
    "request timed out after 120s",
    "terminated the request early",
    // A network failure the classifier still files as `transport` (both
    // are in `NETWORK_MESSAGES`), but where no reply was ever in flight:
    // undici's catch-all for a connection that never opened, and a TLS
    // handshake that never completed. The hint would be false.
    "fetch failed",
    "Client network socket disconnected before secure TLS connection was established",
  ])("leaves unrelated transport failures bare: %s", (message) => {
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(`Turn failed [transport]: ${message}`);
  });

  it("keys the hint off the raw message, not the truncated body", () => {
    // The one behaviour that separates `looksLikeMidStreamDrop(message)`
    // from `looksLikeMidStreamDrop(body)`: a drop phrase sitting past the
    // 480-char body cap. Under 800 chars, so the wall does not fire and
    // the only transformation is the truncation. Switch the predicate's
    // argument to `body` and this test fails — that mutation used to
    // survive the whole suite.
    const long = `${"x".repeat(600)} socket hang up`;
    const text = formatAgentErrorForChat("transport", long, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    const [head, ...hint] = text.split("\n");
    expect(head).not.toContain("socket hang up");
    expect(hint.join("\n")).toBe(
      [
        "the connection to the model dropped before the reply finished",
        "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
      ].join("\n"),
    );
  });

  // When the wall substitution fires, `body` stops being the transport's
  // words and becomes a rival diagnosis of the same failure. The two
  // explanations are mutually exclusive — a page of HTML is a reply that
  // ARRIVED, not one that was cut off — and emitting both told the
  // operator two incompatible stories in three lines. The wall wins: it
  // read the whole payload, the drop arm only matches a phrase.
  //
  // Every case here uses an unanchored drop phrase (`socket hang up`),
  // so the drop arm genuinely matches and the `!diagnosedAsWall` guard is
  // the only thing suppressing the hint. A `terminated …` case would be
  // vacuous: `/^terminated$/i` is anchored and never matches a string
  // with a page glued to it, so it passed with the guard mutated away.
  it.each([
    [
      "a document-marker wall with a status in it",
      "socket hang up <!DOCTYPE html><html><body>404 not found</body></html>",
      "upstream HTTP 404 (wrong API URL or provider config)",
    ],
    [
      "a document-marker wall with no status in it",
      "socket hang up <html><body>gateway unavailable</body></html>",
      "upstream returned HTML instead of JSON (check API URL and provider)",
    ],
    [
      "a bulky markup fragment with no document marker",
      `socket hang up <center>502 Bad Gateway</center>${"x".repeat(900)}`,
      "upstream returned HTML instead of JSON (check API URL and provider)",
    ],
  ])("drops the hint when the body was replaced: %s", (_name, message, body) => {
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(`Turn failed [transport]: ${body}`);
  });

  // The regression this PR exists for. `mapCliFailure` in the
  // subscription-CLI provider quotes a subprocess's stderr verbatim (up
  // to 2048 chars), so a `claude`/`codex` run that dies on a Node
  // `socket hang up` arrives here as a ~970-char crash dump — over the
  // wall's length threshold. The wall fired, scraped `/\b(\d{3})\b/`,
  // and reported an HTTP status made out of a source line number, for a
  // local subprocess with no upstream URL at all, while the
  // `!diagnosedAsWall` guard suppressed the true explanation.
  //
  // Captured verbatim from Node v22.22.2 by making a bundled CJS entry
  // point throw at top level; only the install prefix is rewritten to
  // `/opt/homebrew`. The `at Object.<anonymous>` frame is the part that
  // matters: an earlier attempt at this fix demanded "real markup" and
  // then accepted `<anonymous>` as a tag, so this exact payload was
  // still walled — and *worse* than on `main`, because the hint went
  // with it. Every callback-bearing Node stack carries one of these
  // (`Object.`, `Socket.`, `Timeout.`, `new Promise (<anonymous>)`).
  const NODE_CJS_DUMP = [
    '"claude" exited with code 1: /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:8',
    '  throw connResetException("socket hang up");',
    "  ^",
    "",
    "Error: socket hang up",
    "    at connResetException (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:3:15)",
    "    at socketOnEnd (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:8:9)",
    "    at fromSSEResponse (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:10:30)",
    "    at streamQuery (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:11:26)",
    "    at main (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:12:19)",
    "    at Object.<anonymous> (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:13:1)",
    "    at Module._compile (node:internal/modules/cjs/loader:1705:14)",
    "    at Object..js (node:internal/modules/cjs/loader:1838:10)",
    "    at Module.load (node:internal/modules/cjs/loader:1441:32)",
    "    at Function._load (node:internal/modules/cjs/loader:1263:12) {",
    "  code: 'ECONNRESET'",
    "}",
    "",
    "Node.js v22.22.2",
  ].join("\n");

  it("keeps a real Node crash dump with an <anonymous> frame off the wall", () => {
    // Long enough to reach the wall's length arm on its own — no padding.
    expect(NODE_CJS_DUMP.trim().replace(/\s+/g, " ").length).toBeGreaterThan(
      800,
    );
    expect(NODE_CJS_DUMP).toContain("at Object.<anonymous>");
    const text = formatAgentErrorForChat("transport", NODE_CJS_DUMP, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    const [head, ...hint] = text.split("\n");
    expect(head).not.toContain("upstream HTTP");
    expect(head).not.toContain("upstream returned HTML");
    expect(head).toContain('"claude" exited with code 1');
    expect(head).toContain("socket hang up");
    expect(head!.endsWith("…")).toBe(true);
    expect(hint.join("\n")).toBe(
      [
        "the connection to the model dropped before the reply finished",
        "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
      ].join("\n"),
    );
  });

  it("keeps a Socket.<anonymous> dump off the wall, line numbers and all", () => {
    // The other shape a bundled CLI prints, and the one that produced
    // "upstream HTTP 519" — 519 being the column-bearing line number in
    // `node:events:519:28`. The frames are verbatim Node v22.22.2; the
    // trailing filler stands in for the rest of a real CLI's stderr,
    // because this stack alone is ~310 chars and the length arm only
    // looks at payloads over 800.
    const message = [
      '"codex" exited with code 1: /opt/homebrew/lib/node_modules/@openai/codex/cli.js:9',
      "    throw e;",
      "    ^",
      "",
      "Error: socket hang up",
      "    at Socket.<anonymous> (/opt/homebrew/lib/node_modules/@openai/codex/cli.js:7:15)",
      "    at Socket.emit (node:events:519:28)",
      "    at TCP.<anonymous> (node:net:346:12) {",
      "  code: 'ECONNRESET'",
      "}",
      "",
      "Node.js v22.22.2",
      "-".repeat(600),
    ].join("\n");
    expect(message.trim().replace(/\s+/g, " ").length).toBeGreaterThan(800);
    const text = formatAgentErrorForChat("transport", message, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).not.toContain("upstream HTTP 519");
    expect(text).not.toContain("upstream returned HTML");
    expect(text.split("\n")[0]).toContain("socket hang up");
    expect(text).toContain(
      "the connection to the model dropped before the reply finished",
    );
  });

  it.each([
    [
      "a JVM trace with a generic type argument and an <init> frame",
      `boom: java.lang.IllegalStateException at com.example.Repo.load(List<String> ids)(Repo.java:100) at com.example.Svc.<init>(Svc.java:42)${"-".repeat(800)}`,
    ],
    [
      "a TypeScript trace with Promise<void> in it",
      `boom: TypeError at run (src/a.ts:200:3) returning Promise<void>${"-".repeat(800)}`,
    ],
    [
      "a Java trace whose generic has a comma in it",
      `boom at com.example.Cache.get(Map<String,Object> m)(Cache.java:100)${"-".repeat(800)}`,
    ],
    [
      "a Python traceback with a <module> frame",
      `boom Traceback (most recent call last): File "run.py", line 100, in <module>${"-".repeat(800)}`,
    ],
    [
      "a bare generic parameter",
      `boom: expected <T> but got <U> at Foo.run(Foo.java:100)${"-".repeat(800)}`,
    ],
    [
      "a generic argument that happens to be spelled like an element",
      `boom at com.example.Repo.find(Repo.java:100) returning List<Table>${"-".repeat(800)}`,
    ],
    [
      "a TypeScript generic spelled like an element",
      `boom at fetchJson (src/http.ts:100:9) returning Promise<Body>${"-".repeat(800)}`,
    ],
  ])("does not mistake a stack trace for a page: %s", (_name, message) => {
    // `<anonymous>`, `<init>`, `<module>` and `<T>` all have the shape of
    // a bare open tag, and `/i` made `[a-z]` accept `List<String>` and
    // `Promise<void>` too. The last two cases are why the name allowlist
    // is not enough on its own and the `(?<!\w)` guard has to be there:
    // `Table` and `Body` really are element names, and only their
    // position — glued to the end of a word — says they are not tags.
    // Every one of these carries a three-digit run (a line number) that
    // the wall used to report as an HTTP status.
    expect(message.trim().replace(/\s+/g, " ").length).toBeGreaterThan(800);
    const head = formatAgentErrorForChat("transport", message, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    }).split("\n")[0]!;
    expect(head).not.toContain("upstream HTTP");
    expect(head).not.toContain("upstream returned HTML");
    expect(head).toContain("boom");
  });

  it("never scrapes a status out of a bulky fragment, only out of a document", () => {
    // Part of the same repair, and the half that holds even when the tag
    // test is wrong: `/\b(\d{3})\b/` has no idea what it is reading, so
    // it only gets to speak when a document marker proved this really is
    // a page. Here the fragment is genuine markup and the `502` is
    // genuinely the status — and we still decline to claim it, because
    // the identical shape is a line number in a crash dump.
    expect(
      formatAgentErrorForChat(
        "transport",
        `<center>502 Bad Gateway</center><hr/>${"x".repeat(900)}`,
        { activeProviderIsLocal: false, llamaUrl: "http://127.0.0.1:19091" },
      ),
    ).toBe(
      "Turn failed [transport]: upstream returned HTML instead of JSON (check API URL and provider)",
    );
  });

  it("walls an uppercase document with no lowercase markup in it", () => {
    // The document arm used to be `body.includes("<!DOCTYPE") ||
    // body.includes("<html")` — case-SENSITIVE — so an all-caps page got
    // in through the tag arm instead, and only because `HTML_TAG` was
    // `/i`. Nothing pinned that, and appliances really do emit this.
    // Short enough that the length arm cannot fire.
    const page =
      "<HTML><HEAD><TITLE>504 Gateway Time-out</TITLE></HEAD><BODY><H1>504 Gateway Time-out</H1></BODY></HTML>";
    expect(page.length).toBeLessThan(800);
    expect(
      formatAgentErrorForChat("transport", page, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(
      "Turn failed [transport]: upstream HTTP 504 (wrong API URL or provider config)",
    );
  });

  it("walls an uppercase markup fragment with no document marker", () => {
    // Pins the `/i` on `HTML_TAG` itself, which the test above no longer
    // does now that the document arm is case-insensitive on its own.
    expect(
      formatAgentErrorForChat(
        "transport",
        `socket hang up <CENTER>Bad Gateway</CENTER>${"x".repeat(900)}`,
        { activeProviderIsLocal: false, llamaUrl: "http://127.0.0.1:19091" },
      ),
    ).toBe(
      "Turn failed [transport]: upstream returned HTML instead of JSON (check API URL and provider)",
    );
  });

  it("walls a document marker that carries no tag at all", () => {
    // The document arm has to stand on its own. Every other page fixture
    // also carries a tag, so "require BOTH a marker and a tag" used to
    // survive the whole suite. Under 800 chars, so the length arm is out.
    const message = "socket hang up <!DOCTYPE html> 502 and nothing else";
    expect(message.length).toBeLessThan(800);
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(
      "Turn failed [transport]: upstream HTTP 502 (wrong API URL or provider config)",
    );
  });

  it.each([
    [
      "self-closing XHTML tags",
      `502 Bad Gateway<br/><hr/>${"x".repeat(900)}`,
    ],
    [
      "self-closing tags with a space before the slash",
      `502 Bad Gateway<br /><hr />${"x".repeat(900)}`,
    ],
    [
      "a namespaced SOAP body",
      `<soapenv:Body><soapenv:Fault>502</soapenv:Fault></soapenv:Body>${"x".repeat(900)}`,
    ],
    [
      "a hyphenated custom element",
      `<my-widget>gateway down</my-widget>${"x".repeat(900)}`,
    ],
    [
      "tags that only ever appear adjacent to each other",
      `${"x".repeat(900)}</td><td>y`,
    ],
    [
      "a page truncated so hard that only a closing tag survives",
      `500 Internal Server Error ${"x".repeat(900)} </h1>`,
    ],
    [
      "a fragment whose only tag is recognisable by its attributes",
      `Error 1020 ${"x".repeat(900)} <section data-translate="error">`,
    ],
  ])("still walls markup shapes the tag test used to miss: %s", (_n, body) => {
    // These are the appliance and middleware bodies the length arm was
    // kept for. `<br/>` fails a `(?:\s[^<>]*)?>` tail because `/` is
    // neither whitespace nor `>`; `<soapenv:Body>` and `<my-widget>` fail
    // `[a-z][a-z0-9]*` on the `:` and the `-`.
    expect(
      formatAgentErrorForChat("transport", body, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(
      "Turn failed [transport]: upstream returned HTML instead of JSON (check API URL and provider)",
    );
  });

  // The wall's second entrance — bulk plus a tag — is a threshold, and a
  // threshold nobody tests drifts. Both sides pinned: `800 → 799` kills
  // the first of these, `800 → 801` kills the second.
  const WALL_EDGE = `socket hang up <div>${"x".repeat(780)}`;

  it("leaves a markup fragment of exactly 800 chars to the drop arm", () => {
    expect(WALL_EDGE).toHaveLength(800);
    const text = formatAgentErrorForChat("transport", WALL_EDGE, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text.split("\n")[0]).toBe(
      `Turn failed [transport]: ${WALL_EDGE.slice(0, 480)}…`,
    );
    expect(text).toContain(
      "the connection to the model dropped before the reply finished",
    );
  });

  it("treats a markup fragment of 801 chars as a wall", () => {
    const overEdge = `${WALL_EDGE}x`;
    expect(overEdge).toHaveLength(801);
    expect(
      formatAgentErrorForChat("transport", overEdge, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(
      "Turn failed [transport]: upstream returned HTML instead of JSON (check API URL and provider)",
    );
  });

  it("reads the drop phrase through whitespace, exactly as the body does", () => {
    // `body` is whitespace-collapsed; the predicate used to read the raw
    // `message`, so a phrase broken across lines printed in the body and
    // had its explanation withheld. One normalisation now feeds both.
    // Not reachable from undici's own strings, but a subprocess's stderr
    // reaches this formatter verbatim, newlines and all.
    expect(
      formatAgentErrorForChat("transport", "socket\nhang\nup", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(
      [
        "Turn failed [transport]: socket hang up",
        "the connection to the model dropped before the reply finished",
        "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
      ].join("\n"),
    );
  });

  it.each(["tool", "runtime"])(
    "keeps the drop hint out of the %s category",
    (category) => {
      // `runtime` is the only other shape production produces: the
      // orchestrator's catch arm (`chat-orchestrator.ts`) calls
      // `formatAgentErrorForChat("runtime", msg)` with no provider
      // context, so it can never reach the transport branch at all.
      expect(formatAgentErrorForChat(category, "terminated")).toBe(
        `Turn failed [${category}]: terminated`,
      );
    },
  );

  it("prefers the llama hint when a local provider drops mid-stream", () => {
    // Both arms match. The local one wins: "start llama-server" is a fix,
    // the drop hint is only an explanation.
    const text = formatAgentErrorForChat("transport", "terminated", {
      activeProviderIsLocal: true,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toBe(
      [
        "Turn failed [transport]: terminated",
        "llama-server is not reachable at http://127.0.0.1:19091",
        "  start it with:       atomic-agent models start",
        "  or point elsewhere:  atomic-agent config set localModels.url <url>",
      ].join("\n"),
    );
  });

  it("truncates the body, never the hint", () => {
    // Under the 800-char HTML-wall threshold, over the 480-char body cap.
    const long = `socket hang up ${"x".repeat(600)}`;
    const text = formatAgentErrorForChat("transport", long, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    const [head, ...hint] = text.split("\n");
    expect(head!.startsWith("Turn failed [transport]: socket hang up")).toBe(
      true,
    );
    expect(head!.endsWith("…")).toBe(true);
    // 480-char body cap + the "Turn failed [transport]: " prefix + "…".
    expect(head!.length).toBe("Turn failed [transport]: ".length + 480 + 1);
    expect(hint.join("\n")).toBe(
      [
        "the connection to the model dropped before the reply finished",
        "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
      ].join("\n"),
    );
  });

  it("keeps the hint away from non-transport failures", () => {
    expect(
      formatAgentErrorForChat("model", "empty completion", {
        activeProviderIsLocal: true,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [model]: empty completion");
  });
});

const LOCAL = {
  activeProviderIsLocal: true,
  llamaUrl: "http://127.0.0.1:19091",
};

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("formatAgentErrorForChat — llama failures through the real pipeline", () => {
  // Drives the WHOLE production path, not a hand-composed imitation of
  // it: `AgentLoop` runs a step whose `llmComplete` throws a raw
  // `LlamaServerError`; `executeStep` normalises it through
  // `toLlmFailure`; the loop's catch calls `classifyFailure` on THAT
  // wrapper and emits `loop_failed { category, error }`; the TUI reducer
  // (`agent-event-reducer.ts`, "loop_failed" case) hands exactly those two
  // fields plus the local-provider context to the formatter.
  //
  // The `toLlmFailure` link is the point of the exercise. It used to carry
  // its own hardcoded copy of the llama status split, so a 404 reached the
  // user as `Turn failed [grammar]` however `classifyFailure` was written —
  // and a test that called `formatAgentErrorForChat(classifyFailure(err), …)`
  // directly stayed green while production stayed broken. Route the
  // assertion through the loop and that gap cannot hide.
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-chat-error-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  /**
   * Run one turn whose only LLM call throws `LlamaServerError(status)`,
   * and render the resulting `loop_failed` exactly as the reducer does.
   */
  async function chatTextForLlamaStatus(status: number): Promise<string> {
    const failures: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new LlamaServerError(
          `llama-server returned http ${status}`,
          status,
          LOCAL.llamaUrl,
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_failed") {
          failures.push({
            category: event.category,
            message: event.error.message,
          });
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: `s-llama-${status}`, workingDir }),
      {
        userMessage: "go",
        maxSteps: 3,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(failures).toHaveLength(1);
    return formatAgentErrorForChat(
      failures[0]!.category,
      failures[0]!.message,
      LOCAL,
    );
  }

  it("carries the unreachable hint for a llama 404 on a local provider", async () => {
    // The one failure where "check your llama URL" is exactly the right
    // advice — a wrong `localModels.url`, or a server that is not a
    // llama-server — was the one failure that never got it.
    const text = await chatTextForLlamaStatus(404);
    expect(text).toContain("Turn failed [transport]");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
  });

  it("carries the unreachable hint for a llama 405 on a local provider", async () => {
    const text = await chatTextForLlamaStatus(405);
    expect(text).toContain("Turn failed [transport]");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
  });

  it("keeps a llama 400 as a grammar failure with no URL advice", async () => {
    // Regression guard for the half that is intentionally unchanged: a
    // 400 is the server rejecting THIS request, and the next link would
    // reject it identically.
    const text = await chatTextForLlamaStatus(400);
    expect(text).toBe("Turn failed [grammar]: llama-server returned http 400");
  });
});
