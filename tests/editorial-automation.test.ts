import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditorialError,
  EditorialService,
  classifyEditorialFailure,
  firestoreSafeIngestStory,
  safeEditorialFailureMessage,
  type EditorialQueueItem,
  type EditorialStore,
  type IngestStory,
} from '../src/lib/editorial-automation';
import type { Article } from '../src/lib/types';

test('classifies editorial failures without exposing provider details', () => {
  assert.equal(classifyEditorialFailure(new Error('NVIDIA 429 rate limit')), 'ai_generation_failed');
  assert.equal(classifyEditorialFailure(new Error('invalid_generated_json')), 'schema_validation_failed');
  assert.equal(classifyEditorialFailure(new Error('Firestore permission-denied')), 'firebase_write_failed');
  assert.equal(classifyEditorialFailure(Object.assign(new Error('deadline exceeded'), { code: 504 })), 'timeout');
  assert.equal(safeEditorialFailureMessage('firebase_write_failed'), 'The editorial queue could not be saved.');
});

test('removes undefined optional fields before Firestore serialization', () => {
  const safe = firestoreSafeIngestStory({ ...story, imageUrl: undefined, location: undefined });
  assert.equal('imageUrl' in safe, false);
  assert.equal('location' in safe, false);
});

test('removes undefined optional fields before Firestore serialization', () => {
  const safe = firestoreSafeIngestStory({ ...story, imageUrl: undefined, location: undefined });
  assert.equal('imageUrl' in safe, false);
  assert.equal('location' in safe, false);
});

const story: IngestStory = {
  title: 'Indian students build a low-cost satellite communications platform',
  sourceUrl: 'https://universitynews.org/news/student-satellite?utm_source=social',
  sourceName: 'Example News',
  publishedAt: '2026-09-06T08:30:00+05:30',
  domain: 'Technology',
  summary: 'A student engineering team has demonstrated a lower-cost satellite communications platform after completing tests at its university laboratory.',
  keyFacts: [
    'The prototype was developed by a university student engineering team.',
    'The team completed a controlled laboratory demonstration this week.',
    'The reported goal is to reduce the cost of satellite communications hardware.',
  ],
  location: 'India',
};

const generated: Pick<Article, 'quick_brief' | 'full_article'> = {
  quick_brief: {
    category: 'Technology',
    headline: 'Indian students demonstrate lower-cost satellite communications platform',
    quick_summary: 'A university engineering team has demonstrated a lower-cost satellite communications platform in controlled laboratory testing, aiming to make communications hardware more accessible without changing the facts reported by the original source.',
    three_things_to_know: [
      'University students developed the communications platform prototype.',
      'The reported demonstration took place in a controlled laboratory.',
      'The project aims to reduce satellite communications hardware costs.',
    ],
    key_number: null,
  },
  full_article: {
    headline: 'Indian students demonstrate lower-cost satellite communications platform',
    hook: 'A student-built prototype is exploring whether satellite communications hardware can be made more accessible.',
    in_20_seconds: 'A university engineering team completed a controlled demonstration of its communications platform.',
    what_happened: 'A university student engineering team has demonstrated a satellite communications platform developed to explore lower-cost hardware. According to the supplied report, the team completed a controlled laboratory test this week. The demonstration focused on the prototype described by the students and did not establish commercial availability or performance beyond the reported test.',
    why_this_matters: 'Satellite communications projects can give engineering students experience across hardware, software, radio systems and testing. A prototype focused on lowering hardware costs may also help students examine practical constraints that are often hidden in classroom exercises, while the reported laboratory result remains an early technical step rather than a commercial launch.',
    bigger_picture: 'Student engineering teams frequently use working prototypes to turn classroom concepts into systems that can be tested, measured and improved. This project sits within that educational pattern, with any broader impact dependent on later evidence and development.',
    key_stats: [],
    explore_sections: [
      {
        title: 'What the team built',
        summary: 'A student-developed communications prototype',
        content: 'The supplied reporting describes a satellite communications platform built by a university engineering team. Its stated focus is reducing the cost of communications hardware while giving the team a system they can evaluate through controlled testing and iteration in a laboratory setting.',
        items: [],
      },
      {
        title: 'What the test established',
        summary: 'A controlled demonstration, not a commercial launch',
        content: 'The team completed a controlled laboratory demonstration this week. The report does not claim commercial deployment, independent certification or performance outside the laboratory, so the result should be understood as an early prototype milestone that can guide later engineering work.',
        items: [],
      },
    ],
    takeaways: [
      'Students built the reported satellite communications prototype.',
      'The team completed a controlled laboratory demonstration.',
      'The project focuses on reducing communications hardware costs.',
    ],
    quote: null,
  },
};

class MemoryStore implements EditorialStore {
  items = new Map<string, EditorialQueueItem>();
  posts = new Map<string, Record<string, unknown>>();
  failPublish = false;
  sequence = 0;

  async listRecent() { return [...this.items.values()]; }
  async create(item: Omit<EditorialQueueItem, 'id'>) {
    const value = { id: `queue-${++this.sequence}`, ...structuredClone(item) };
    this.items.set(value.id, value);
    return structuredClone(value);
  }
  async get(id: string) {
    const value = this.items.get(id);
    return value ? structuredClone(value) : null;
  }
  async update(id: string, patch: Partial<EditorialQueueItem>) {
    const current = this.items.get(id);
    if (!current) throw new Error('missing queue item');
    this.items.set(id, { ...current, ...structuredClone(patch) });
  }
  async publish(queueId: string, post: Record<string, unknown>) {
    if (this.failPublish) throw new Error('simulated database outage');
    const articleId = `post-${this.posts.size + 1}`;
    this.posts.set(articleId, structuredClone(post));
    await this.update(queueId, { status: 'published', publishedArticleId: articleId });
    return articleId;
  }
}

test('sample ingestion reaches review and publishes the canonical schema', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated);
  const ready = await service.ingest(story);
  assert.equal(ready.status, 'ready_for_review');
  assert.equal(ready.generatedArticle?.schema_version, 2);
  const published = await service.publish(ready.id, { uid: 'editor', name: 'Editor', email: 'editor@example.com' });
  assert.equal(published.status, 'published');
  const post = [...store.posts.values()][0];
  assert.equal(post.status, 'approved');
  assert.equal(post.schema_version, 2);
  assert.deepEqual(post.quick_brief, generated.quick_brief);
  assert.deepEqual(post.full_article, generated.full_article);
  assert.equal(post.sourceUrl, story.sourceUrl);
});

test('malformed payload is rejected before queue creation', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated);
  await assert.rejects(() => service.ingest({ title: 'Bad' }), (error: EditorialError) => error.code === 'invalid_payload');
  assert.equal(store.items.size, 0);
});

test('async ingestion returns before a slow generation and resolves later', async () => {
  const store = new MemoryStore();
  let resolveGeneration!: (value: Pick<Article, 'quick_brief' | 'full_article'>) => void;
  const pending = new Promise<Pick<Article, 'quick_brief' | 'full_article'>>((resolve) => {
    resolveGeneration = resolve;
  });
  const service = new EditorialService(store, async () => pending, defaultDomainsForTest(), 2, false);
  const started = Date.now();
  const queued = await service.ingest(story);
  assert.ok(Date.now() - started < 500, 'queue creation must not wait for generation');
  assert.equal(queued.status, 'discovered');
  const processing = service.process(queued.id, story);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.get(queued.id))?.status, 'processing');
  resolveGeneration(generated);
  assert.equal((await processing).status, 'ready_for_review');
});

test('a batch of ten stories queues without synchronous generation', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated, defaultDomainsForTest(), 2, false);
  for (let index = 0; index < 10; index += 1) {
    const queued = await service.ingest({
      ...story,
      title: `${story.title} ${index + 1}`,
      sourceUrl: `https://example.com/news/student-satellite-${index + 1}`,
    });
    assert.equal(queued.status, 'discovered');
  }
  assert.equal(store.items.size, 10);
});

function defaultDomainsForTest() {
  return ['Technology', 'Startups', 'AI & ML', 'Science', 'Engineering', 'India', 'Business'];
}

test('exact and likely duplicates stop before generation', async () => {
  const store = new MemoryStore();
  let generations = 0;
  const service = new EditorialService(store, async () => { generations += 1; return generated; });
  await service.ingest(story);
  const exact = await service.ingest({ ...story, sourceUrl: 'https://www.universitynews.org/news/student-satellite?utm_medium=email' });
  assert.equal(exact.status, 'discovered');
  assert.equal(exact.duplicate?.kind, 'exact');
  const likely = await service.ingest({ ...story, sourceUrl: 'https://another-source.org/report', sourceName: 'Another Source' });
  assert.equal(likely.duplicate?.kind, 'likely');
  assert.equal(generations, 1);
});

test('unrelated IIT healthcare and ISRO launch stories are not duplicates', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated);
  await service.ingest({
    ...story,
    title: 'IIT Kharagpur affordable healthcare technology hub enters sustainable phase',
    sourceUrl: 'https://campusreport.org/iit-kharagpur-healthcare-hub',
    sourceName: 'Campus Report',
    domain: 'India',
    summary: 'IIT Kharagpur has moved an affordable healthcare technology hub into a sustainable operating phase for local innovation and student collaboration.',
    keyFacts: ['The hub focuses on affordable healthcare technology.', 'IIT Kharagpur is coordinating the initiative.'],
    location: 'Kharagpur',
  });
  const isro = await service.ingest({
    ...story,
    title: 'ISRO GSLV launch places navigation satellite into orbit',
    sourceUrl: 'https://spacewire.org/isro-gslv-navigation-launch',
    sourceName: 'Space Wire',
    domain: 'Science',
    summary: 'ISRO has launched a GSLV mission carrying a navigation satellite into orbit after the vehicle completed its scheduled flight sequence.',
    keyFacts: ['The mission used a GSLV launch vehicle.', 'The payload is a navigation satellite.'],
    location: 'Sriharikota',
  });
  assert.equal(isro.duplicate, null);
});

test('editor can clear a likely duplicate and requeue it', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated, defaultDomainsForTest(), 2, false);
  await service.ingest(story);
  const duplicate = await service.ingest({ ...story, sourceUrl: 'https://another-source.org/same-story', sourceName: 'Another Source' });
  assert.equal(duplicate.duplicate?.kind, 'likely');
  const cleared = await service.clearDuplicate(duplicate.id);
  assert.equal(cleared.duplicate, null);
  assert.equal(cleared.status, 'discovered');
});

test('failed and already-flagged records do not poison future duplicate checks', async () => {
  const failedStore = new MemoryStore();
  const failedService = new EditorialService(failedStore, async () => { throw new Error('provider unavailable'); });
  const failed = await failedService.ingest(story);
  assert.equal(failed.status, 'failed');
  const retry = await failedService.ingest({ ...story, sourceUrl: 'https://universitynews.org/news/student-satellite' });
  assert.equal(retry.duplicate, null);

  const duplicateStore = new MemoryStore();
  const duplicateService = new EditorialService(duplicateStore, async () => generated, defaultDomainsForTest(), 2, false);
  const original = await duplicateService.ingest(story);
  const flagged = await duplicateService.ingest({ ...story, sourceUrl: 'https://another-source.org/same-story', sourceName: 'Another Source' });
  assert.equal(flagged.duplicate?.kind, 'likely');
  await duplicateStore.update(original.id, { status: 'failed' });
  const later = await duplicateService.ingest({ ...story, sourceUrl: 'https://third-source.org/same-story', sourceName: 'Third Source' });
  assert.equal(later.duplicate, null);
});

test('NVIDIA formatter failure and invalid output are isolated as failed items', async () => {
  const failingStore = new MemoryStore();
  const failing = new EditorialService(failingStore, async () => { throw new Error('provider unavailable'); });
  const failed = await failing.ingest(story);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.generationAttempts, 2);

  const invalidStore = new MemoryStore();
  const invalid = new EditorialService(invalidStore, async () => ({
    quick_brief: { ...generated.quick_brief, headline: '' },
    full_article: { ...generated.full_article, what_happened: '' },
  }));
  const invalidItem = await invalid.ingest({ ...story, sourceUrl: 'https://example.com/second' });
  assert.equal(invalidItem.status, 'failed');
  assert.ok(invalidItem.validationErrors.length > 0);
});

test('publish failure restores ready-for-review and keeps generated content', async () => {
  const store = new MemoryStore();
  const service = new EditorialService(store, async () => generated);
  const ready = await service.ingest(story);
  store.failPublish = true;
  await assert.rejects(() => service.publish(ready.id, { uid: 'editor', name: 'Editor', email: 'editor@example.com' }));
  const recovered = await store.get(ready.id);
  assert.equal(recovered?.status, 'ready_for_review');
  assert.ok(recovered?.generatedArticle);
  assert.match(recovered?.failureReason || '', /Publish failed/);
});
