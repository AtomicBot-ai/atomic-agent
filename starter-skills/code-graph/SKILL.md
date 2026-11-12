---
name: code-graph
description: Map code with file and line: who calls X, where payments or login live. Use for /code-graph.
version: 1.0.0
requires_tools:
  - os.fs.code_map
  - os.fs.grep
  - os.fs.read
dangerous: false
---

# code-graph

People ask about code in terms of meaning ("where are payments?") and
links ("who calls this?"). Reading files one by one to answer that is slow
and misses things. This skill builds the part of the call graph the
question needs, from the project map and targeted searches, and shows every
edge with a `path:line` the user can open.

Read-only: never edit files while answering.

## Start from the map

Call `os.fs.code_map` on the project (or the folder the user named) once
per question. It lists the most-referenced files first with their main
symbols and lines. Pass `focus` with the names or paths from the question
to centre it. Use `path` set to one file to get that file's full skeleton
before reading it with `os.fs.read` and an offset.

## Question types

**Who calls X?**
1. Find the definition: `os.fs.grep` for the name with a definition
   pattern (`function X`, `X(` after `def`, `class X`, `X =`, `fn X`).
2. Search for uses: `os.fs.grep` for `X(`, `.X(`, `new X`, and imports of
   the file that defines it.
3. Drop the definition itself, comments, strings and, unless asked, tests.
4. For each real caller, read a few lines around it and note the enclosing
   function. That function is the caller, not the file.
5. Go one more level up only if the user asked for the chain or the direct
   callers are thin wrappers.

**What does X call / depend on?**
Read X's body (skeleton first, then the lines). List the functions,
modules and external services it uses, in the order they run.

**Where is feature Y?** (payments, login, uploads…)
1. Expand Y into the words code uses: payments gives `payment`, `charge`,
   `invoice`, `billing`, `checkout`, `stripe`, `subscription`, `refund`.
2. Search file paths first (`os.fs.code_map` with `focus`, or `os.fs.grep`
   on paths), then identifiers, then route strings and config keys.
3. Rank by how central the hits are: entry points (routes, handlers, CLI
   commands) first, then the core logic, then helpers and tests.
4. Answer with the 3 to 7 places that matter, each with one line on its
   role, not every hit.

**How does A reach B?**
Walk from A's entry point through its calls toward B, one hop at a time,
reading each hop. Stop after about eight hops; if B is still not reached,
say where the trail ends and why (an event bus, a queue, dynamic dispatch,
another service).

## Answer format

- Lead with the direct answer in one or two sentences.
- Then the edges, one per line: `caller (path:line) -> callee (path:line)`,
  or a short list of places for "where is Y".
- When the user asks for a picture, or the graph has more than about six
  edges, add a Mermaid `flowchart` block with the same edges. Keep it under
  20 nodes; group the rest as "…and N more".
- End with one line on how complete it is: what search you relied on and
  what it cannot see.

## Limits to state honestly

This is a search-based graph, not a compiler's. Say so when it matters:

- dynamic calls (callbacks passed around, `obj[name]()`, reflection,
  dependency injection) and event emitters can hide callers;
- a common name like `run` or `get` matches too much; narrow the search by
  the file that imports the definition, and say you did;
- generated code, other repositories and services over the network are out
  of view.

Never invent an edge. If you did not read the line, it does not go in the
answer.
