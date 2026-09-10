import { getFirestore } from "firebase-admin/firestore";
import crypto from "node:crypto";
import type { Article, LocalizedArticle } from "./types.ts";

const sarvamTtsModel = "bulbul:v3";
const sarvamTtsLimit = 2500;
const sarvamTtsChunkTarget = 2300;

function hashArticle(article: Article) {
  const content = JSON.stringify(article.quick_brief) + JSON.stringify(article.full_article);
  return crypto.createHash("md5").update(content).digest("hex");
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

async function translateText(text: string, targetLang: string): Promise<string> {
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
      console.log(`[SARVAM] translation failed\nstatus: ${response.status}\nresponse: ${err.slice(0, 300)}`);
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

async function synthesizeSpeech(text: string, targetLang: string, speaker: string): Promise<Buffer> {
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

async function synthesizeNarration(text: string, targetLang: string, speaker: string): Promise<Buffer> {
  const chunks = chunkNarration(text);
  console.log(`[TTS] chunk count: ${chunks.length}`);
  const buffers: Buffer[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    console.log(`[TTS] chunk ${index + 1}/${chunks.length}`);
    buffers.push(await synthesizeSpeech(chunks[index], targetLang, speaker));
  }
  return combineWavChunks(buffers);
}

export async function processLocalization(articleId: string) {
  console.log(`[LOCALIZATION] started for article ${articleId}`);
  console.log(`[LOCALIZATION] SARVAM_API_KEY configured: ${!!process.env.SARVAM_API_KEY}`);

  const db = getFirestore();
  const docRef = db.collection("posts").doc(articleId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    console.warn(`[LOCALIZATION] post ${articleId} not found in Firestore — aborting`);
    return;
  }

  const article = snapshot.data() as Article;
  if (article.status !== "approved" && article.status !== "published") {
    console.warn(`[LOCALIZATION] post ${articleId} status is "${article.status}" — skipping (need approved/published)`);
    return;
  }

  const currentHash = hashArticle(article);
  const languages: Record<string, LocalizedArticle> = article.languages || {};

  // For now, process only Telugu as requested to verify it works
  const targetLangs = [
    { id: "te", label: "Telugu", code: "te-IN" }
  ];

  for (const lang of targetLangs) {
    let loc = languages[lang.id] || {
      title: "",
      quick_brief: JSON.parse(JSON.stringify(article.quick_brief)),
      full_article: JSON.parse(JSON.stringify(article.full_article)),
      translationStatus: "pending",
      audioStatus: "pending",
    };

    if (loc.originalHash !== currentHash || loc.translationStatus === "failed") {
      console.log(`[LOCALIZATION] ${lang.label} translation started`);
      loc.translationStatus = "processing";
      languages[lang.id] = loc;
      await docRef.update({ languages });

      try {
        const translate = (t: string) => translateText(t, lang.code);
        
        loc.title = await translate(article.quick_brief.headline);
        loc.quick_brief.headline = loc.title;
        loc.quick_brief.category = await translate(article.quick_brief.category);
        loc.quick_brief.quick_summary = await translate(article.quick_brief.quick_summary);
        
        loc.quick_brief.three_things_to_know = await Promise.all(
          article.quick_brief.three_things_to_know.map(translate)
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
        languages[lang.id] = loc;
        await docRef.update({ languages });
        console.log(`[LOCALIZATION] ${lang.label} translation complete`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LOCALIZATION] ${lang.label} translation FAILED for ${articleId}:`, msg);
        loc.translationStatus = "failed";
        loc.audioStatus = "failed"; // Skip audio if translation fails
        languages[lang.id] = loc;
        await docRef.update({ languages });
        continue;
      }
    }

    if (loc.translationStatus === "ready" && (loc.audioStatus === "pending" || loc.audioStatus === "failed")) {
      console.log(`[TTS] ${lang.label} started`);
      loc.audioStatus = "processing";
      languages[lang.id] = loc;
      await docRef.update({ languages });

      try {
        const script = narrationText([
          loc.quick_brief.headline,
          loc.quick_brief.quick_summary,
          "What happened.",
          loc.full_article.what_happened,
          "Why this matters.",
          loc.full_article.why_this_matters,
          ...loc.full_article.explore_sections.map(s => s.title + ". " + s.content)
        ]);

        await synthesizeSpeech("ఇది తెలుగు వాయిస్ పరీక్ష.", lang.code, "kavitha");
        const audioBuffer = await synthesizeNarration(script, lang.code, "kavitha");
        console.log(`[TTS] ${lang.label} complete — ${audioBuffer.length} bytes`);
        
        const upload = await uploadNarration(articleId, lang.id, audioBuffer);
        loc.audioUrl = upload.publicUrl;
        
        loc.audioStatus = "ready";
        languages[lang.id] = loc;
        await docRef.update({ languages });
        console.log(`[STORAGE] ${lang.label} audio uploaded — ${upload.objectPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[TTS] ${lang.label} FAILED for ${articleId}:`, msg);
        loc.audioStatus = "failed";
        languages[lang.id] = loc;
        await docRef.update({ languages });
      }
    }
  }

  // Handle English Audio
  console.log(`[TTS] English started`);
  let enLoc = languages["en"] || {
    title: article.quick_brief.headline,
    quick_brief: article.quick_brief,
    full_article: article.full_article,
    translationStatus: "ready",
    audioStatus: "pending",
  };
  
  if (enLoc.originalHash !== currentHash || enLoc.audioStatus === "failed") {
    enLoc.audioStatus = "processing";
    enLoc.translationStatus = "ready";
    enLoc.originalHash = currentHash;
    languages["en"] = enLoc;
    await docRef.update({ languages });
    
    try {
      const script = narrationText([
        article.quick_brief.headline,
        article.quick_brief.quick_summary,
        "What happened.",
        article.full_article.what_happened,
        "Why this matters.",
        article.full_article.why_this_matters,
        ...(article.full_article.explore_sections || []).map(s => s.title + ". " + s.content)
      ]);

      await synthesizeSpeech("This is an English voice test.", "en-IN", "ritu");
      const audioBuffer = await synthesizeNarration(script, "en-IN", "ritu");
      console.log(`[TTS] English complete — ${audioBuffer.length} bytes`);

      const upload = await uploadNarration(articleId, "en", audioBuffer);
      enLoc.audioUrl = upload.publicUrl;
      
      enLoc.audioStatus = "ready";
      languages["en"] = enLoc;
      await docRef.update({ languages });
      console.log(`[STORAGE] English audio uploaded — ${upload.objectPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TTS] English FAILED for ${articleId}:`, msg);
      enLoc.audioStatus = "failed";
      languages["en"] = enLoc;
      await docRef.update({ languages });
    }
  }

  console.log(`[LOCALIZATION] completed for article ${articleId}`);
}
