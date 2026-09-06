# CIE Daily ChatGPT editorial tool

This integration exposes exactly one write action: `submit_editorial_story`.
It accepts one to ten canonical stories, forwards them to the existing production
`POST /api/editorial-ingest` endpoint, runs the existing NVIDIA generation
pipeline, and stops at `ready_for_review`. It has no approve or publish action.

## Architecture

```text
ChatGPT scheduled task / custom app
  -> POST /api/mcp (submit_editorial_story)
  -> server-held CIE_DAILY_TOOL_API_KEY authentication
  -> server-held EDITORIAL_INGEST_SECRET
  -> POST /api/editorial-ingest
  -> editorial_queue
  -> existing NVIDIA formatter
  -> ready_for_review
  -> human review in Editorial Inbox
```

`EDITORIAL_INGEST_SECRET` never appears in the MCP tool schema, OpenAPI schema,
browser bundle, scheduled-task prompt, or tool response.

## Required production variables

Configure these as encrypted server-only Vercel variables. Never prefix either
name with `VITE_`.

- `EDITORIAL_INGEST_SECRET`: the existing ingestion credential.
- `CIE_DAILY_TOOL_API_KEY`: a separate high-entropy Bearer key used only by the
  ChatGPT/MCP adapter. Do not reuse the ingestion credential.

## ChatGPT custom app (recommended for scheduled tasks)

1. Deploy this repository over HTTPS.
2. In ChatGPT web, enable Developer Mode for the applicable workspace.
3. Open **Settings -> Apps -> Create**.
4. Set the MCP server URL to `https://cie-daily-studio.vercel.app/api/mcp`.
5. Configure Bearer authentication with `CIE_DAILY_TOOL_API_KEY` when the
   workspace offers static Bearer credentials. If the workspace requires OAuth,
   place an OAuth-capable gateway in front of this endpoint and have that gateway
   inject the same Bearer key; do not make the MCP endpoint public.
6. Scan tools and verify that only `submit_editorial_story` is listed.
7. Create a scheduled task that discovers and verifies news, then invokes the
   connected CIE Daily app with batches of at most ten stories.
8. Grant persistent permission for this write action if the workspace permits it;
   otherwise a scheduled run can pause for approval.

Suggested scheduled instruction:

> Find recent, verifiable student-relevant news from authoritative sources.
> Submit only stories not previously submitted, in batches of at most 10, using
> CIE Daily's `submit_editorial_story` tool. Include every canonical field. Never
> approve or publish; stop after the tool reports the queue status.

## Custom GPT Action (manual compatibility)

Custom GPT Actions are useful for interactive/manual operation, but scheduled
ChatGPT tasks do not run custom GPTs. Import this deployed schema in the GPT
Action editor:

`https://cie-daily-studio.vercel.app/cie-daily-editorial-openapi.yaml`

Choose API key authentication, Bearer mode, and enter
`CIE_DAILY_TOOL_API_KEY`. Do not enter `EDITORIAL_INGEST_SECRET`.

## HTTP and MCP smoke tests

The REST-compatible Action endpoint is:

```text
POST https://cie-daily-studio.vercel.app/api/chatgpt/editorial-stories
Authorization: Bearer <CIE_DAILY_TOOL_API_KEY>
Content-Type: application/json
```

The MCP endpoint is:

```text
POST https://cie-daily-studio.vercel.app/api/mcp
Authorization: Bearer <CIE_DAILY_TOOL_API_KEY>
Content-Type: application/json
Accept: application/json, text/event-stream
```

Use JSON-RPC `initialize`, `tools/list`, then `tools/call` with the tool name
`submit_editorial_story`. Confirm that the result contains queue IDs and
`published: false`, and that the Editorial Inbox shows the items as
`ready_for_review` before ending the test.
