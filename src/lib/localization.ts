import { getFirestore } from "firebase-admin/firestore";
import crypto from "node:crypto";
import type { Article, LocalizedArticle } from "./types.ts";
import {
  type LanguageConfig,
  SUPPORTED_LANGUAGES,
  getLanguageConfig,
} from "./languages.ts";

const sarvamTtsModel = "bulbul:v3";
const sarvamTtsLimit = 2500;
const sarvamTtsChunkTarget = 2300;
const CONCURRENCY_LIMIT = 2;
const STALE_PROCESSING_MS = 30 * 60 * 1000;

export type LocalizationAudit = {
  total: number;
  complete: number;
  pending: number;
  failed: number;
  missingLanguages: number;
  enOnly: number;
  enTe: number;
  translationReadyAudioMissing: number;
  audioFailed: number;
  legacy: number;
  schemaV2: number;
  malformed: number;
  languages: Record<string, { translationReady: number; audioReady: number }>;
};

export type BackfillResult = {
  examined: number;
  processed: number;
  skipped: number;
  malformed: number;
  translationsStarted: number;
  audioStarted: number;
  articleIds: string[];
};

function hashArticle(article: Article) {
  const content = JSON.stringify(article.quick_brief) + JSON.stringify(article.full_article);
  return crypto.createHash("md5").update(content).digest("hex");
}

function isStaleProcessing(loc: LocalizedArticle) {
  return loc.processingStartedAt != null && Date.now() - loc.processingStartedAt > STALE_PROCESSING_MS;
}

function hasUsableEnglish(article: Article) {
  return Boolean(
    article.quick_brief &&
    article.full_article &&
    typeof article.quick_brief.headline === "string" &&
    typeof article.full_article.what_happened === "string",
  );
}

function firstSentence(text: string) {
  return text.split(/(?<=[.!?।॥])\s+/u).find(Boolean)?.trim() || text.trim();
}

function limitWords(text: string, maxWords: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}...` : words.join(" ");
}

function legacyBodyText(article: Article) {
  const blockText = Array.isArray(article.blocks)
    ? article.blocks
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const value = block as Record<string, unknown>;
          if (value.type && value.type !== "text") return "";
          return String(value.content || value.text || "").trim();
        })
        .filter(Boolean)
    : [];
  return blockText.length ? blockText.join("\n\n") : String(article.raw_input || "").trim();
}

function canonicalEnglishArticle(article: Article): Article | null {
  if (hasUsableEnglish(article)) return article;

  const body = legacyBodyText(article);
  const headline = String(article.title || article.quick_brief?.headline || "").trim();
  if (!headline || !body) return null;

  const summary = limitWords(firstSentence(body), 60);
  const bodyParagraphs = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const takeaways = bodyParagraphs.length
    ? bodyParagraphs.slice(0, 3).map((part) => limitWords(part, 18))
    : [summary];

  return {
    ...article,
    schema_version: Math.max(Number(article.schema_version || 1), 2),
    category: article.category || article.articleCategory || "Article",
    quick_brief: {
      category: article.category || article.articleCategory || "Article",
      headline,
      quick_summary: summary,
      three_things_to_know: takeaways.slice(0, 3),
      key_number: null,
    },
    full_article: {
      headline,
      hook: summary,
      in_20_seconds: summary,
      what_happened: body,
      why_this_matters: summary,
      bigger_picture: "",
      key_stats: [],
      explore_sections: [
        {
          title: "Story",
          summary,
          content: body,
          items: [],
        },
      ],
      takeaways: takeaways.slice(0, 5),
      quote: null,
    },
  };
}

function isLanguageReady(loc: LocalizedArticle | undefined) {
  return loc?.translationStatus === "ready" && loc.audioStatus === "ready" && Boolean(loc.audioUrl);
}

function hasLocalizationFailure(article: Article) {
  return SUPPORTED_LANGUAGES.some((language) => {
    const loc = article.languages?.[language.id];
    return loc?.translationStatus === "failed" || loc?.audioStatus === "failed";
  });
}

function safeResponseError(value: string) {
  return value
    .replace(/api[-_ ]?(subscription[-_ ]?)?key["':=\s]+[A-Za-z0-9._-]+/gi, "api key [redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [redacted]")
    .slice(0, 300);
}

function narrationText(parts: Array<string | undefined | null>) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildNarrationScript(loc: LocalizedArticle) {
  return narrationText([
    loc.quick_brief?.headline,
    loc.quick_brief?.quick_summary,
    "What happened.",
    loc.full_article?.what_happened,
    "Why this matters.",
    loc.full_article?.why_this_matters,
    ...(loc.full_article?.explore_sections || []).map((s) => `${s.title}. ${s.content}`),
  ]);
}

function splitLongText(text: string, maxChars: number) {
  const chunks: string[] = [];
  const sentences = text
    .split(/(?<=[.!?।॥])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of sentences.length ? sentences : [text]) {
    if (sentence.length > maxChars) {
      pushCurrent();
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars).trim());
      }
      continue;
    }
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChars) {
      pushCurrent();
      current = sentence;
    } else {
      current = next;
    }
  }
  pushCurrent();
  return chunks;
}

function chunkNarration(text: string, maxChars = sarvamTtsChunkTarget) {
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongText(paragraph, maxChars));
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function wavData(buffer: Buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Sarvam TTS returned non-WAV audio");
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  throw new Error("Sarvam TTS WAV missing data chunk");
}

function combineWavChunks(buffers: Buffer[]) {
  if (buffers.length === 0) throw new Error("No TTS audio chunks generated");
  if (buffers.length === 1) return buffers[0];

  const first = Buffer.from(buffers[0]);
  const dataParts = buffers.map((buffer) => {
    const data = wavData(buffer);
    return buffer.subarray(data.offset, data.offset + data.size);
  });
  const combinedDataSize = dataParts.reduce((total, part) => total + part.length, 0);
  const firstData = wavData(first);
  const header = Buffer.from(first.subarray(0, firstData.offset));
  header.writeUInt32LE(header.length + combinedDataSize - 8, 4);
  header.writeUInt32LE(combinedDataSize, firstData.offset - 4);
  return Buffer.concat([header, ...dataParts]);
}

async function uploadNarration(
  articleId: string,
  languageId: string,
  audioBuffer: Buffer,
) {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl.startsWith("https://") || !serviceRoleKey) {
    throw new Error("Supabase narration storage is not configured");
  }

  const objectPath = `articles/${encodeURIComponent(articleId)}/${languageId}.wav`;
  const uploadResponse = await fetch(
    `${supabaseUrl}/storage/v1/object/article-audio/${objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "audio/wav",
        "x-upsert": "true",
      },
      body: audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength,
      ) as ArrayBuffer,
    },
  );
  if (!uploadResponse.ok) {
    console.log(
      "[STORAGE] safe response error:",
      safeResponseError(await uploadResponse.text()),
    );
    throw new Error(`Supabase Storage upload failed: HTTP ${uploadResponse.status}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/article-audio/${objectPath}`;
  const publicResponse = await fetch(publicUrl);
  console.log(`[STORAGE] public URL status: ${publicResponse.status}`);
  if (!publicResponse.ok) {
    throw new Error(`Supabase Storage public URL failed: HTTP ${publicResponse.status}`);
  }
  if (!publicResponse.headers.get("content-type")?.startsWith("audio/wav")) {
    throw new Error("Supabase Storage public URL did not return WAV audio");
  }
  await publicResponse.body?.cancel();
  return { objectPath, publicUrl };
}

export async function translateText(text: string, targetLang: string): Promise<string> {
  if (!text) return "";
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not configured");

  console.log("[SARVAM] translation request starting");
  console.log("[SARVAM] endpoint: https://api.sarvam.ai/translate");
  console.log("[SARVAM] source language: en-IN");
  console.log("[SARVAM] target language:", targetLang);
  console.log("[SARVAM] model: sarvam-translate:v1");
  console.log("[SARVAM] input character count:", text.length);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch("https://api.sarvam.ai/translate", {
      method: "POST",
      headers: {
        "api-subscription-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: text,
        source_language_code: "en-IN",
        target_language_code: targetLang,
        speaker_gender: "Male",
        mode: "formal",
        model: "sarvam-translate:v1"
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log(`[SARVAM] translation HTTP status: ${response.status}`);

    if (!response.ok) {
      const err = await response.text();
      console.log(`[SARVAM] translation failed\nstatus: ${response.status}\nresponse: ${safeResponseError(err)}`);
      throw new Error(`Sarvam translate failed: HTTP ${response.status}`);
    }

    console.log("[SARVAM] translation response received");
    const result = await response.json();
    return result.translated_text;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log("[SARVAM] translation timed out after 30000ms");
    }
    throw error;
  }
}

export async function synthesizeSpeech(text: string, targetLang: string, speaker: string): Promise<Buffer> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not configured");

  console.log("[TTS] language:", targetLang);
  console.log("[TTS] model:", sarvamTtsModel);
  console.log("[TTS] speaker:", speaker);
  console.log("[TTS] input character count:", text.length);

  if (text.length > sarvamTtsLimit) {
    throw new Error(`TTS input exceeds Sarvam REST limit: ${text.length}/${sarvamTtsLimit}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "api-subscription-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        language_code: targetLang,
        speaker: speaker,
        pace: 1.0,
        speech_sample_rate: 24000,
        output_audio_codec: "wav",
        model: sarvamTtsModel
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log(`[TTS] HTTP status: ${response.status}`);

    if (!response.ok) {
      const err = await response.text();
      console.log("[TTS] safe response error:", safeResponseError(err));
      throw new Error(`Sarvam TTS failed: HTTP ${response.status}`);
    }

    const result = await response.json();
    const audio = result.audios?.[0];
    if (typeof audio !== "string" || !audio) throw new Error("Sarvam TTS returned no audio");
    return Buffer.from(audio, "base64");
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log("[TTS] safe response error:", "request timed out after 30000ms");
    }
    throw error;
  }
}

export async function synthesizeNarration(text: string, targetLang: string, speaker: string): Promise<Buffer> {
  const chunks = chunkNarration(text);
  console.log(`[TTS] chunk count: ${chunks.length}`);
  const buffers: Buffer[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    console.log(`[TTS] chunk ${index + 1}/${chunks.length}`);
    buffers.push(await synthesizeSpeech(chunks[index], targetLang, speaker));
  }
  return combineWavChunks(buffers);
}

async function pLimitMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const i = currentIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function localizeLanguage(
  docRef: FirebaseFirestore.DocumentReference,
  articleId: string,
  article: Article,
  currentHash: string,
  lang: LanguageConfig,
  existingLoc?: LocalizedArticle,
  stats?: BackfillResult,
): Promise<LocalizedArticle> {
  const loc: LocalizedArticle = existingLoc
    ? { ...existingLoc }
    : {
        title: "",
        quick_brief: JSON.parse(JSON.stringify(article.quick_brief)),
        full_article: JSON.parse(JSON.stringify(article.full_article)),
        translationStatus: "pending",
        audioStatus: "pending",
      };

  // 1. Translation Step (Skip for source language English)
  if (lang.isSource) {
    loc.title = article.quick_brief?.headline || article.title || "";
    loc.quick_brief = JSON.parse(JSON.stringify(article.quick_brief));
    loc.full_article = JSON.parse(JSON.stringify(article.full_article));
    loc.translationStatus = "ready";
  } else {
    const needsTranslation =
      loc.translationStatus === "failed" ||
      loc.translationStatus === "pending" ||
      (loc.translationStatus === "processing" && isStaleProcessing(loc)) ||
      !loc.title;

    if (needsTranslation) {
      console.log(`[LOCALIZATION] ${lang.name} (${lang.id}) translation started`);
      loc.translationStatus = "processing";
      loc.processingStartedAt = Date.now();
      if (stats) stats.translationsStarted += 1;
      await docRef.update({ [`languages.${lang.id}`]: loc });

      try {
        const translate = (t: string) => translateText(t, lang.sarvamCode);

        loc.title = await translate(article.quick_brief.headline);
        loc.quick_brief = JSON.parse(JSON.stringify(article.quick_brief));
        loc.full_article = JSON.parse(JSON.stringify(article.full_article));

        loc.quick_brief.headline = loc.title;
        loc.quick_brief.category = await translate(article.quick_brief.category);
        loc.quick_brief.quick_summary = await translate(article.quick_brief.quick_summary);

        loc.quick_brief.three_things_to_know = await Promise.all(
          (article.quick_brief.three_things_to_know || []).map(translate)
        );

        if (article.quick_brief.key_number) {
          loc.quick_brief.key_number = {
            value: article.quick_brief.key_number.value,
            label: await translate(article.quick_brief.key_number.label)
          };
        }

        loc.full_article.headline = await translate(article.full_article.headline);
        loc.full_article.hook = await translate(article.full_article.hook);
        loc.full_article.in_20_seconds = await translate(article.full_article.in_20_seconds);
        loc.full_article.what_happened = await translate(article.full_article.what_happened);
        loc.full_article.why_this_matters = await translate(article.full_article.why_this_matters);
        loc.full_article.bigger_picture = await translate(article.full_article.bigger_picture);

        loc.full_article.key_stats = await Promise.all(
          (article.full_article.key_stats || []).map(async st => ({
            value: st.value,
            label: await translate(st.label)
          }))
        );

        loc.full_article.explore_sections = await Promise.all(
          (article.full_article.explore_sections || []).map(async sec => ({
            title: await translate(sec.title),
            summary: await translate(sec.summary),
            content: await translate(sec.content),
            items: await Promise.all(
              (sec.items || []).map(async item => ({
                title: await translate(item.title),
                description: await translate(item.description)
              }))
            )
          }))
        );

        loc.full_article.takeaways = await Promise.all(
          (article.full_article.takeaways || []).map(translate)
        );

        if (article.full_article.quote) {
          loc.full_article.quote = {
            text: await translate(article.full_article.quote.text),
            speaker: await translate(article.full_article.quote.speaker),
            role: await translate(article.full_article.quote.role)
          };
        }

        loc.translationStatus = "ready";
        loc.originalHash = currentHash;
        loc.audioStatus = "pending";
        loc.processingStartedAt = null;
        await docRef.update({ [`languages.${lang.id}`]: loc });
        console.log(`[LOCALIZATION] ${lang.name} (${lang.id}) translation complete`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LOCALIZATION] ${lang.name} (${lang.id}) translation FAILED for ${articleId}:`, msg);
        loc.translationStatus = "failed";
        loc.audioStatus = "failed";
        loc.processingStartedAt = null;
        await docRef.update({ [`languages.${lang.id}`]: loc });
        return loc;
      }
    }
  }

  // 2. TTS Generation & Upload Step
  if (lang.ttsEnabled && loc.translationStatus === "ready") {
    const needsAudio =
      loc.audioStatus === "pending" ||
      loc.audioStatus === "failed" ||
      (loc.audioStatus === "processing" && isStaleProcessing(loc)) ||
      !loc.audioUrl;

    if (needsAudio) {
      console.log(`[TTS] ${lang.name} (${lang.id}) started`);
      loc.audioStatus = "processing";
      loc.processingStartedAt = Date.now();
      if (stats) stats.audioStarted += 1;
      await docRef.update({ [`languages.${lang.id}`]: loc });

      try {
        const script = buildNarrationScript(loc);
        const audioBuffer = await synthesizeNarration(script, lang.sarvamCode, lang.speaker);
        console.log(`[TTS] ${lang.name} (${lang.id}) complete — ${audioBuffer.length} bytes`);

        const upload = await uploadNarration(articleId, lang.id, audioBuffer);
        loc.audioUrl = upload.publicUrl;
        loc.audioStatus = "ready";
        loc.originalHash = currentHash;
        loc.processingStartedAt = null;
        await docRef.update({ [`languages.${lang.id}`]: loc });
        console.log(`[STORAGE] ${lang.name} (${lang.id}) audio uploaded — ${upload.objectPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[TTS] ${lang.name} (${lang.id}) FAILED for ${articleId}:`, msg);
        loc.audioStatus = "failed";
        loc.processingStartedAt = null;
        await docRef.update({ [`languages.${lang.id}`]: loc });
      }
    }
  }

  return loc;
}

export async function processLocalization(
  articleId: string,
  targetLanguageIds?: string[],
  stats?: BackfillResult,
) {
  console.log(`[LOCALIZATION] started for article ${articleId}`);
  console.log(`[LOCALIZATION] SARVAM_API_KEY configured: ${!!process.env.SARVAM_API_KEY}`);

  const db = getFirestore();
  const docRef = db.collection("posts").doc(articleId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    console.warn(`[LOCALIZATION] post ${articleId} not found in Firestore — aborting`);
    return;
  }

  let article = snapshot.data() as Article;
  if (article.status !== "approved" && article.status !== "published") {
    console.warn(`[LOCALIZATION] post ${articleId} status is "${article.status}" — skipping (need approved/published)`);
    return;
  }
  const canonicalArticle = canonicalEnglishArticle(article);
  if (!canonicalArticle) {
    console.warn(`[LOCALIZATION] post ${articleId} is missing the canonical English article structure — skipping`);
    if (stats) stats.malformed += 1;
    return;
  }
  if (!hasUsableEnglish(article)) {
    article = canonicalArticle;
    await docRef.set({
      schema_version: article.schema_version,
      quick_brief: article.quick_brief,
      full_article: article.full_article,
    }, { merge: true });
    console.log(`[LOCALIZATION] post ${articleId} English article structure backfilled from existing content`);
  }

  const currentHash = hashArticle(article);
  const languages: Record<string, LocalizedArticle> = article.languages || {};

  // Determine which languages to process
  let targetConfigs: LanguageConfig[];
  if (targetLanguageIds && targetLanguageIds.length > 0) {
    targetConfigs = targetLanguageIds
      .map((id) => getLanguageConfig(id))
      .filter((cfg): cfg is LanguageConfig => !!cfg);
  } else {
    // Process all supported languages (en + regional)
    targetConfigs = [...SUPPORTED_LANGUAGES];
  }

  console.log(`[LOCALIZATION] processing ${targetConfigs.length} languages with concurrency ${CONCURRENCY_LIMIT}:`, targetConfigs.map(c => c.id).join(", "));

  // Process with bounded concurrency (2 concurrent languages)
  await pLimitMap(targetConfigs, CONCURRENCY_LIMIT, async (lang) => {
    try {
      await localizeLanguage(
        docRef,
        articleId,
        article,
        currentHash,
        lang,
        languages[lang.id],
        stats,
      );
    } catch (err: any) {
      console.error(`[LOCALIZATION] unhandled error for ${lang.id}:`, err?.message || err);
    }
  });

  console.log(`[LOCALIZATION] completed for article ${articleId}`);
}

export async function auditHistoricalLocalization(): Promise<LocalizationAudit> {
  const docs = (await getFirestore().collection("posts").get()).docs
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() } as Article));
  const published = docs.filter((article) => article.status === "approved" || article.status === "published");
  const audit: LocalizationAudit = {
    total: published.length,
    complete: 0,
    pending: 0,
    failed: 0,
    missingLanguages: 0,
    enOnly: 0,
    enTe: 0,
    translationReadyAudioMissing: 0,
    audioFailed: 0,
    legacy: 0,
    schemaV2: 0,
    malformed: 0,
    languages: Object.fromEntries(SUPPORTED_LANGUAGES.map((language) => [
      language.id,
      { translationReady: 0, audioReady: 0 },
    ])),
  };

  for (const article of published) {
    const languages = article.languages || {};
    const keys = Object.keys(languages);
    const fullyReady = SUPPORTED_LANGUAGES.every((language) => isLanguageReady(languages[language.id]));
    if (fullyReady) audit.complete += 1;
    else if (Object.values(languages).some((loc) => loc.translationStatus === "failed" || loc.audioStatus === "failed")) audit.failed += 1;
    else audit.pending += 1;
    if (!keys.length) audit.missingLanguages += 1;
    if (keys.length === 1 && keys[0] === "en") audit.enOnly += 1;
    if (keys.includes("en") && keys.includes("te") && !keys.includes("hi")) audit.enTe += 1;
    if ((article.schema_version || 1) < 2) audit.legacy += 1;
    else audit.schemaV2 += 1;
    if (!canonicalEnglishArticle(article)) audit.malformed += 1;
    for (const language of SUPPORTED_LANGUAGES) {
      const loc = languages[language.id];
      if (loc?.translationStatus === "ready") audit.languages[language.id].translationReady += 1;
      if (isLanguageReady(loc)) audit.languages[language.id].audioReady += 1;
      if (loc?.translationStatus === "ready" && !isLanguageReady(loc)) audit.translationReadyAudioMissing += 1;
      if (loc?.audioStatus === "failed") audit.audioFailed += 1;
    }
  }
  return audit;
}

export async function runHistoricalLocalizationBatch(maxArticles = 1, retryFailedOnly = false): Promise<BackfillResult> {
  const db = getFirestore();
  const docs = (await db.collection("posts").get()).docs;
  const result: BackfillResult = {
    examined: 0,
    processed: 0,
    skipped: 0,
    malformed: 0,
    translationsStarted: 0,
    audioStarted: 0,
    articleIds: [],
  };

  for (const snapshot of docs) {
    if (result.processed >= Math.max(1, Math.min(maxArticles, 2))) break;
    const article = snapshot.data() as Article;
    if (article.status !== "approved" && article.status !== "published") continue;
    result.examined += 1;
    if (!canonicalEnglishArticle(article)) {
      result.malformed += 1;
      continue;
    }
    if (retryFailedOnly && !hasLocalizationFailure(article)) {
      result.skipped += 1;
      continue;
    }
    if (SUPPORTED_LANGUAGES.every((language) => isLanguageReady(article.languages?.[language.id]))) {
      result.skipped += 1;
      continue;
    }
    result.processed += 1;
    result.articleIds.push(snapshot.id);
    try {
      await processLocalization(snapshot.id, undefined, result);
    } catch (error) {
      console.error(`[BACKFILL] article ${snapshot.id} failed without stopping the batch`, error);
    }
  }
  return result;
}
