import "dotenv/config";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  initializeApp,
  cert,
  getApps,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { AccessToken } from "livekit-server-sdk";
import OpenAI from "openai";
import {
  EditorialError,
  EditorialService,
  classifyEditorialFailure,
  editorialProcessingStaleAfterMs,
  firestoreSafeIngestStory,
  safeEditorialFailureMessage,
  sourceText,
  type EditorialQueueItem,
  type EditorialStore,
  type IngestStory,
} from "./src/lib/editorial-automation.ts";
import type { Article } from "./src/lib/types.ts";
import { validateArticle } from "./src/lib/article-contract.ts";
import { firestoreSafeValue } from "./src/lib/firestore-safe.ts";
import { resolveArticleImage } from "./src/lib/article-images.ts";
import {
  editorialGenerationBudgetMs,
  editorialPersistenceReserveMs,
  providerTimeoutMs,
} from "./src/lib/generation-budget.ts";
import {
  EditorialToolError,
  submitEditorialStories,
  submitEditorialStoryTool,
} from "./src/lib/editorial-tool.ts";

const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  "cie-connect";
let firebaseAdminInitializationError: unknown;
function ensureFirebaseAdmin() {
  if (getApps().length) return;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    initializeApp(
      raw
        ? { credential: cert(JSON.parse(raw)), projectId }
        : { projectId },
    );
    firebaseAdminInitializationError = undefined;
  } catch (error) {
    firebaseAdminInitializationError = error;
    console.error("[firebase-admin] initialization failed", error);
    throw error;
  }
}
try { ensureFirebaseAdmin(); } catch { /* Keep the API alive to return JSON diagnostics. */ }
const app = express();
app.use(express.json({ limit: "4mb" }));

type VerifiedUser = { uid: string; email?: string; name?: string };
type AuthedRequest = Request & {
  firebaseUser?: VerifiedUser;
  idToken?: string;
};
function bearer(req: Request) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: () => void,
) {
  const token = bearer(req);
  if (!token) return void res.status(401).json({ error: "unauthenticated" });
  try {
    ensureFirebaseAdmin();
    const decoded = await getAuth().verifyIdToken(token, true);
    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    };
  } catch {
    // Local Studio installations may not have Application Default Credentials.
    // Identity Toolkit validates the same Firebase ID token without trusting
    // client-provided identity fields.
    const apiKey = process.env.VITE_FIREBASE_API_KEY;
    if (!apiKey)
      return void res
        .status(503)
        .json({ error: "firebase_auth_not_configured" });
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: token }),
        },
      );
      const body: any = await response.json();
      const account = body.users?.[0];
      if (!response.ok || !account?.localId)
        return void res.status(401).json({ error: "invalid_auth" });
      req.firebaseUser = {
        uid: account.localId,
        email: account.email,
        name: account.displayName,
      };
    } catch {
      return void res.status(503).json({ error: "firebase_auth_unreachable" });
    }
  }
  req.idToken = token;
  next();
}
function decodeValue(v: any): any {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v)
    return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [
        k,
        decodeValue(x),
      ]),
    );
  return undefined;
}
async function readDocument(collection: string, id: string, idToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`firestore_${response.status}`);
  const json: any = await response.json();
  return Object.fromEntries(
    Object.entries(json.fields || {}).map(([k, v]) => [k, decodeValue(v)]),
  );
}
const staffRoles = new Set([
  "admin",
  "editor",
  "author",
  "moderator",
  "creator",
]);
async function requireStaff(
  req: AuthedRequest,
  res: Response,
  next: () => void,
) {
  try {
    const profile = await readDocument(
      "users",
      req.firebaseUser!.uid,
      req.idToken!,
    );
    const role = String(profile?.role || "").toLowerCase();
    if (
      !staffRoles.has(role) &&
      req.firebaseUser!.email !== "manasvig43@gmail.com"
    )
      return void res.status(403).json({ error: "staff_required" });
    next();
  } catch {
    return void res.status(503).json({ error: "identity_check_failed" });
  }
}

app.get("/api/health", async (_req, res) => {
  let firebaseReady = false;
  try {
    ensureFirebaseAdmin();
    await getFirestore().collection("editorial_queue").limit(1).get();
    firebaseReady = true;
  } catch (error) {
    console.error("[health] Firebase Admin check failed", error);
  }

  return res.status(firebaseReady ? 200 : 503).json({
    ok: firebaseReady,
    firebase: { projectId, adminReady: firebaseReady },
    ai: {
      configured: nvidiaApiKeys().length > 0 || geminiApiKeys().length > 0,
      editorialProvider: geminiApiKeys().length
        ? "gemini"
        : nvidiaApiKeys().length
          ? "nvidia"
          : "not_configured",
      fallbackConfigured: geminiApiKeys().length > 0 && nvidiaApiKeys().length > 0 ||
        geminiApiKeys().length > 1 || nvidiaApiKeys().length > 1,
    },
    livekit: {
      configured: !!(
        process.env.LIVEKIT_API_KEY &&
        process.env.LIVEKIT_API_SECRET &&
        (process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL)
      ),
    },
  });
});

const prompt = `You are the editorial engine for CIE Daily. Structure only the supplied reporting; do not add outside knowledge. Never invent or alter numbers, dates, names, locations, quotes, company names, capacities, targets, or statistics. If a detail is absent, omit it. Return strict JSON with exactly two independent representations: quick_brief and full_article. Every named field is required; use an empty array or null only where the schema explicitly permits it. quick_brief has category, headline, quick_summary (35-60 words), three_things_to_know (exactly 3 concise facts), key_number ({value,label} or null). full_article has headline, hook, in_20_seconds, what_happened (60+ words), why_this_matters (50+ words), bigger_picture, key_stats (array of {value,label}), explore_sections (3-6 story-specific sections, each with title, summary, content, items [{title,description}]), takeaways (3-5 substantive strings, never omit this field), quote ({text,speaker,role} or null). The combined full_article reading content must be at least 200 words. Do not copy the brief into the full article. Output JSON only.`;

function nvidiaApiKeys() {
  return [...new Set([
    process.env.NVIDIA_API_KEY,
    process.env.NVIDIA_API_KEY_2,
    process.env.NVIDIA_API_KEY_3,
    ...(process.env.NVIDIA_API_KEYS || "").split(/[\n,]/),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function geminiApiKeys() {
  return [...new Set([
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function canTryAnotherNvidiaKey(error: unknown) {
  const value = error as { status?: number; code?: string };
  const status = Number(value?.status || 0);
  const code = String(value?.code || "").toLowerCase();
  const message = error instanceof Error ? error.message : "";
  return status === 400 || status === 401 || status === 403 || status === 404 ||
    status === 408 || status === 429 || status >= 500 ||
    /timeout|connection|rate_limit/.test(code) ||
    /empty_ai_response|invalid_generated_json|generated_schema_missing|generated_schema_validation_failed/.test(message);
}

function parseGeneratedArticle(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("invalid_generated_json");
  let article: unknown;
  try {
    article = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("invalid_generated_json");
  }
  if (!article || typeof article !== "object" ||
    !("quick_brief" in article) || !("full_article" in article) ||
    !(article as { quick_brief?: unknown }).quick_brief ||
    !(article as { full_article?: unknown }).full_article) {
    throw new Error("generated_schema_missing");
  }
  return article as Pick<Article, "quick_brief" | "full_article">;
}

function normalizeGeneratedArticle(
  article: Pick<Article, "quick_brief" | "full_article">,
): Pick<Article, "quick_brief" | "full_article"> {
  const quickBrief = article.quick_brief;
  const fullArticle = article.full_article;
  const suppliedTakeaways = Array.isArray(fullArticle.takeaways)
    ? fullArticle.takeaways.filter((value) => String(value || "").trim())
    : [];
  const fallbackTakeaways = Array.isArray(quickBrief.three_things_to_know)
    ? quickBrief.three_things_to_know.filter((value) => String(value || "").trim()).slice(0, 3)
    : [];
  return {
    quick_brief: {
      ...quickBrief,
      three_things_to_know: Array.isArray(quickBrief.three_things_to_know)
        ? quickBrief.three_things_to_know
        : [],
      key_number: quickBrief.key_number ?? null,
    },
    full_article: {
      ...fullArticle,
      key_stats: Array.isArray(fullArticle.key_stats) ? fullArticle.key_stats : [],
      explore_sections: Array.isArray(fullArticle.explore_sections)
        ? fullArticle.explore_sections
        : [],
      takeaways: suppliedTakeaways.length >= 3 ? suppliedTakeaways : fallbackTakeaways,
      quote: fullArticle.quote ?? null,
    },
  };
}

async function generateArticle(
  source: string,
  category: string,
  validationFeedback: string[] = [],
) {
  const providers = [
    ...geminiApiKeys().map((apiKey) => ({
      name: "gemini",
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    })),
    ...nvidiaApiKeys().map((apiKey) => ({
      name: "nvidia",
      apiKey,
      baseURL: process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
      model: process.env.AI_MODEL || "meta/muse-glimmer-30b",
    })),
  ];
  if (!providers.length) throw new Error("ai_not_configured");
  const retryNote = validationFeedback.length
    ? `\nThe previous output failed these checks. Correct them without adding facts:\n- ${validationFeedback.join("\n- ")}`
    : "";
  // Bound the entire provider chain, not just one HTTP call. The worker keeps
  // one article per invocation, leaving a persistence reserve below Vercel's
  // hard function limit. A timeout is deliberately terminal for this attempt;
  // the next stale/retry run can try again without risking a 504.
  const generationStartedAt = Date.now();
  const generationDeadline = generationStartedAt + editorialGenerationBudgetMs;
  let lastError: unknown;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const elapsedMs = Date.now() - generationStartedAt;
    const timeout = providerTimeoutMs(provider.name as "gemini" | "nvidia", elapsedMs);
    if (!timeout) break;
    try {
      const ai = new OpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        timeout,
        maxRetries: 0,
      });
      const result = await ai.chat.completions.create({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: `Category: ${category}\nSource reporting:\n${source}${retryNote}`,
          },
        ],
      });
      const text = result.choices[0]?.message?.content;
      if (!text) throw new Error("empty_ai_response");
      const article = normalizeGeneratedArticle(parseGeneratedArticle(text));
      const schemaErrors = validateArticle(article).filter((issue) => issue.level === "error");
      if (schemaErrors.length) throw new Error("generated_schema_validation_failed");
      console.info("[article-generation] provider succeeded", {
        provider: provider.name,
        attempt: index + 1,
        elapsedMs: Date.now() - generationStartedAt,
        remainingBudgetMs: Math.max(0, generationDeadline - Date.now()),
      });
      return article;
    } catch (error) {
      lastError = error;
      const elapsedAfterErrorMs = Date.now() - generationStartedAt;
      const remainingAfterErrorMs = Math.max(0, generationDeadline - Date.now());
      const providerTimedOut = /timeout|timed.?out|abort|deadline/i.test(
        `${(error as { code?: unknown })?.code || ""} ${(error as { name?: unknown })?.name || ""} ${error instanceof Error ? error.message : ""}`,
      );
      console.warn("[article-generation] provider failed", {
        provider: provider.name,
        elapsedMs: elapsedAfterErrorMs,
        remainingBudgetMs: remainingAfterErrorMs,
        timeoutReason: providerTimedOut || remainingAfterErrorMs <= editorialPersistenceReserveMs
          ? "provider_timeout_or_budget_exhausted"
          : undefined,
      });
      if (providerTimedOut && remainingAfterErrorMs <= editorialPersistenceReserveMs) {
        const timeoutError = new Error("editorial_generation_timeout");
        (timeoutError as { code?: string }).code = "EDITORIAL_GENERATION_TIMEOUT";
        throw timeoutError;
      }
      if (index === providers.length - 1 || !canTryAnotherNvidiaKey(error)) throw error;
      if (provider.name === "gemini" && remainingAfterErrorMs <= editorialPersistenceReserveMs + 1_000) {
        const timeoutError = new Error("editorial_generation_timeout");
        (timeoutError as { code?: string }).code = "EDITORIAL_GENERATION_TIMEOUT";
        throw timeoutError;
      }
      const value = error as { status?: number; code?: string };
      console.warn("[article-generation] retrying with fallback provider", {
        provider: provider.name,
        attempt: index + 1,
        elapsedMs: elapsedAfterErrorMs,
        remainingBudgetMs: remainingAfterErrorMs,
        status: value?.status,
        code: value?.code,
      });
    }
  }
  throw lastError || new Error("generation_failed");
}

async function generatePublishableArticle(source: string, category: string) {
  const article = await generateArticle(source, category);
  const errors = validateArticle(article).filter((issue) => issue.level === "error");
  if (errors.length) {
    console.warn("[article-generation] output requires editor review", {
      paths: errors.map((issue) => issue.path),
    });
  }
  return article;
}
app.post(
  "/api/generate-article",
  requireAuth,
  requireStaff,
  async (req: AuthedRequest, res) => {
    const source = String(req.body?.sourceText || "").trim();
    if (source.length < 80)
      return res.status(400).json({ error: "source_too_short" });
    if (!nvidiaApiKeys().length && !geminiApiKeys().length)
      return res.status(503).json({ error: "ai_not_configured" });
    try {
      const article = await generatePublishableArticle(
        source,
        String(req.body?.category || "General"),
      );
      return res.json({ article });
    } catch (error) {
      console.error("[article-generation] request failed", error);
      return res.status(502).json({
        error: "generation_failed",
        message: "Article generation couldn't finish. Please try again.",
      });
    }
  },
);

function configuredDomains() {
  return (process.env.EDITORIAL_DOMAINS ||
    "Technology,Startups,AI & ML,Science,Engineering,India,Business")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
}

function queueItem(id: string, data: Record<string, any>): EditorialQueueItem {
  const timestamp = (value: any) => value?.toDate?.().toISOString?.() || value || null;
  return {
    id,
    ...data,
    duplicate: data.duplicate
      ? {
        ...data.duplicate,
        reason: data.duplicate.reason || (data.duplicate.kind === "exact"
          ? "The canonical source URL was already submitted."
          : "The story shares strong event/entity evidence with another queue item."),
      }
      : null,
    receivedAt: timestamp(data.receivedAt),
    updatedAt: timestamp(data.updatedAt),
    publishedAt: timestamp(data.publishedAt),
    processingStartedAt: timestamp(data.processingStartedAt),
  } as EditorialQueueItem;
}

function logFirestoreWriteFailure(operation: string, queueId: string | undefined, error: unknown) {
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  console.error("[editorial] Firestore write failed", {
    operation,
    queueId: queueId || null,
    code: String(value?.code || "unknown"),
    status: Number(value?.status || 0) || undefined,
    message: String(value?.message || "unknown Firestore error").slice(0, 240),
  });
}

const firestoreEditorialStore: EditorialStore = {
  async listRecent(max = 100) {
    const snapshot = await getFirestore()
      .collection("editorial_queue")
      .orderBy("receivedAt", "desc")
      .limit(max)
      .get();
    return snapshot.docs.map((document) => queueItem(document.id, document.data()));
  },
  async create(item) {
    const document = firestoreSafeValue({
      ...item,
      source: firestoreSafeIngestStory(item.source),
      receivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    let reference;
    try {
      reference = await getFirestore().collection("editorial_queue").add(document);
    } catch (error) {
      logFirestoreWriteFailure("create", undefined, error);
      throw error;
    }
    console.info("[editorial] story received", { queueId: reference.id });
    return { id: reference.id, ...item };
  },
  async get(id) {
    const document = await getFirestore().collection("editorial_queue").doc(id).get();
    return document.exists ? queueItem(document.id, document.data()!) : null;
  },
  async update(id, patch) {
    const document = firestoreSafeValue({
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    });
    try {
      await getFirestore().collection("editorial_queue").doc(id).update(document);
    } catch (error) {
      logFirestoreWriteFailure("update", id, error);
      throw error;
    }
    if (patch.duplicate) console.info("[editorial] duplicate detected", { queueId: id, kind: patch.duplicate.kind });
    if (patch.status === "processing") console.info("[editorial] generation started", { queueId: id });
    if (patch.status === "ready_for_review") console.info("[editorial] generation succeeded", { queueId: id });
    if (patch.status === "failed") console.warn("[editorial] validation or generation failed", { queueId: id });
  },
  async claim(id, staleAfterMs) {
    const db = getFirestore();
    const reference = db.collection("editorial_queue").doc(id);
    let claimed = false;
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) return;
        const data = snapshot.data() || {};
        const status = String(data.status || "");
        const startedAt = data.processingStartedAt?.toDate?.()?.getTime?.() ||
          data.updatedAt?.toDate?.()?.getTime?.() || 0;
        const stale = status === "processing" && (!startedAt || Date.now() - startedAt >= staleAfterMs);
        if (status === "processing" && !stale) return;
        if (!["discovered", "processing"].includes(status)) return;
        transaction.update(reference, firestoreSafeValue({
          status: "processing",
          processingStartedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
          failureReason: null,
          validationErrors: [],
        }));
        claimed = true;
      });
    } catch (error) {
      logFirestoreWriteFailure("claim", id, error);
      throw error;
    }
    const item = await firestoreEditorialStore.get(id);
    if (claimed) console.info("[editorial] generation claim acquired", { queueId: id });
    return { claimed, item };
  },
  async publish(queueId, post) {
    const db = getFirestore();
    const queueReference = db.collection("editorial_queue").doc(queueId);
    const postReference = db.collection("posts").doc();
    try {
      await db.runTransaction(async (transaction) => {
        const queue = await transaction.get(queueReference);
        if (!queue.exists) throw new EditorialError("not_found", "Editorial item not found.", 404);
        if (queue.data()?.status !== "approved") {
          throw new EditorialError("publish_conflict", "Editorial approval changed. Reload and try again.", 409);
        }
        transaction.set(postReference, firestoreSafeValue({
          ...post,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          publishedAt: FieldValue.serverTimestamp(),
        }));
        transaction.update(queueReference, firestoreSafeValue({
          status: "published",
          publishedArticleId: postReference.id,
          publishedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          failureReason: null,
        }));
      });
    } catch (error) {
      logFirestoreWriteFailure("publish", queueId, error);
      throw error;
    }
    console.info("[editorial] publish succeeded", { queueId, articleId: postReference.id });
    return postReference.id;
  },
};

const editorialService = new EditorialService(
  firestoreEditorialStore,
  (story: IngestStory, feedback?: string[]) =>
    generateArticle(sourceText(story), story.domain, feedback),
  configuredDomains(),
  2,
  false,
  (story) => resolveArticleImage(story),
);

function secureTokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const ingestBuckets = new Map<string, { count: number; resetAt: number }>();
function requireIngestionSecret(req: Request, res: Response, next: () => void) {
  const configured = process.env.EDITORIAL_INGEST_SECRET || "";
  if (!configured) return void res.status(503).json({ error: "ingestion_not_configured" });
  const token = bearer(req);
  if (!token || !secureTokenMatches(token, configured)) {
    return void res.status(401).json({ error: "invalid_ingestion_token" });
  }
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = ingestBuckets.get(key);
  if (current && current.resetAt > now && current.count >= 30) {
    return void res.status(429).json({ error: "rate_limited" });
  }
  ingestBuckets.set(key, current && current.resetAt > now
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: now + 60_000 });
  next();
}

function requireEditorialWorker(req: Request, res: Response, next: () => void) {
  const configured = process.env.CRON_SECRET || process.env.EDITORIAL_WORKER_SECRET || process.env.EDITORIAL_INGEST_SECRET || "";
  if (!configured) return void res.status(503).json({ error: "worker_not_configured" });
  const token = bearer(req);
  if (!token || !secureTokenMatches(token, configured)) {
    return void res.status(401).json({ error: "invalid_worker_token" });
  }
  next();
}

const editorialToolBuckets = new Map<string, { count: number; resetAt: number }>();
function requireEditorialToolKey(req: Request, res: Response, next: () => void) {
  const configured = process.env.CIE_DAILY_TOOL_API_KEY || "";
  if (!configured) {
    return void res.status(503).json({
      error: "editorial_tool_not_configured",
      message: "The editorial submission tool is not configured.",
    });
  }
  const token = bearer(req);
  if (!token || !secureTokenMatches(token, configured)) {
    return void res.status(401).json({
      error: "invalid_tool_token",
      message: "A valid tool credential is required.",
    });
  }
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = editorialToolBuckets.get(key);
  if (current && current.resetAt > now && current.count >= 10) {
    return void res.status(429).json({
      error: "rate_limited",
      message: "Too many editorial submissions. Try again shortly.",
    });
  }
  editorialToolBuckets.set(key, current && current.resetAt > now
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: now + 60_000 });
  next();
}

async function executeEditorialTool(input: unknown) {
  return submitEditorialStories(input, {
    ingestSecret: process.env.EDITORIAL_INGEST_SECRET || "",
  });
}

function editorialToolFailure(res: Response, error: unknown) {
  if (error instanceof EditorialToolError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  console.error("[editorial-tool] request failed", error);
  return res.status(500).json({
    error: "editorial_tool_failed",
    message: "The editorial submission could not be completed.",
  });
}

function editorialFailure(res: Response, error: unknown) {
  if (error instanceof EditorialError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  const technicalMessage = error instanceof Error ? error.message : String(error);
  const credentialsUnavailable = Boolean(firebaseAdminInitializationError) ||
    /default credentials|credential|app\/no-app|service account/i.test(technicalMessage);
  console.error("[editorial] request failed", error);
  if (credentialsUnavailable) {
    return res.status(503).json({
      error: "editorial_service_unavailable",
      message: "Editorial stories could not be loaded.",
    });
  }
  return res.status(500).json({
    error: "editorial_operation_failed",
    message: "Editorial stories could not be loaded.",
  });
}

app.post("/api/editorial-ingest", requireIngestionSecret, async (req, res) => {
  const stories = Array.isArray(req.body?.stories) ? req.body.stories.slice(0, 10) : [req.body];
  const results: Array<Record<string, unknown>> = [];
  for (const story of stories) {
    try {
      const item = await editorialService.ingest(story);
      if (item.duplicate) {
        console.info("[editorial] duplicate detected", {
          queueId: item.id,
          kind: item.duplicate.kind,
        });
      }
      if (item.status === "failed") {
        const category = classifyEditorialFailure(new Error(item.failureReason || "processing failed"));
        console.warn("[editorial] story processing failed", { queueId: item.id, category });
        results.push({
          ok: false,
          id: item.id,
          status: item.status,
          error: category,
          message: safeEditorialFailureMessage(category),
          duplicate: item.duplicate,
        });
      } else {
        results.push({ ok: true, id: item.id, status: item.status, duplicate: item.duplicate });
      }
    } catch (error) {
      const category = classifyEditorialFailure(error);
      console.error("[editorial] story processing exception", { category, error });
      results.push({
        ok: false,
        error: category,
        message: error instanceof EditorialError ? error.message : safeEditorialFailureMessage(category),
      });
    }
  }
  const single = !Array.isArray(req.body?.stories);
  const failed = results.every((result) => result.ok === false);
  return res.status(single && failed ? 400 : 201).json(single ? results[0] : { results });
});

app.get("/api/editorial-worker", requireEditorialWorker, async (_req, res) => {
  try {
    const candidates = (await firestoreEditorialStore.listRecent(100))
      .filter((item) => {
        if (item.duplicate) return false;
        if (item.status === "discovered") return true;
        if (item.status !== "processing") return false;
        const started = item.processingStartedAt || item.updatedAt;
        const timestamp = started ? Date.parse(String(started)) : 0;
        return !timestamp || Date.now() - timestamp >= editorialProcessingStaleAfterMs;
      })
      .slice(0, 1);
    if (!candidates.length) return res.json({ ok: true, processed: 0, message: "No pending editorial items." });
    const results = await editorialService.processBatch(candidates, 1);
    const remaining = (await firestoreEditorialStore.listRecent(100)).filter((item) =>
      !item.duplicate && (item.status === "discovered" || item.status === "processing"));
    return res.json({
      ok: true,
      processed: results.length,
      ready: results.filter((item) => item.status === "ready_for_review").length,
      failed: results.filter((item) => item.status === "failed").length,
      queueIds: results.map((item) => item.id),
      statuses: results.map((item) => ({ queueId: item.id, status: item.status })),
      remaining: remaining.length,
    });
  } catch (error) {
    const category = classifyEditorialFailure(error);
    console.error("[editorial-worker] failed", { category, error });
    return res.status(500).json({ ok: false, error: category, message: safeEditorialFailureMessage(category) });
  }
});

// REST/OpenAPI adapter for ChatGPT Actions and other server-to-server tools.
// It deliberately forwards only to ingestion; approval and publishing remain
// available exclusively inside the authenticated Studio Editorial Inbox.
app.post("/api/chatgpt/editorial-stories", requireEditorialToolKey, async (req, res) => {
  try {
    return res.status(201).json(await executeEditorialTool(req.body));
  } catch (error) {
    return editorialToolFailure(res, error);
  }
});

// Stateless Streamable HTTP MCP endpoint. Stateless handling is important on
// serverless hosts because subsequent JSON-RPC requests may reach another
// function instance.
app.post("/api/mcp", requireEditorialToolKey, async (req, res) => {
  const message = req.body as {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    });
  }
  if (message.method === "notifications/initialized") return res.status(202).end();
  if (message.method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cie-daily-editorial", version: "1.0.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: { tools: [submitEditorialStoryTool] },
    });
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== submitEditorialStoryTool.name) {
      return res.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32602, message: "Unknown tool" },
      });
    }
    try {
      const result = await executeEditorialTool(message.params?.arguments);
      return res.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: !result.ok,
        },
      });
    } catch (error) {
      const safe = error instanceof EditorialToolError
        ? { error: error.code, message: error.message }
        : { error: "editorial_tool_failed", message: "The editorial submission could not be completed." };
      if (!(error instanceof EditorialToolError)) console.error("[mcp] tool call failed", error);
      return res.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(safe) }],
          structuredContent: safe,
          isError: true,
        },
      });
    }
  }
  return res.json({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code: -32601, message: "Method not found" },
  });
});

app.get("/api/editorial", requireAuth, requireStaff, async (_req, res) => {
  try {
    return res.json({ items: await editorialService.list(), domains: editorialService.domains() });
  } catch (error) {
    return editorialFailure(res, error);
  }
});

app.patch("/api/editorial/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    return res.json({ item: await editorialService.edit(String(req.params.id), req.body?.generatedArticle) });
  } catch (error) {
    return editorialFailure(res, error);
  }
});

app.post("/api/editorial/:id/regenerate", requireAuth, requireStaff, async (req, res) => {
  try {
    return res.json({ item: await editorialService.regenerate(String(req.params.id)) });
  } catch (error) {
    return editorialFailure(res, error);
  }
});

app.post("/api/editorial/:id/clear-duplicate", requireAuth, requireStaff, async (req, res) => {
  try {
    return res.json({ item: await editorialService.clearDuplicate(String(req.params.id)) });
  } catch (error) {
    return editorialFailure(res, error);
  }
});

app.post("/api/editorial/:id/reject", requireAuth, requireStaff, async (req, res) => {
  try {
    return res.json({ item: await editorialService.reject(String(req.params.id)) });
  } catch (error) {
    return editorialFailure(res, error);
  }
});

app.post("/api/editorial/:id/publish", requireAuth, requireStaff, async (req: AuthedRequest, res) => {
  try {
    const user = req.firebaseUser!;
    const queueId = String(req.params.id);
    const item = await editorialService.publish(queueId, {
      uid: user.uid,
      name: user.name || user.email?.split("@")[0] || "Editor",
      email: user.email || "",
    });
    return res.json({ item });
  } catch (error) {
    console.warn("[editorial] publish failed", { queueId: String(req.params.id) });
    return editorialFailure(res, error);
  }
});

const tokenBuckets = new Map<string, { count: number; reset: number }>();
app.post("/api/livekit/token", requireAuth, async (req: AuthedRequest, res) => {
  const uid = req.firebaseUser!.uid,
    now = Date.now(),
    bucket = tokenBuckets.get(uid);
  if (bucket && bucket.reset > now && bucket.count >= 12)
    return res.status(429).json({ error: "rate_limited" });
  tokenBuckets.set(
    uid,
    bucket && bucket.reset > now
      ? { ...bucket, count: bucket.count + 1 }
      : { count: 1, reset: now + 60_000 },
  );
  const spaceId = String(req.body?.spaceId || ""),
    roomName = String(req.body?.roomName || "");
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(spaceId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(roomName)
  )
    return res.status(400).json({ error: "invalid_request" });
  try {
    let stream = await readDocument("liveStreams", spaceId, req.idToken!);
    if (!stream) {
      stream = await readDocument("live_spaces", spaceId, req.idToken!);
    }
    if (!stream) return res.status(404).json({ error: "stream_not_found" });
    const canonical = String(
      stream.roomName || stream.room_name || stream.channelId || stream.channel_name || "",
    ).trim();
    if (!canonical || canonical !== roomName)
      return res.status(403).json({ error: "room_mismatch" });
    
    const presenters = [
      stream.hostId,
      stream.host_id,
      stream.presenterId,
      stream.presenter_id,
      ...(stream.presenterIds || []),
      ...(stream.coHostIds || []),
      ...(stream.moderatorIds || []),
    ];
    const canPublish = presenters.includes(uid);
    const status = String(stream.status || "").toLowerCase();
    // Presenters must connect and publish before advertising a live stream.
    if (stream.endedAt || stream.ended_at ||
        (status !== "live" && !(canPublish && status === "scheduled")))
      return res.status(409).json({ error: "stream_ended" });
    if (
      stream.isPublic === false &&
      !canPublish &&
      !(stream.allowedUserIds || []).includes(uid)
    )
      return res.status(403).json({ error: "not_authorized" });
    if (
      [
        ...(stream.bannedUserIds || []),
        ...(stream.removedUserIds || []),
      ].includes(uid)
    )
      return res.status(403).json({ error: "not_authorized" });
    const key = process.env.LIVEKIT_API_KEY,
      secret = process.env.LIVEKIT_API_SECRET,
      url = process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL;
    if (!key || !secret || !url)
      return res.status(503).json({ error: "livekit_not_configured" });
    const token = new AccessToken(key, secret, {
      identity: uid,
      name:
        req.firebaseUser!.name || req.firebaseUser!.email || "CIE Daily user",
      ttl: 300,
    });
    token.addGrant({
      roomJoin: true,
      room: canonical,
      canSubscribe: true,
      canPublish,
      canPublishData: canPublish,
    });
    return res.json({
      token: await token.toJwt(),
      serverUrl: url,
      roomName: canonical,
      role: canPublish ? "presenter" : "listener",
      expiresInSeconds: 300,
    });
  } catch (error: any) {
    return res
      .status(503)
      .json({
        error: "token_service_failed",
        detail: error?.message?.slice(0, 120) || "unknown",
      });
  }
});

app.post("/api/streams", requireAuth, requireStaff, async (req: AuthedRequest, res) => {
  const uid = req.firebaseUser!.uid;
  const { id: reqId, title, description, roomName: reqRoom, status, isPublic } = req.body || {};
  if (!title) return res.status(400).json({ error: "title_required" });

  const streamId = String(reqId || "").trim() || `stream_${Date.now()}`;
  const roomName = String(reqRoom || "").trim() || `cie_${streamId.replace(/[^A-Za-z0-9]/g, "")}`;
  const hostName = req.firebaseUser?.name || req.firebaseUser?.email || "Host";

  const livekitUrl = "wss://cie-daily-79ts1icb.livekit.cloud";
  const isLive = false; // Never advertise an unconnected presenter as live.
  const streamData = {
    id: streamId,
    title: String(title).trim(),
    description: String(description || "").trim(),
    roomName,
    room_name: roomName,
    channelId: roomName,
    channel_name: roomName,
    spaceId: streamId,
    space_id: streamId,
    hostId: uid,
    host_id: uid,
    hostName,
    host_name: hostName,
    presenterId: uid,
    presenter_id: uid,
    presenterIds: [uid],
    status: isLive ? "live" : "scheduled",
    isLive,
    is_live: isLive,
    isPublic: isPublic !== false,
    is_public: isPublic !== false,
    participantCount: 0,
    participant_count: 0,
    viewersCount: 0,
    viewers_count: 0,
    peakViewerCount: 0,
    peak_viewer_count: 0,
    livekitUrl,
    livekit_url: livekitUrl,
    serverUrl: livekitUrl,
    server_url: livekitUrl,
  };

  try {
    try {
      const db = getFirestore();
      const existing = await db.collection("liveStreams").doc(streamId).get();
      if (existing.exists && existing.data()?.hostId !== uid)
        return res.status(403).json({ error: "not_authorized" });
      await db.collection("liveStreams").doc(streamId).set({
        ...streamData,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await db.collection("live_spaces").doc(streamId).set({
        ...streamData,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ ok: true, id: streamId, roomName });
    } catch (adminErr: any) {
      console.warn("Admin SDK write notice, attempting REST API fallback:", adminErr?.message);
    }

    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/liveStreams?documentId=${encodeURIComponent(streamId)}`;
    const firestoreBody = {
      fields: {
        id: { stringValue: streamId },
        title: { stringValue: streamData.title },
        description: { stringValue: streamData.description },
        roomName: { stringValue: streamData.roomName },
        room_name: { stringValue: streamData.roomName },
        channelId: { stringValue: streamData.roomName },
        spaceId: { stringValue: streamId },
        hostId: { stringValue: uid },
        host_id: { stringValue: uid },
        hostName: { stringValue: hostName },
        host_name: { stringValue: hostName },
        presenterId: { stringValue: uid },
        presenter_id: { stringValue: uid },
        presenterIds: { arrayValue: { values: [{ stringValue: uid }] } },
        status: { stringValue: streamData.status },
        isLive: { booleanValue: isLive },
        is_live: { booleanValue: isLive },
        isPublic: { booleanValue: streamData.isPublic },
        is_public: { booleanValue: streamData.isPublic },
        participantCount: { integerValue: "0" },
        peakViewerCount: { integerValue: "0" },
        livekitUrl: { stringValue: livekitUrl },
        livekit_url: { stringValue: livekitUrl },
        serverUrl: { stringValue: livekitUrl },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.idToken}`,
      },
      body: JSON.stringify(firestoreBody),
    });

    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Firestore REST status: ${response.status}`);
    }

    return res.json({ ok: true, id: streamId, roomName });
  } catch (error: any) {
    console.error("Stream creation server error:", error);
    return res.status(500).json({ error: "stream_creation_failed", detail: error?.message || "Unknown error" });
  }
});

app.delete("/api/streams/:id", requireAuth, requireStaff, async (req: AuthedRequest, res) => {
  const streamId = String(req.params.id || "").trim();
  if (!streamId) return res.status(400).json({ error: "invalid_id" });

  try {
    try {
      const db = getFirestore();
      const existing = await db.collection("liveStreams").doc(streamId).get();
      if (existing.exists && existing.data()?.hostId !== req.firebaseUser!.uid)
        return res.status(403).json({ error: "not_authorized" });
      await db.collection("liveStreams").doc(streamId).delete();
      return res.json({ ok: true });
    } catch (adminErr: any) {
      console.warn("Admin SDK delete notice:", adminErr?.message);
    }

    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/liveStreams/${encodeURIComponent(streamId)}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${req.idToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Firestore REST status: ${response.status}`);
    }

    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: "stream_deletion_failed", detail: error?.message });
  }
});

// Keep API failures machine-readable. Without this guard, the SPA fallback can
// return HTML for a mistyped or unavailable API route and obscure the real error.
app.use("/api", (error: unknown, req: Request, res: Response, next: (error?: unknown) => void) => {
  if (res.headersSent) return next(error);
  console.error("[api] unhandled request failure", { method: req.method, path: req.originalUrl, error });
  if (error instanceof SyntaxError && (error as SyntaxError & { status?: number }).status === 400) {
    return res.status(400).json({
      error: "invalid_json",
      message: "The request body must contain valid JSON.",
    });
  }
  return res.status(500).json({
    error: "service_unavailable",
    message: "The requested service is temporarily unavailable.",
  });
});

app.use("/api", (req, res) =>
  res.status(404).json({
    error: "api_route_not_found",
    detail: `${req.method} ${req.originalUrl}`,
  }),
);

const port = Number(process.env.STUDIO_PORT || 3100);
export default app;

async function startServer() {
if (process.env.NODE_ENV === "production") {
  const root = path.dirname(fileURLToPath(import.meta.url));
  app.use(
    express.static(path.join(root, "dist"), {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  app.get("/{*splat}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.sendFile(path.join(root, "dist", "index.html"));
  });
  const productionServer = app.listen(port, "127.0.0.1", () =>
    console.log(`CIE Daily Studio listening on http://127.0.0.1:${port}`),
  );
  productionServer.on("error", (error) => console.error("Studio server error", error));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  const developmentServer = app.listen(port, "127.0.0.1", () =>
    console.log(`CIE Daily Studio listening on http://127.0.0.1:${port}`),
  );
  developmentServer.on("error", (error) => console.error("Studio server error", error));
}
}

// Vercel invokes the exported Express handler; it must not start Vite or listen.
if (!process.env.VERCEL) void startServer();
