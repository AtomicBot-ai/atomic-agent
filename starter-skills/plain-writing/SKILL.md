---
name: plain-writing
description: "Make a landing page, post or any text read human: no long dashes or stock phrases. Use to remove AI slop."
version: 1.0.0
requires_tools:
  - os.fs.read
  - os.fs.edit
dangerous: false
---

# plain-writing

Readers spot machine text in one line and stop trusting the rest. The tells
are small and repeat: the same dash, the same openers, the same three-part
lists, the same hero section. This skill removes them and leaves the
content alone.

## The rule

**Change how it is said, never what is said.** Every fact, number, name,
link, limit and promise in the input must be in the output. Do not add
claims, examples, quotes, statistics or testimonials that were not there.
If a sentence only works with a fact you do not have, flag it instead of
inventing one.

## Text: what to fix

Work through the text once per group below.

1. **Punctuation.** No long dashes (`—`) and no en dashes (`–`) used as
   dashes. Use a period, a comma, a colon or parentheses instead. Ranges
   like `5-10` take a plain hyphen. Cut most semicolons and exclamation
   marks.
2. **Stock words.** Replace or drop: delve, dive into, unlock, unleash,
   elevate, empower, supercharge, seamless, effortless, robust, cutting-edge,
   game-changer, revolutionize, leverage (as a verb), harness, navigate the
   landscape, tapestry, realm, testament, pivotal, crucial, vital, in
   today's fast-paced world, at the end of the day, it's worth noting,
   whether you're X or Y. Use the plain word or nothing.
3. **Empty frames.** Cut throat-clearing openers ("Let's be honest", "Here's
   the thing", "Imagine a world where") and closing recaps ("In summary",
   "In conclusion", "Ultimately"). Start with the point.
4. **Fake contrast.** "It's not just X, it's Y" and "This isn't about X.
   It's about Y." Say Y.
5. **Reflex triplets.** Three adjectives or three parallel clauses in a row
   because three sounds complete. Keep the one that carries information.
6. **Hedges and boosters.** "Truly", "incredibly", "arguably", "very",
   "really", "simply", "just", "potentially". Delete; if the sentence gets
   weaker, the claim needed a number, not an adverb.
7. **Abstract nouns.** "Provides a solution for the management of" becomes
   "manages". Prefer verbs, concrete subjects and short sentences.
8. **Formatting tics.** Emojis as bullet points, bold on every other phrase,
   headings for a three-sentence text, `Title Case For Every Heading`,
   headline colons ("Speed: Redefined"). Use plain sentence case and bold
   at most one thing per section.
9. **Chatbot residue.** "Great question", "I hope this helps", "Feel free
   to", "As an AI", offers to do more. Remove.

## Landing pages and layout

When the text is a page or a component, look at the structure too:

- **The default hero**: a gradient blob, "Supercharge your workflow", two
  buttons, a floating screenshot. Lead instead with what the product does,
  in the words a user would search for, and show the real product.
- **Three identical feature cards** with an icon, a two-word title and a
  vague line. Use fewer, specific items, each with a concrete detail, or a
  list.
- **Invented social proof**: logo walls, star ratings, "loved by 10,000+
  teams" and testimonials that are not in the source. Remove them and say
  so; never write new ones.
- **Every section centred, every section the same height.** Vary rhythm;
  left-align long text.
- **Purple-to-blue gradients, glassmorphism and glow on everything.** Keep
  the project's existing palette; do not add effects it did not have.

Do not redesign a page unprompted. Fix what is listed above in the files
the user pointed at and leave the rest.

## How to work

1. Read the whole text first with `os.fs.read` (or take it from the
   message). Note the facts that must survive.
2. Rewrite. Match the language and the author's register: a casual post
   stays casual, docs stay precise.
3. **Self-check before you answer.** Search your output for `—` and `–`.
   Re-read it against the stock-word list. Compare against the fact list:
   anything missing goes back in.
4. Edit files in place with `os.fs.edit` when the user gave a file. Do not
   create copies.

## What to report

The rewritten text (or the edited file), then at most three lines: what
kinds of things you changed, and anything you flagged because fixing it
needs a fact you do not have.
