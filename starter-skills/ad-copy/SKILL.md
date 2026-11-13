---
name: ad-copy
description: "Write ad copy variants that fit Google Ads (RSA headline 30, description 90, path 15) and Meta recommended lengths, with every length checked by a script."
version: 1.0.0
requires_tools:
  - skill.run_script
  - os.fs.write
requires_scripts:
  - check-lengths.mjs
dangerous: false
---

# ad-copy

Write ad text variants for Google Search and Meta (Facebook, Instagram)
that fit each platform's limits, so the user can paste them in without
trimming. This skill writes text only; it does not create or change
campaigns.

## Limits

**Google Ads, Responsive Search Ads (hard limits, the ad is rejected over
them):**

| Field | Max characters | How many |
|---|---|---|
| Headline | 30 | 3 to 15 (aim for 10 to 15) |
| Description | 90 | 2 to 4 |
| Display path (each of two) | 15 | 0 to 2 |

Double-width characters (Chinese, Japanese, Korean) count as 2. No
exclamation marks in headlines; avoid ALL CAPS words, repeated
punctuation and symbols used as decoration.

**Meta ads (recommended lengths, longer text is allowed but gets cut off
with "See more"):**

| Field | Recommended |
|---|---|
| Primary text | about 125 characters |
| Headline | about 40 characters |
| Description | about 30 characters |

Always say "recommended" for Meta numbers. They are not limits.

## Inputs

Ask only for what is missing:

- the product and the one action the ad should drive;
- who it is for and the keyword or interest being targeted;
- facts allowed in the ad: price, "free", numbers, awards, platform. Use
  only these. Do not invent numbers, customer counts, ratings or "#1"
  claims; ad platforms reject unproven superlatives too;
- the landing page URL (headlines should match what it says);
- language and tone.

## Writing

- **Google headlines** are combined by Google in any order, so each one
  must read on its own. Mix: 3 to 4 with the keyword, 3 to 4 benefits,
  2 to 3 features or proof, 2 calls to action. No two headlines that say
  the same thing.
- **Google descriptions** add what the headlines cannot: who it is for,
  the main benefit, a reason to act now, the call to action.
- **Paths** are short keyword words (`local-ai`, `download`), no spaces.
- **Meta primary text**: the first 125 characters carry the hook and the
  point, because the rest hides behind "See more". Give 3 variants with
  different angles (problem, outcome, proof).
- **Meta headline and description**: short, concrete, a verb in the
  headline.
- Follow the `plain-writing` rules: no long dashes, no stock phrases.

## Check every length with the script

Never count characters by eye. Put all variants in one JSON and run:

```json
[{ "tool": "skill.run_script", "args": { "skill": "ad-copy", "script": "check-lengths.mjs", "args": ["{\"google\":{\"headlines\":[\"...\"],\"descriptions\":[\"...\"],\"paths\":[\"...\"]},\"meta\":{\"primaryTexts\":[\"...\"],\"headlines\":[\"...\"],\"descriptions\":[\"...\"]}}"] } }]
```

For a long set, write the JSON to a file with `os.fs.write` and pass the
path instead. `FAIL` lines break a Google limit: shorten and run again
until there are none. `WARN` lines are over a Meta recommendation: keep
them only if the extra text earns its place, and say so.

## Report

Tables ready to paste: Google headlines with their length, descriptions
with their length, paths; Meta primary texts, headlines, descriptions with
their length and "recommended" limit. Under the tables: which facts from
the user were used, and any claim you left out because it had no source.
