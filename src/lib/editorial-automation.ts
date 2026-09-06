import type { Article } from './types';
import { toPublishedPost, validateArticle } from './article-contract';

export const editorialStatuses = [
  'discovered',
  'processing',
  'ready_for_review',
  'approved',
  'published',
  'rejected',
  'failed',
] as const;

export type EditorialStatus = (typeof editorialStatuses)[number];

export type IngestStory = {
  title: string;
  sourceUrl: string;
  sourceName: string;
  publishedAt: string;
  domain: string;
  summary: string;
  keyFacts: string[];
  location?: string;
  imageUrl?: string;
};

export type DuplicateInfo = {
  kind: 'exact' | 'likely';
  matchedQueueId: string;
  score: number;
};

export type EditorialQueueItem = {
  id: string;
  status: EditorialStatus;
  source: IngestStory;
  canonicalSourceUrl: string;
  normalizedHeadline: string;
  generatedArticle: Article | null;
  duplicate: DuplicateInfo | null;
  validationErrors: string[];
  failureReason: string | null;
  generationAttempts: number;
  publishedArticleId: string | null;
  receivedAt?: unknown;
  updatedAt?: unknown;
  publishedAt?: unknown;
};

export type EditorialStore = {
  listRecent(limit?: number): Promise<EditorialQueueItem[]>;
  create(item: Omit<EditorialQueueItem, 'id'>): Promise<EditorialQueueItem>;
  get(id: string): Promise<EditorialQueueItem | null>;
  update(id: string, patch: Partial<EditorialQueueItem>): Promise<void>;
  publish(
    queueId: string,
    post: Record<string, unknown>,
  ): Promise<string>;
};

export type EditorialGenerator = (
  source: IngestStory,
  validationFeedback?: string[],
) => Promise<Pick<Article, 'quick_brief' | 'full_article'>>;

export type EditorialIdentity = {
  uid: string;
  name: string;
  email: string;
  avatar?: string;
};

export class EditorialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export type EditorialFailureCategory =
  | 'ai_generation_failed'
  | 'firebase_write_failed'
  | 'schema_validation_failed'
  | 'duplicate'
  | 'timeout'
  | 'configuration_missing'
  | 'invalid_payload'
  | 'processing_failed';

/**
 * Converts provider/database exceptions into a small, safe diagnostic vocabulary.
 * The original exception is still logged by the server, but never returned to a
 * caller or persisted in the editorial queue.
 */
export function classifyEditorialFailure(error: unknown): EditorialFailureCategory {
  if (error instanceof EditorialError) {
    if (error.code === 'invalid_payload') return 'invalid_payload';
    if (error.code === 'duplicate') return 'duplicate';
  }
  const value = error as { code?: unknown; status?: unknown; name?: unknown };
  const code = String(value?.code || '').toLowerCase();
  const name = String(value?.name || '').toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  if (/timeout|timed.?out|deadline|aborted|aborterror/.test(`${code} ${name} ${message}`)) {
    return 'timeout';
  }
  if (/invalid_generated_json|generated_schema_missing|failed validation|schema_validation/.test(message)) {
    return 'schema_validation_failed';
  }
  if (/ai_not_configured|nvidia|gemini|openai|empty_ai_response|generation_failed|chat\.completions/.test(`${code} ${name} ${message}`)) {
    return /ai_not_configured|not configured|missing.*(key|secret)|api key/.test(message)
      ? 'configuration_missing'
      : 'ai_generation_failed';
  }
  if (/firebase|firestore|google.?cloud|permission-denied|failed-precondition|unavailable|service account|default credentials/.test(`${code} ${name} ${message}`)) {
    return 'firebase_write_failed';
  }
  return 'processing_failed';
}

export function safeEditorialFailureMessage(category: EditorialFailureCategory) {
  switch (category) {
    case 'ai_generation_failed':
      return 'The AI generation service could not produce this story.';
    case 'firebase_write_failed':
      return 'The editorial queue could not be saved.';
    case 'schema_validation_failed':
      return 'The generated article did not match the required schema.';
    case 'timeout':
      return 'Editorial processing timed out. Retry the story.';
    case 'configuration_missing':
      return 'Editorial generation is not configured on the server.';
    case 'invalid_payload':
      return 'The submitted story did not pass validation.';
    case 'duplicate':
      return 'This story was already submitted.';
    default:
      return 'Story processing failed.';
  }
}

const defaultDomains = [
  'AI & ML',
  'Business',
  'Engineering',
  'India',
  'Science',
  'Startups',
  'Technology',
];

const cleanText = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

export function canonicalizeSourceUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeHeadline(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|and|or|of|to|in|for|on|with|from|by)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateIngestStory(
  input: unknown,
  allowedDomains = defaultDomains,
): { story?: IngestStory; errors: string[] } {
  const body = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  const story: IngestStory = {
    title: cleanText(body.title),
    sourceUrl: cleanText(body.sourceUrl),
    sourceName: cleanText(body.sourceName),
    publishedAt: cleanText(body.publishedAt),
    domain: cleanText(body.domain),
    summary: cleanText(body.summary),
    keyFacts: Array.isArray(body.keyFacts)
      ? body.keyFacts.map(cleanText).filter(Boolean).slice(0, 12)
      : [],
    location: cleanText(body.location) || undefined,
    imageUrl: cleanText(body.imageUrl) || undefined,
  };
  const errors: string[] = [];
  if (story.title.length < 8) errors.push('title must be at least 8 characters');
  if (!canonicalizeSourceUrl(story.sourceUrl)) {
    errors.push('sourceUrl must be a valid HTTP or HTTPS URL');
  }
  if (!story.sourceName) errors.push('sourceName is required');
  const publicationDate = Date.parse(story.publishedAt);
  if (!story.publishedAt || Number.isNaN(publicationDate)) {
    errors.push('publishedAt must be a valid date/time');
  }
  if (!allowedDomains.some((domain) =>
    domain.toLowerCase() === story.domain.toLowerCase())) {
    errors.push(`domain must be one of: ${allowedDomains.join(', ')}`);
  } else {
    story.domain = allowedDomains.find((domain) =>
      domain.toLowerCase() === story.domain.toLowerCase())!;
  }
  if (story.summary.length < 40) {
    errors.push('summary must contain at least 40 characters of reporting');
  }
  if (story.keyFacts.length < 2) errors.push('keyFacts must contain at least 2 facts');
  if (story.imageUrl && !canonicalizeSourceUrl(story.imageUrl)) {
    errors.push('imageUrl must be a valid HTTP or HTTPS URL');
  }
  return errors.length ? { errors } : { story, errors };
}

function headlineSimilarity(left: string, right: string) {
  const a = new Set(normalizeHeadline(left).split(' ').filter(Boolean));
  const b = new Set(normalizeHeadline(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function findDuplicate(
  story: IngestStory,
  existing: EditorialQueueItem[],
): DuplicateInfo | null {
  const canonical = canonicalizeSourceUrl(story.sourceUrl);
  const exact = existing.find((item) => item.canonicalSourceUrl === canonical);
  if (exact) return { kind: 'exact', matchedQueueId: exact.id, score: 1 };

  const published = Date.parse(story.publishedAt);
  let best: DuplicateInfo | null = null;
  for (const item of existing) {
    const otherPublished = Date.parse(item.source.publishedAt);
    if (Number.isFinite(published) && Number.isFinite(otherPublished) &&
        Math.abs(published - otherPublished) > 7 * 24 * 60 * 60 * 1000) {
      continue;
    }
    const score = headlineSimilarity(story.title, item.source.title);
    if (score >= 0.72 && (!best || score > best.score)) {
      best = { kind: 'likely', matchedQueueId: item.id, score };
    }
  }
  return best;
}

export function sourceText(story: IngestStory) {
  return [
    `Headline: ${story.title}`,
    `Source: ${story.sourceName}`,
    `Source URL: ${story.sourceUrl}`,
    `Published: ${story.publishedAt}`,
    `Domain: ${story.domain}`,
    story.location ? `Location: ${story.location}` : '',
    `Reported summary: ${story.summary}`,
    'Reported facts:',
    ...story.keyFacts.map((fact) => `- ${fact}`),
  ].filter(Boolean).join('\n');
}

function articleFromGeneration(
  story: IngestStory,
  generated: Pick<Article, 'quick_brief' | 'full_article'>,
): Article {
  return {
    id: '',
    schema_version: 2,
    status: 'draft',
    category: 'Article',
    title: generated.quick_brief.headline,
    quick_brief: generated.quick_brief,
    full_article: generated.full_article,
    raw_input: sourceText(story),
    imageUrl: story.imageUrl,
    mediaUrls: story.imageUrl ? [story.imageUrl] : [],
  };
}

export function articleValidationErrors(article: Article) {
  return validateArticle(article)
    .filter((issue) => issue.level === 'error')
    .map((issue) => `${issue.path}: ${issue.message}`);
}

function safeFailure(error: unknown) {
  const category = classifyEditorialFailure(error);
  if (category === 'schema_validation_failed' && error instanceof Error) {
    return `${category}: ${error.message.slice(0, 200)}`;
  }
  return `${category}: ${safeEditorialFailureMessage(category)}`;
}

export class EditorialService {
  constructor(
    private readonly store: EditorialStore,
    private readonly generator: EditorialGenerator,
    private readonly allowedDomains = defaultDomains,
    private readonly maxGenerationAttempts = 2,
  ) {}

  domains() {
    return [...this.allowedDomains];
  }

  list() {
    return this.store.listRecent(100);
  }

  async ingest(input: unknown) {
    const validation = validateIngestStory(input, this.allowedDomains);
    if (!validation.story) {
      throw new EditorialError('invalid_payload', validation.errors.join('; '), 400);
    }
    const story = validation.story;
    const duplicate = findDuplicate(story, await this.store.listRecent(100));
    const created = await this.store.create({
      status: 'discovered',
      source: story,
      canonicalSourceUrl: canonicalizeSourceUrl(story.sourceUrl),
      normalizedHeadline: normalizeHeadline(story.title),
      generatedArticle: null,
      duplicate,
      validationErrors: [],
      failureReason: null,
      generationAttempts: 0,
      publishedArticleId: null,
    });
    if (duplicate) return created;
    return this.process(created.id, story);
  }

  async process(id: string, story: IngestStory) {
    await this.store.update(id, {
      status: 'processing',
      failureReason: null,
      validationErrors: [],
    });
    let feedback: string[] = [];
    let lastFailure = '';
    for (let attempt = 1; attempt <= this.maxGenerationAttempts; attempt += 1) {
      try {
        const generated = await this.generator(story, feedback);
        const article = articleFromGeneration(story, generated);
        feedback = articleValidationErrors(article);
        if (feedback.length) {
          lastFailure = `Generated article failed validation: ${feedback.join('; ')}`;
          continue;
        }
        await this.store.update(id, {
          status: 'ready_for_review',
          generatedArticle: article,
          generationAttempts: attempt,
          validationErrors: [],
          failureReason: null,
          duplicate: null,
        });
        return (await this.store.get(id))!;
      } catch (error) {
        lastFailure = safeFailure(error);
        feedback = [lastFailure];
      }
    }
    await this.store.update(id, {
      status: 'failed',
      generationAttempts: this.maxGenerationAttempts,
      validationErrors: feedback,
      failureReason: lastFailure || 'Generation failed validation',
    });
    return (await this.store.get(id))!;
  }

  async regenerate(id: string) {
    const item = await this.required(id);
    return this.process(id, item.source);
  }

  async edit(id: string, generatedArticle: Article) {
    const item = await this.required(id);
    if (item.status === 'published' || item.status === 'rejected') {
      throw new EditorialError('invalid_status', 'Published or rejected items cannot be edited.', 409);
    }
    if (!generatedArticle?.quick_brief || !generatedArticle?.full_article) {
      throw new EditorialError('invalid_article', 'Both Quick Brief and Full Story are required.', 422);
    }
    const article = articleFromGeneration(item.source, generatedArticle);
    const errors = articleValidationErrors(article);
    if (errors.length) {
      throw new EditorialError('invalid_article', errors.join('; '), 422);
    }
    await this.store.update(id, {
      generatedArticle: article,
      status: 'ready_for_review',
      validationErrors: [],
      failureReason: null,
    });
    return (await this.store.get(id))!;
  }

  async reject(id: string) {
    const item = await this.required(id);
    if (item.status === 'published') {
      throw new EditorialError('invalid_status', 'Published items cannot be rejected.', 409);
    }
    await this.store.update(id, { status: 'rejected' });
    return (await this.store.get(id))!;
  }

  async publish(id: string, identity: EditorialIdentity) {
    const item = await this.required(id);
    if (item.status === 'published' && item.publishedArticleId) return item;
    if (item.status !== 'ready_for_review' || !item.generatedArticle) {
      throw new EditorialError('not_ready', 'This story is not ready to publish.', 409);
    }
    const errors = articleValidationErrors(item.generatedArticle);
    if (errors.length) {
      throw new EditorialError('invalid_article', errors.join('; '), 422);
    }
    await this.store.update(id, { status: 'approved' });
    try {
      const post = {
        ...toPublishedPost(item.generatedArticle, identity),
        sourceUrl: item.source.sourceUrl,
        sourceName: item.source.sourceName,
        sourcePublishedAt: item.source.publishedAt,
        editorialQueueId: id,
      };
      const publishedArticleId = await this.store.publish(id, post);
      return (await this.store.get(id)) ?? {
        ...item,
        status: 'published' as const,
        publishedArticleId,
      };
    } catch (error) {
      await this.store.update(id, {
        status: 'ready_for_review',
        failureReason: `Publish failed: ${safeFailure(error)}`,
      });
      throw error;
    }
  }

  private async required(id: string) {
    const item = await this.store.get(id);
    if (!item) throw new EditorialError('not_found', 'Editorial item not found.', 404);
    return item;
  }
}
