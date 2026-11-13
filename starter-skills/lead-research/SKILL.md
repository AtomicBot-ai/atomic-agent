---
name: lead-research
description: "Build a list of companies and business contacts from open sources (websites, GitHub, Apify with your key), enriched and with a source per row. GDPR-safe; never scrapes LinkedIn or X."
version: 1.0.0
requires_tools:
  - os.web.search
  - os.web.fetch
  - os.http.request
  - os.fs.write
  - os.fs.read
dangerous: false
---

# lead-research

Turn "find me 30 companies like X and who to talk to there" into a table
the user can work from: company, what it does, why it fits, a business
contact, and where each fact came from.

## Hard limits (read before the first search)

1. **No LinkedIn, no X (Twitter) scraping.** Their terms forbid it. Do not
   fetch linkedin.com or x.com / twitter.com profile or search pages, and
   do not run any Apify actor or other scraper that targets them. If the
   user asks for it, say these sites do not allow scraping and offer the
   open sources below. A LinkedIn URL that a company publishes on its own
   site may be copied as a link; do not open it to read the profile.
2. **Business contact data only.** Allowed: a person's name, job title,
   company, and a work email or phone **that the person or the company
   published for contact** (team page, imprint, press page, a GitHub
   profile's public email field). Not allowed: private emails, home
   addresses, private phone numbers, family, photos, and anything in the
   GDPR special categories (health, religion, politics, ethnicity, sexual
   orientation, union membership).
3. **Do not guess personal email addresses.** No `first.last@` pattern
   guessing and no email-finder services. When no published address
   exists, use the company's role address (`hello@`, `sales@`,
   `partners@`) or the contact form URL, and say so.
4. **Every row has a source.** `source_url` for each contact and the date
   it was collected. A row you cannot source is dropped, not kept as
   "probably".
5. **Honour opt-outs.** Before adding anyone, check the suppression list
   (see below). A person or domain on it never goes into a new list. If a
   page says "no unsolicited sales email" or similar, record that in
   `notes` and leave the contact out.

These limits follow from GDPR for EU people and from the sites' terms. They
are not legal advice; if the user plans a large campaign, suggest they
check it with whoever handles compliance for them.

## Inputs to agree first

Ask in one message, only for what is missing:

- **Who fits**: industry, size, region, a few example companies, signals
  ("uses Kubernetes", "hiring ML engineers", "open-source SDK").
- **Who to contact**: roles (for example founder, head of developer
  relations, partnerships).
- **How many** companies (default 20) and where to save
  (default `./leads/<topic>-<YYYY-MM-DD>.csv`).

## Sources, in order

1. **Search**: `os.web.search` for lists, directories and examples
   ("open-source vector database companies", "<example> alternatives").
2. **Company website**: `os.web.fetch` the home, about, team, careers,
   press, contact and imprint pages. Take what the company says it does,
   size hints, location, published contact addresses.
3. **GitHub** (public data, through the API or the `github` skill):
   the org profile (`https://api.github.com/orgs/<org>`), public members,
   top repositories, stars, recent activity. A person's email only from
   the public `email` field of their profile, never from commit metadata.
4. **Apify, only with the user's own key and only when they ask for it.**
   If an Apify MCP server is connected, use its tools. Otherwise call
   `https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items` with
   `os.http.request` (approval-gated, one call per step) and the token the
   user gave for this. Use only actors for company websites, maps or
   directories, never LinkedIn or X actors. Tell the user an Apify run
   spends their Apify credit before starting it.

Respect `robots.txt` and do not hammer a site: a handful of pages per
company is enough.

## Enrichment

Fill only what a source states, otherwise leave the cell empty:

- one-line description in the company's own words;
- size band from the site or GitHub (people on the team page, open roles);
- location (HQ city and country);
- signals the user asked for, each with the page that shows it;
- fit score 1 to 3 with a one-line reason tied to the user's criteria.

## Output

A CSV (and a short summary in chat) with these columns:

```
company,website,description,location,size_hint,signals,fit,fit_reason,contact_name,contact_role,contact_channel,source_url,collected_at,notes
```

`contact_channel` is the published work email, a role address, or a
contact form URL. `collected_at` is today's date. Write it with
`os.fs.write`.

## Suppression list

Opt-outs live in `./leads/suppression.csv` (`email_or_domain,added_at,reason`).
Read it before building a list. When the user says someone asked not to be
contacted, add a row. Never delete rows from it.

## Report

Say how many companies were found, how many have a named contact, how many
only a role address or form, and what was left out and why (no source,
opt-out, LinkedIn-only). Do not overstate the list's quality.
