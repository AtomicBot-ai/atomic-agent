---
name: post-drafts
description: "Draft a Reddit, LinkedIn, X or Hacker News post that fits the platform's limits, the subreddit's rules and your brand voice. Draft only, never publishes."
version: 1.0.0
requires_tools:
  - os.http.request
  - os.fs.read
  - os.fs.write
  - skill.view
  - skill.run_script
requires_scripts:
  - subreddit-rules.mjs
  - post-lint.mjs
dangerous: false
---

# post-drafts

The user wants a post for one platform. You hand back a draft that fits
that platform: its length limits, its norms on self-promotion and links,
and (for Reddit) the rules of the exact subreddit. It sounds like the
user's brand, not like a chatbot.

## Draft only: you never publish

This skill writes text. **It never posts, submits, comments, schedules or
sends anything.** Do not call a posting API, the `xurl` skill, a browser
submit button or any other tool that would put the text online, even if
the user asks you to "just post it". The human publishes. Say so in every
answer, with this line under the draft:

> Draft only. I have not posted anything; copy it and publish it yourself.

## Step 1: what and where

Get three things from the message, and ask only for what is missing:

- **Platform**: Reddit, LinkedIn, X or Hacker News. For Reddit, the exact
  subreddit (`r/<name>`).
- **What the post is about**: the facts, the link, the news.
- **Goal**: feedback, launch, hiring, discussion, a reply to a thread.

## Step 2: pull the rules before you draft (Reddit)

**Never draft a Reddit post before you have read that subreddit's rules.**
Subreddits ban for things the user cannot guess: links in the body, no
self-promotion, required flair, a weekly thread for launches, AI-written
content.

1. Run the bundled fetcher:

   ```json
   [{ "tool": "skill.run_script", "args": { "skill": "post-drafts", "script": "subreddit-rules.mjs", "args": ["<subreddit>"] } }]
   ```

   It reads the public `https://www.reddit.com/r/<sub>/about/rules.json`
   and the sidebar from `https://www.reddit.com/r/<sub>/about.json`, and
   prints the rules, the sidebar text and the submit guidelines as JSON.
2. If the script is not approved or fails, fetch the same two URLs with
   `os.http.request` (GET, header `User-Agent: post-drafts/1.0`).
3. If Reddit still refuses (403, 429, private subreddit), stop and ask
   the user to paste the rules and the sidebar. Do not draft from memory
   of what a subreddit "usually" allows.

Then list, before the draft, every rule that changes it: "no links in the
body", "flair required: Showcase", "self-promotion only in the weekly
thread", "no AI content". If a rule forbids the post outright, say so and
suggest the allowed route (the weekly thread, a different subreddit, a
comment instead of a post). Do not write a draft that breaks a rule.

For X, LinkedIn and Hacker News there is no per-community fetch: use the
cheat sheet below. For Hacker News, read the Show HN rules there before a
Show HN.

## Step 3: brand voice from `brand-context.md`

Look for the brand file in this order and use the first one found:

1. `brand-context.md` in the workspace root (the folder you work in).
2. `~/.atomic-agent/brand-context.md` (the agent's state folder).

Do not keep it inside this skill's folder: starter skills are replaced on
every start, so the file would be lost.

If neither exists, ask these short questions in one message and wait:

1. What is the product, in one line, and who is it for?
2. Three words for the tone (or paste a post of yours you like).
3. Anything to avoid: words, claims, competitors, topics?
4. Which links and handles go in posts?

Then offer to save the answers as `brand-context.md` in the workspace
root. Write it with `os.fs.write` only after the user says yes. Use the
voice file for tone and wording; never take facts or numbers from it that
the user did not give for this post.

## Step 4: draft for the platform

Write in the voice from Step 3, inside the limits from the cheat sheet
and the rules from Step 2. Lead with the point. Disclose affiliation when
the user is promoting their own thing ("I built this", "I work on X").
Never invent numbers, quotes, user counts or testimonials. Keep the
user's language.

## Step 5: anti-slop pass

Load the `plain-writing` starter with `skill.view` and apply its "Text:
what to fix" list to the draft. Do not paste its list here or skip it. If
that skill is disabled, at least: no long dashes, no stock words (delve,
unlock, seamless, game-changer, leverage), no "It's not just X, it's Y",
no closing recap, no emoji bullets.

**No long dashes.** The draft must contain zero `—` (U+2014) and zero `–`
(U+2013). Use a period, a comma, a colon or parentheses.

## Step 6: lint, then answer

Run the linter on the draft, passing the text itself:

```json
[{ "tool": "skill.run_script", "args": { "skill": "post-drafts", "script": "post-lint.mjs", "args": ["--platform", "reddit", "--text", "<the whole draft>"] } }]
```

`--platform` is `x`, `linkedin`, `hn` or `reddit`. For a long draft you
can write it to a file and pass `--file <absolute path>` instead (the
script runs inside the skill folder, so a relative path would point
there). The draft format:

- `reddit` and `hn`: first line is the title, then a blank line, then
  the body (or, for `hn`, the URL or the text).
- `x`: one post, or a thread with posts separated by a line `---`.
- `linkedin`: the whole post.

It prints JSON with `errors` (over a hard limit, long dashes) and
`warnings` (fold, hashtags, links). Fix every error and rerun. If the
script is not approved, check the same things by hand.

Answer with: the rules that shaped the draft (Reddit), the draft itself,
the lint result in one line, and the "Draft only" line from the top.

## Cheat sheet

**X**
- 280 characters per post (accounts without Premium). A link counts as
  23 characters whatever its length. Emojis and CJK count as 2.
- Thread: the first post must work alone; number posts only if it helps
  (`1/5`); each post at most 280; 3 to 7 posts is usually enough.
- Links in the first post often get less reach; many accounts put the
  link in the first reply. Ask the user which they want.
- Zero or one hashtag. No hashtag stacks.

**LinkedIn**
- Up to 3,000 characters per post.
- Only about the first 210 characters show before "see more" (less on
  phones). The hook has to sit inside that fold.
- Plain text: no markdown. Do not fake bold with Unicode letters; screen
  readers cannot read them.
- Short paragraphs, one idea each. At most three hashtags, at the end.
- Many authors put the external link in the first comment; ask the user.

**Hacker News**
- Title: 80 characters maximum. Use the original title of an article; do
  not editorialize, no uppercase or exclamation marks for emphasis, no
  "the best", no clickbait numbers.
- Show HN is for something people can try now: a running product, a repo,
  a demo. Not for landing pages, sign-up lists, fundraising or blog posts.
  Title starts with `Show HN: `. Make it easy to try without signing up
  where possible.
- Submit either a URL or text. For a Show HN with a URL, draft a first
  comment: who made it, why, what is different, what feedback you want.
- Never ask for upvotes or share the link to get votes; HN penalizes it.
- No marketing tone. Plain, technical, honest about limits.

**Reddit**
- Title: 300 characters maximum. Body: up to 40,000 characters. Markdown
  works in the body.
- Subreddit rules (Step 2) override everything here.
- Self-promotion: Reddit expects most of an account's activity to be
  normal participation, not its own links. Disclose that you made the
  thing. Prefer a text post that gives value (what you learned, numbers
  the user gave you) with the link at the end or in a comment, if the
  rules allow links at all.
- No hashtags. Flair if the subreddit requires it.
- The first two lines show in the feed: put the concrete, surprising part
  there, not a greeting.
- Do not post the same text to many subreddits; Reddit limits accounts
  that do. One subreddit per draft, adapted to it.
