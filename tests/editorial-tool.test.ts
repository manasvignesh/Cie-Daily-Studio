import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditorialToolError,
  parseSubmitEditorialStoriesInput,
  submitEditorialStories,
} from '../src/lib/editorial-tool';

const story = {
  title: 'ISRO completes a planned orbit manoeuvre for EOS-05',
  sourceUrl: 'https://www.isro.gov.in/example.html',
  sourceName: 'ISRO',
  publishedAt: '2026-09-05T20:19:00+05:30',
  domain: 'Science',
  summary: 'ISRO reported that the planned spacecraft manoeuvre completed successfully and updated the estimated orbit.',
  keyFacts: ['The manoeuvre completed successfully.', 'Further manoeuvres are planned.'],
  location: 'India',
  imageUrl: 'https://www.isro.gov.in/example.webp',
};

test('tool accepts a batch of canonical stories', () => {
  assert.deepEqual(parseSubmitEditorialStoriesInput({ stories: [story] }), { stories: [story] });
});

test('tool rejects empty and oversized batches', () => {
  assert.throws(
    () => parseSubmitEditorialStoriesInput({ stories: [] }),
    (error: EditorialToolError) => error.code === 'invalid_tool_input',
  );
  assert.throws(
    () => parseSubmitEditorialStoriesInput({ stories: Array.from({ length: 11 }, () => story) }),
    (error: EditorialToolError) => error.code === 'invalid_tool_input',
  );
});

test('tool forwards to the existing ingestion endpoint without publishing', async () => {
  let request: RequestInit | undefined;
  const result = await submitEditorialStories(
    { stories: [story] },
    {
      ingestSecret: 'server-only-secret',
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({
          results: [{ ok: true, id: 'queue-test', status: 'ready_for_review', duplicate: null }],
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      },
    },
  );
  assert.equal(request?.method, 'POST');
  assert.equal((request?.headers as Record<string, string>).Authorization, 'Bearer server-only-secret');
  assert.equal(result.readyForReview, 1);
  assert.equal(result.published, false);
  assert.deepEqual(result.results.map((item) => item.status), ['ready_for_review']);
});

test('tool maps a non-JSON upstream failure to a safe error', async () => {
  await assert.rejects(
    () => submitEditorialStories(
      { stories: [story] },
      {
        ingestSecret: 'server-only-secret',
        fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }),
      },
    ),
    (error: EditorialToolError) => error.code === 'editorial_ingest_invalid_response' && error.status === 502,
  );
});
