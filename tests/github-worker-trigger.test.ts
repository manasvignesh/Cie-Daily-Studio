import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatchEditorialWorker } from '../src/lib/github-worker-trigger';

test('worker dispatch stays server-side and sends only the workflow ref', async () => {
  let request: RequestInit | undefined;
  const result = await dispatchEditorialWorker({
    token: 'server-only-token',
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 204);
  assert.match(String(request?.headers && new Headers(request.headers).get('Authorization')), /^Bearer /);
  assert.deepEqual(JSON.parse(String(request?.body)), { ref: 'main' });
});

test('missing worker token leaves queue safe and reports not configured', async () => {
  let called = false;
  const result = await dispatchEditorialWorker({
    token: '',
    fetchImpl: async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { dispatched: false, reason: 'not_configured' });
  assert.equal(called, false);
});

test('dispatch failures are safe and do not expose response content', async () => {
  const result = await dispatchEditorialWorker({
    token: 'server-only-token',
    fetchImpl: async () => new Response('secret-looking provider detail', { status: 500 }),
  });
  assert.deepEqual(result, { dispatched: false, reason: 'http_error', status: 500 });
});
