# GitHub editorial bridge

This repository includes a labeled-issue bridge for the CIE Daily Editorial
Inbox. It does not change the Editorial Inbox, NVIDIA formatter, approval flow,
or publishing behavior.

```text
Labeled GitHub issue
  -> GitHub Action validates the body
  -> POST /api/editorial-ingest with EDITORIAL_INGEST_SECRET
  -> editorial_queue
  -> existing NVIDIA generation
  -> ready_for_review
  -> human review in Studio
```

There is no publish step in this workflow.

## Required repository setup

Create one Actions secret in the `manasvignesh/Cie-Daily-Studio` repository:

```text
EDITORIAL_INGEST_SECRET=<the same value configured on the deployed Studio backend>
```

The secret is passed only through the Action environment. The workflow and
Node bridge never print it, include it in issue comments, or put it in an
artifact.

The workflow requests only `contents: read` and `issues: write` permissions.

## Issue format ChatGPT must create

Use this exact label:

```text
cie-editorial-ingest
```

Use a title beginning with:

```text
CIE Editorial ingest — YYYY-MM-DD
```

The issue body should be JSON (a `json` fenced block is also accepted):

```json
{
  "stories": [
    {
      "title": "Source-grounded headline",
      "sourceUrl": "https://publisher.example/story",
      "sourceName": "Publisher name",
      "publishedAt": "2026-09-06T08:30:00+05:30",
      "domain": "Technology",
      "summary": "At least 40 characters of source-grounded reporting.",
      "keyFacts": [
        "At least two facts supported by the source.",
        "A second source-supported fact."
      ],
      "location": "India",
      "imageUrl": "https://publisher.example/story-image.jpg"
    }
  ]
}
```

Submit at most ten stories per issue. Domains are `Technology`, `Startups`,
`AI & ML`, `Science`, `Engineering`, `India`, or `Business`. Use only verified
HTTP(S) URLs and source-supported facts.

## What the Action does

- Validates title, JSON, batch size, URLs, dates, domains, summaries, and facts.
- Posts the canonical `{ "stories": [...] }` payload to the production
  `https://cie-daily-studio.vercel.app/api/editorial-ingest` endpoint.
- Comments success and failure counts plus queue IDs on the issue.
- Closes the issue only when every submitted story is accepted by ingestion.
- Leaves failed or partially failed issues open with a safe diagnostic.

The production ingestion endpoint performs duplicate detection, calls the same
NVIDIA generation service as manual Generate, validates the Swipe Deck and Full
Story schema, and stops at `ready_for_review`.

## Manual test

1. Create the `cie-editorial-ingest` label if it does not already exist.
2. Add the `EDITORIAL_INGEST_SECRET` Actions secret.
3. Create an issue using the title and JSON body format above.
4. Add the label. The workflow starts automatically.
5. Open the Actions run and issue comment. A successful run closes the issue and
   lists the queue ID.
6. Open the Studio Editorial Inbox and confirm the item is `Ready for review`.
7. Confirm the generated Quick Brief and Full Story are present. Do not approve
   or publish the test item.

For a previously created issue, use **Actions -> CIE Daily editorial ingest ->
Run workflow** and enter its issue number.

## Hourly ChatGPT scheduled-task prompt

```text
Every hour, find 1–10 recent, verifiable, student-relevant stories from primary sources or reputable reporting in Technology, Startups, AI & ML, Science, Engineering, India, or Business. Avoid stories already submitted. Verify every URL, publication time, image URL, number, name, location, and claim from the source. Create one GitHub issue in manasvignesh/Cie-Daily-Studio with title "CIE Editorial ingest — YYYY-MM-DD HH:mm UTC", label "cie-editorial-ingest", and an issue body containing only this JSON shape: {"stories":[{"title":"...","sourceUrl":"https://...","sourceName":"...","publishedAt":"ISO-8601 with timezone","domain":"one allowed domain","summary":"at least 40 factual characters","keyFacts":["at least two source-supported facts"],"location":"...","imageUrl":"https://..."}]}. Do not publish or approve anything. Stop after creating the labeled issue and report its URL.
```
