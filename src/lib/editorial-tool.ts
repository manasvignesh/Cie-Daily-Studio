import type { IngestStory } from './editorial-automation';

export const editorialStoryJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'sourceUrl',
    'sourceName',
    'publishedAt',
    'domain',
    'summary',
    'keyFacts',
  ],
  properties: {
    title: { type: 'string', minLength: 8, maxLength: 300 },
    sourceUrl: { type: 'string', format: 'uri' },
    sourceName: { type: 'string', minLength: 1, maxLength: 120 },
    publishedAt: { type: 'string', format: 'date-time' },
    domain: {
      type: 'string',
      enum: ['Technology', 'Startups', 'AI & ML', 'Science', 'Engineering', 'India', 'Business'],
    },
    summary: { type: 'string', minLength: 40, maxLength: 4000 },
    keyFacts: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    location: { type: 'string', maxLength: 200 },
    imageUrl: { type: 'string', format: 'uri' },
  },
} as const;

export const submitEditorialStoryInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      description: 'One to ten verified news stories. Each story is queued for human review and is never auto-published.',
      minItems: 1,
      maxItems: 10,
      items: editorialStoryJsonSchema,
    },
  },
} as const;

export type SubmitEditorialStoriesInput = { stories: IngestStory[] };

export class EditorialToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseSubmitEditorialStoriesInput(value: unknown): SubmitEditorialStoriesInput {
  if (!value || typeof value !== 'object') {
    throw new EditorialToolError('invalid_tool_input', 'The tool input must be a JSON object.', 400);
  }
  const stories = (value as { stories?: unknown }).stories;
  if (!Array.isArray(stories) || stories.length < 1 || stories.length > 10) {
    throw new EditorialToolError('invalid_tool_input', 'stories must contain between 1 and 10 items.', 400);
  }
  return { stories: stories as IngestStory[] };
}

export type EditorialIngestResult = {
  ok: boolean;
  id?: string;
  status?: string;
  duplicate?: unknown;
  error?: string;
  message?: string;
};

export type EditorialToolResult = {
  ok: boolean;
  submitted: number;
  readyForReview: number;
  published: false;
  results: EditorialIngestResult[];
};

export async function submitEditorialStories(
  input: unknown,
  options: {
    ingestSecret: string;
    ingestUrl?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<EditorialToolResult> {
  const { stories } = parseSubmitEditorialStoriesInput(input);
  if (!options.ingestSecret) {
    throw new EditorialToolError(
      'editorial_tool_not_configured',
      'The editorial submission service is not configured.',
      503,
    );
  }
  const ingestUrl = options.ingestUrl || 'https://cie-daily-studio.vercel.app/api/editorial-ingest';
  const response = await (options.fetchImpl || fetch)(ingestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.ingestSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ stories }),
    signal: AbortSignal.timeout(58_000),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EditorialToolError(
      'editorial_ingest_invalid_response',
      'The Editorial Inbox returned an invalid response.',
      502,
    );
  }

  if (!response.ok) {
    const safeMessage = body && typeof body === 'object' &&
        typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : 'The Editorial Inbox rejected the submission.';
    throw new EditorialToolError(
      'editorial_ingest_failed',
      safeMessage,
      response.status >= 400 && response.status < 600 ? response.status : 502,
      body,
    );
  }

  const rawResults = body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)
    ? (body as { results: EditorialIngestResult[] }).results
    : [body as EditorialIngestResult];
  return {
    ok: rawResults.every((result) => result?.ok === true),
    submitted: rawResults.length,
    readyForReview: rawResults.filter((result) => result?.status === 'ready_for_review').length,
    published: false,
    results: rawResults,
  };
}

export const submitEditorialStoryTool = {
  name: 'submit_editorial_story',
  title: 'Submit editorial stories',
  description: 'Submit one to ten verified news stories to the CIE Daily Editorial Inbox. The existing NVIDIA pipeline generates the Swipe Deck and Full Story, then stops at Ready for Review. This tool never approves or publishes articles.',
  inputSchema: submitEditorialStoryInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;
