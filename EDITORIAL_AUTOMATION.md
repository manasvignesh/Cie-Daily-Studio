# Editorial automation

## Data flow

`POST /api/editorial-ingest` validates each story, checks `editorial_queue` for
duplicates, creates a `discovered` queue item, and returns its ID without
waiting for AI generation. A scheduled GitHub worker invokes `/api/editorial-worker`, which atomically
claims one pending or stale item per HTTP request, runs the existing Gemini-first
article formatter,
validates the canonical schema-v2 output, and stops at `ready_for_review`.
A Studio editor then reviews, edits, regenerates, rejects, or approves the item.
Approval uses the same `toPublishedPost` contract as manual articles and creates
one `posts/{id}` document consumed by the app and website.

Both the manual Generate button and automated editorial ingestion call the same
server-side `generateArticle` function. They therefore use the same Gemini-primary,
NVIDIA-fallback model, prompt, JSON parser, and `quick_brief` + `full_article`
schema.

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
CRON_SECRET=<optional; only needed if you later move the worker to Vercel Cron>
EDITORIAL_DOMAINS=Technology,Startups,AI & ML,Science,Engineering,India,Business
FIREBASE_PROJECT_ID=cie-connect
FIREBASE_SERVICE_ACCOUNT_JSON=<Firebase service account JSON>
```

Gemini is the primary provider. `GEMINI_API_KEY_2` is tried next when present;
NVIDIA keys are then used as fallback credentials if Gemini times out, is
unavailable, rate-limited, returns invalid JSON, or fails schema validation.
The exact same priority is used by manual Generate and the Editorial Worker.
Keep all provider keys server-side.

The checked-in `api/index.ts` exposes the Express API and the repository's
`.github/workflows/editorial-worker.yml` invokes the worker every five minutes.
It reuses the Actions `EDITORIAL_INGEST_SECRET` for worker authentication, so no
new Vercel secret is required. Each HTTP invocation atomically claims exactly one
story. The scheduled workflow makes up to three sequential HTTP invocations and
stops early when the endpoint reports no work, avoiding Vercel's single-invocation
timeout while still draining up to three stories per workflow run. The workflow also
triggers automatically after a successful editorial-ingest workflow. It retries stale
processing items after five minutes, and always records `failed` on timeout or
provider failure.
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
Record each response. A successful response means the story was queued and
includes a queue ID; it does not wait for generation. The worker later moves the
item through `processing` to `ready_for_review` or `failed`. Never publish an
article automatically.
```

ChatGPT scheduled tasks cannot be assumed to possess arbitrary webhook credentials
or make authenticated outbound POST requests in every product/environment. If the
scheduler cannot send the request directly, use the smallest bridge: a scheduled
GitHub Action, Cloud Scheduler job, Make/Zapier webhook, or tiny trusted function
that holds `EDITORIAL_INGEST_SECRET` server-side and forwards the JSON payload.

The repository's GitHub labeled-issue bridge is documented in
[GITHUB_EDITORIAL_BRIDGE.md](./GITHUB_EDITORIAL_BRIDGE.md). It validates a
canonical issue body, forwards it with the Actions secret, comments counts, and
closes only fully successful issues. It never approves or publishes.
