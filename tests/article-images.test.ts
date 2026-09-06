import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArticleImage } from '../src/lib/article-images';
import type { IngestStory } from '../src/lib/editorial-automation';

const story: IngestStory = {
  title: 'A verified campus technology story',
  sourceUrl: 'https://news.example.org/story',
  sourceName: 'News Example',
  publishedAt: '2026-09-06T10:00:00Z',
  domain: 'Technology',
  summary: 'A campus technology project has reached a new development milestone with practical student impact.',
  keyFacts: ['The project reached a milestone.', 'Students participated in testing.'],
};

function response(body: string, type: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } });
}

test('uses a reachable supplied image before fetching the page', async () => {
  const calls: string[] = [];
  const image = 'https://cdn.example.org/hero.jpg';
  const result = await resolveArticleImage({ ...story, imageUrl: image }, async (url, init) => {
    calls.push(`${init?.method}:${url}`);
    return response('', 'image/jpeg', 200, { 'content-length': '20000' });
  });
  assert.equal(result, image);
  assert.equal(calls.length, 1);
});

test('discovers and verifies og:image', async () => {
  const image = 'https://cdn.example.org/og.jpg';
  const result = await resolveArticleImage(story, async (url, init) =>
    init?.method === 'GET' && url === story.sourceUrl
      ? response(`<meta property="og:image" content="${image}">`, 'text/html')
      : response('', 'image/jpeg', 200, { 'content-length': '20000' }));
  assert.equal(result, image);
});

test('falls back to twitter:image and resolves relative URLs', async () => {
  const result = await resolveArticleImage(story, async (url, init) =>
    init?.method === 'GET' && url === story.sourceUrl
      ? response('<meta name="twitter:image" content="/media/hero.webp">', 'text/html')
      : response('', 'image/webp', 200, { 'content-length': '25000' }));
  assert.equal(result, 'https://news.example.org/media/hero.webp');
});

test('rejects broken, tiny, and noisy images and returns no image when none is usable', async () => {
  const result = await resolveArticleImage({ ...story, imageUrl: 'https://cdn.example.org/logo.png' }, async (url, init) =>
    init?.method === 'GET' && url === story.sourceUrl
      ? response('<meta property="og:image" content="https://cdn.example.org/pixel.gif">', 'text/html')
      : response('', 'image/gif', 404, { 'content-length': '20' }));
  assert.equal(result, undefined);
});

