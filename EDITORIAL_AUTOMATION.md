# Editorial automation

## Data flow

`POST /api/editorial-ingest` validates each story, checks `editorial_queue` for
duplicates, runs the existing NVIDIA article formatter, validates the canonical
schema-v2 output, and stops at
`ready_for_review`. A Studio editor then reviews, edits, regenerates, rejects, or
approves the item. Approval uses the same `toPublishedPost` contract as manual
articles and creates one `posts/{id}` document consumed by the app and website.

Both the manual Generate button and automated editorial ingestion call the same
server-side `generateArticle` function. They therefore use the same NVIDIA model,
prompt, JSON parser, and `quick_brief` + `full_article` schema. There is no second
AI provider in the automation path.

No story is automatically published.

## Server environment

Set these on the deployed Admin backend (never in Vite-prefixed variables):

```text
NVIDIA_API_KEY=
NVIDIA_API_KEY_2=
NVIDIA_API_KEY_3=
GEMINI_API_KEY=
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_MODEL=meta/muse-glimmer-30b
GEMINI_MODEL=gemini-2.5-flash
EDITORIAL_INGEST_SECRET=<a long random secret>
EDITORIAL_DOMAINS=Technology,Startups,AI & ML,Science,Engineering,India,Business
FIREBASE_PROJECT_ID=cie-connect
FIREBASE_SERVICE_ACCOUNT_JSON=<Firebase service account JSON>
```

The second and third NVIDIA keys are optional server-only fallbacks. They are
used only when an earlier credential is rejected, rate-limited, times out, or
the NVIDIA service returns a retryable upstream failure.

`GEMINI_API_KEY` is an optional final fallback and is sent only to Google's
official OpenAI-compatible Gemini endpoint. Keep it server-side.

The checked-in `api/index.ts` and `vercel.json` expose the Express API on Vercel.
Deploy the complete project, not only `dist`. The deployed endpoint is:

```text
https://<your-admin-domain>/api/editorial-ingest
```

## Request

```http
POST /api/editorial-ingest
Authorization: Bearer <EDITORIAL_INGEST_SECRET>
Content-Type: application/json
```

```json
{
  "title": "",
  "sourceUrl": "https://publisher.example/story",
  "sourceName": "Publisher name",
  "publishedAt": "2026-09-06T08:30:00+05:30",
  "domain": "Technology",
  "summary": "At least 40 characters of source-grounded reporting.",
  "keyFacts": ["Fact one", "Fact two"],
  "location": "India",
  "imageUrl": "https://publisher.example/image.jpg"
}
```

Up to ten independent stories may also be sent as `{ "stories": [ ... ] }`.
One failure does not stop the other items.

## ChatGPT scheduled-task prompt

```text
At each run, search for worthwhile, recently published student-relevant news in
these configured CIE Daily domains: Technology, Startups, AI & ML, Science,
Engineering, India, and Business. Prefer primary sources and reputable reporting.
Avoid stories already selected in earlier runs where possible. For every selected
story, verify the source URL and publication date/time. Do not fabricate or infer
numbers, dates, names, locations, quotes, company names, capacities, targets, or
statistics. Use only facts supported by the linked source.

For each story, create this JSON object:
{
  "title": "source-grounded headline",
  "sourceUrl": "canonical source URL",
  "sourceName": "publisher",
  "publishedAt": "ISO-8601 date/time with timezone",
  "domain": "one configured CIE Daily domain",
  "summary": "concise factual summary of at least 40 characters",
  "keyFacts": ["at least two source-supported facts"],
  "location": "reported location or empty string",
  "imageUrl": "verified source image URL or empty string"
}

POST each object to https://<your-admin-domain>/api/editorial-ingest with
Content-Type: application/json and Authorization: Bearer <INGESTION_SECRET>.
Record each response. Do not retry 400, 401, duplicate, or validation responses.
Retry a temporary 500/503 response once. Never publish an article; processing must
stop at Ready for Review in the CIE Daily Editorial Inbox.
```

ChatGPT scheduled tasks cannot be assumed to possess arbitrary webhook credentials
or make authenticated outbound POST requests in every product/environment. If the
scheduler cannot send the request directly, use the smallest bridge: a scheduled
GitHub Action, Cloud Scheduler job, Make/Zapier webhook, or tiny trusted function
that holds `EDITORIAL_INGEST_SECRET` server-side and forwards the JSON payload.
