import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import crypto from "node:crypto";
import type { Article, LocalizedArticle } from "./types.ts";

function hashArticle(article: Article) {
  const content = JSON.stringify(article.quick_brief) + JSON.stringify(article.full_article);
  return crypto.createHash("md5").update(content).digest("hex");
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

  console.log("[SARVAM] TTS request starting");
  console.log("[SARVAM] endpoint: https://api.sarvam.ai/text-to-speech");
  console.log("[SARVAM] target language:", targetLang);
  console.log("[SARVAM] speaker:", speaker);
  console.log("[SARVAM] model: bulbul:v4");
  console.log("[SARVAM] input character count:", text.length);

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
        inputs: [text],
        target_language_code: targetLang,
        speaker: speaker,
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 24000,
        enable_preprocessing: true,
        model: "bulbul:v3"
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log(`[SARVAM] TTS HTTP status: ${response.status}`);

    if (!response.ok) {
      const err = await response.text();
      console.log(`[SARVAM] TTS failed\nstatus: ${response.status}\nresponse: ${err.slice(0, 300)}`);
      throw new Error(`Sarvam TTS failed: HTTP ${response.status}`);
    }

    console.log("[SARVAM] TTS response received");
    const result = await response.json();
    return Buffer.from(result.audios[0], "base64");
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log("[SARVAM] TTS timed out after 30000ms");
    }
    throw error;
  }
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
        const script = [
          loc.quick_brief.headline,
          loc.quick_brief.quick_summary,
          "What happened.",
          loc.full_article.what_happened,
          "Why this matters.",
          loc.full_article.why_this_matters,
          ...loc.full_article.explore_sections.map(s => s.title + ". " + s.content)
        ].join(" ");

        const audioBuffer = await synthesizeSpeech(script, lang.code, "kavitha_telugu_narration");
        console.log(`[TTS] ${lang.label} complete — ${audioBuffer.length} bytes`);
        
        const bucketName = process.env.VITE_FIREBASE_STORAGE_BUCKET || "cie-connect.firebasestorage.app";
        const storage = getStorage();
        const bucket = storage.bucket(bucketName);
        const fileName = `articles/${articleId}/audio/${lang.id}.wav`;
        const file = bucket.file(fileName);
        
        await file.save(audioBuffer, {
          metadata: { contentType: "audio/wav" },
          public: true
        });
        
        const encodedPath = encodeURIComponent(fileName);
        loc.audioUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media`;
        
        loc.audioStatus = "ready";
        languages[lang.id] = loc;
        await docRef.update({ languages });
        console.log(`[STORAGE] ${lang.label} audio uploaded — ${fileName}`);
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
      const script = [
        article.quick_brief.headline,
        article.quick_brief.quick_summary,
        "What happened.",
        article.full_article.what_happened,
        "Why this matters.",
        article.full_article.why_this_matters,
        ...(article.full_article.explore_sections || []).map(s => s.title + ". " + s.content)
      ].join(" ");

      const audioBuffer = await synthesizeSpeech(script, "en-IN", "ritu_english_stories");
      console.log(`[TTS] English complete — ${audioBuffer.length} bytes`);

      const bucketName = process.env.VITE_FIREBASE_STORAGE_BUCKET || "cie-connect.firebasestorage.app";
      const bucket = getStorage().bucket(bucketName);
      const fileName = `articles/${articleId}/audio/en.wav`;
      const file = bucket.file(fileName);
      await file.save(audioBuffer, { metadata: { contentType: "audio/wav" }, public: true });
      enLoc.audioUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
      
      enLoc.audioStatus = "ready";
      languages["en"] = enLoc;
      await docRef.update({ languages });
      console.log(`[STORAGE] English audio uploaded — ${fileName}`);
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
