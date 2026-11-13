---
name: landing-cro-review
description: "Review a landing page from a screenshot against a conversion (CRO) checklist: headline, call to action, proof, friction, trust, mobile. Findings ranked by impact."
version: 1.0.0
requires_tools:
  - browser.navigate
  - browser.screenshot
  - browser.read_aria
  - vision.describe
  - os.web.fetch
dangerous: false
---

# landing-cro-review

Look at a landing page the way a first-time visitor does and list what is
likely to stop them from signing up, buying or downloading. Work from what
is visible in a screenshot plus the page text.

## Get the page

1. **The user gave a screenshot file**: use it as is.
2. **The user gave a URL**: open it and take screenshots.

   ```json
   [{ "tool": "browser.navigate", "args": { "url": "<url>" } }]
   [{ "tool": "browser.screenshot", "args": {} }]
   [{ "tool": "browser.screenshot", "args": { "fullPage": true } }]
   ```

   The first shot is the viewport, what a visitor sees before scrolling.
   The full-page shot is cut at 8000 CSS px; say so if the page is longer.
3. Look at each image with `vision.describe` (at most 4 images per call),
   asking concrete questions: "What is the headline? What does the main
   button say? What is visible before scrolling?"
4. Read the text with `browser.read_aria` or `os.web.fetch` so quotes are
   exact.

If no vision model is available, say the review is from page text only
and skip the visual items. If the user wants mobile, ask for a phone
screenshot unless the browser can show a phone-width page; otherwise
mark mobile as not checked.

## Checklist

Go through every item. For each: pass, problem, or not checked.

**Above the fold**
- The headline says what the product is and who it is for, in words a
  visitor would search for. Not a slogan.
- A subheadline gives the main outcome or reason to care.
- One primary call to action, visible without scrolling, with a verb that
  says what happens ("Download for Mac", not "Get started" when it
  downloads).
- The product itself is shown (screenshot, demo, video still), not only an
  abstract illustration.

**Message and match**
- The page matches where visitors come from (the ad or post that sends
  them). Ask the user for the ad text if this matters.
- Benefits are concrete. Features are explained by what they let the user
  do.
- The main objections are answered (price, setup effort, privacy, platform
  support, "does it work with X").

**Proof and trust**
- Proof is real and specific: named customers, numbers with a source,
  reviews, GitHub stars, press. Flag proof that looks made up or has no
  source; never suggest inventing it.
- Price, plan or "free" status is clear, with no surprise at checkout.
- Company and contact information, privacy policy and terms are findable.

**Friction**
- Forms ask only what is needed now. Count the fields.
- The call to action repeats after long sections.
- No pop-up blocks the page on first load.
- Visual hierarchy: the button stands out by colour and size; there are
  not several competing buttons of equal weight.
- Text is readable: size, contrast, line length.

**Technical (note, do not measure unless asked)**
- Obvious slowness, layout jumps, broken images or links seen while
  loading.
- Mobile layout: tap targets, text size, horizontal scroll.

## Rules for findings

- Every finding points at evidence: a quote, or where in the screenshot
  ("hero, left column", "third section").
- Do not promise results. No "this will raise conversion by 20%". Say
  "likely", and suggest an A/B test for the big changes.
- Do not invent the audience, the traffic source or past data. Ask.
- Do not rewrite the whole page unasked. Give the fix for each finding; a
  suggested headline or button text is fine.

## Report

1. One line: the biggest problem.
2. A table sorted by expected impact (high, medium, low): finding,
   evidence, suggested fix.
3. What passed, in one or two lines.
4. What was not checked (mobile, speed, part of the page past the cut) and
   why.

Attach the screenshots with `reply.attachments` when the user should see
them.
