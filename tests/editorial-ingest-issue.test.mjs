import assert from "node:assert/strict";
import { test } from "node:test";

import {
  forwardToEditorialIngest,
  parseIssueBody,
  validateIssueTitle,
  validatePayload,
} from "../scripts/editorial-ingest-issue.mjs";

const story = {
  title: "A student engineering team tests a new satellite sensor",
  sourceUrl: "https://example.com/news/satellite-sensor",
  sourceName: "Example News",
  publishedAt: "2026-09-06T08:30:00+05:30",
  domain: "Engineering",
  summary:
    "A university engineering team completed a controlled test of a new satellite sensor prototype this week.",
  keyFacts: [
    "The prototype was tested in a controlled laboratory.",
    "The team is made up of university engineering students.",
  ],
  location: "India",
  imageUrl: "https://example.com/images/satellite.webp",
};

test("parses direct and fenced issue JSON", () => {
  assert.deepEqual(parseIssueBody(JSON.stringify({ stories: [story] })), {
    stories: [story],
  });
  assert.deepEqual(
    parseIssueBody(
      `\n\`\`\`json\n${JSON.stringify({ stories: [story] })}\n\`\`\``,
    ),
    { stories: [story] },
  );
});

test("validates title and canonical story fields", () => {
  assert.deepEqual(validateIssueTitle("CIE Editorial ingest — 2026-09-06"), []);
  assert.ok(validateIssueTitle("Random issue").length > 0);
  assert.deepEqual(validatePayload({ stories: [story] }), []);
  assert.ok(
    validatePayload({ stories: [{ ...story, summary: "short" }] }).length > 0,
  );
});

test("forwards only the canonical batch and returns the upstream result", async () => {
  let request;
  const results = await forwardToEditorialIngest(
    { stories: [story] },
    "server-only-secret",
    async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          results: [{ ok: true, id: "queue-1", status: "ready_for_review" }],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  assert.equal(
    request.url,
    "https://cie-daily-studio.vercel.app/api/editorial-ingest",
  );
  assert.equal(request.init.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(results[0], {
    ok: true,
    id: "queue-1",
    status: "ready_for_review",
  });
});

test("does not leak raw non-JSON responses", async () => {
  await assert.rejects(
    () =>
      forwardToEditorialIngest(
        { stories: [story] },
        "secret",
        async () =>
          new Response("<html>secret provider detail</html>", { status: 500 }),
      ),
    /instead of JSON/,
  );
});
