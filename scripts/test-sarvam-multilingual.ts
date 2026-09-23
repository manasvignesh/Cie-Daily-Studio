import dotenv from "dotenv";
dotenv.config();

import { SUPPORTED_LANGUAGES, getTargetLanguages } from "../src/lib/languages.ts";
import {
  translateText,
  synthesizeSpeech,
  synthesizeNarration,
} from "../src/lib/localization.ts";

async function testPipeline() {
  const startTime = Date.now();
  console.log("================================================================");
  console.log("   SARVAM TRANSLATE (v1) + BULBUL v3 TTS MULTILINGUAL TEST");
  console.log("================================================================");

  const testHeadline = "India's Tech Revolution: How AI is Transforming Regional Innovation";
  const testSummary = "Startups across India are adopting localized AI models to serve hundreds of millions of native speakers.";

  const results: Record<string, {
    translatedHeadline?: string;
    translationOk: boolean;
    audioBytes?: number;
    ttsOk: boolean;
    error?: string;
  }> = {};

  let requestCount = 0;

  // Step 1: Test first batch (Hindi, Tamil, Kannada, Bengali, Marathi, Telugu, English)
  const coreBatch = ["hi", "ta", "kn", "bn", "mr", "te", "en"];
  console.log(`\n>>> PHASE 1: Testing Core Batch [${coreBatch.join(", ")}]`);

  for (const langId of coreBatch) {
    const lang = SUPPORTED_LANGUAGES.find((l) => l.id === langId)!;
    console.log(`\n--- Testing ${lang.name} (${lang.nativeLabel}) [${lang.sarvamCode}] ---`);
    results[lang.id] = { translationOk: false, ttsOk: false };

    try {
      let textToSpeak = testHeadline;
      if (!lang.isSource) {
        console.log(`[Translate] translating headline to ${lang.name}...`);
        requestCount++;
        const translated = await translateText(testHeadline, lang.sarvamCode);
        results[lang.id].translatedHeadline = translated;
        results[lang.id].translationOk = true;
        textToSpeak = translated;
        console.log(`[Translate] SUCCESS: "${translated}"`);
      } else {
        results[lang.id].translatedHeadline = testHeadline;
        results[lang.id].translationOk = true;
        console.log(`[Translate] SOURCE (English): "${testHeadline}"`);
      }

      console.log(`[TTS] synthesizing speech with speaker "${lang.speaker}"...`);
      requestCount++;
      const audio = await synthesizeSpeech(textToSpeak, lang.sarvamCode, lang.speaker);
      results[lang.id].audioBytes = audio.length;
      results[lang.id].ttsOk = audio.length > 0;
      console.log(`[TTS] SUCCESS: Generated ${audio.length} bytes WAV audio`);
    } catch (err: any) {
      console.error(`[ERROR] Failed for ${lang.name}:`, err.message);
      results[lang.id].error = err.message;
    }
  }

  // Step 2: Test remaining batch (Malayalam, Gujarati, Punjabi, Odia)
  const remainingBatch = ["ml", "gu", "pa", "od"];
  console.log(`\n>>> PHASE 2: Testing Remaining Batch [${remainingBatch.join(", ")}]`);

  for (const langId of remainingBatch) {
    const lang = SUPPORTED_LANGUAGES.find((l) => l.id === langId)!;
    console.log(`\n--- Testing ${lang.name} (${lang.nativeLabel}) [${lang.sarvamCode}] ---`);
    results[lang.id] = { translationOk: false, ttsOk: false };

    try {
      console.log(`[Translate] translating headline to ${lang.name}...`);
      requestCount++;
      const translated = await translateText(testHeadline, lang.sarvamCode);
      results[lang.id].translatedHeadline = translated;
      results[lang.id].translationOk = true;
      console.log(`[Translate] SUCCESS: "${translated}"`);

      console.log(`[TTS] synthesizing speech with speaker "${lang.speaker}"...`);
      requestCount++;
      const audio = await synthesizeSpeech(translated, lang.sarvamCode, lang.speaker);
      results[lang.id].audioBytes = audio.length;
      results[lang.id].ttsOk = audio.length > 0;
      console.log(`[TTS] SUCCESS: Generated ${audio.length} bytes WAV audio`);
    } catch (err: any) {
      console.error(`[ERROR] Failed for ${lang.name}:`, err.message);
      results[lang.id].error = err.message;
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log("\n================================================================");
  console.log("                     FINAL VERIFICATION SUMMARY");
  console.log("================================================================");
  console.log(`Execution Duration: ${durationSec}s`);
  console.log(`Sarvam API Requests: ${requestCount}`);

  const translatedSuccess = SUPPORTED_LANGUAGES.filter((l) => results[l.id]?.translationOk);
  const ttsSuccess = SUPPORTED_LANGUAGES.filter((l) => results[l.id]?.ttsOk);
  const failed = SUPPORTED_LANGUAGES.filter((l) => !results[l.id]?.translationOk || !results[l.id]?.ttsOk);

  console.log(`\nLanguages Successfully Translated (${translatedSuccess.length}/${SUPPORTED_LANGUAGES.length}):`);
  for (const l of translatedSuccess) {
    console.log(`  ✓ [${l.id.padEnd(2)}] ${l.name.padEnd(10)} (${l.nativeLabel}): ${results[l.id].translatedHeadline}`);
  }

  console.log(`\nLanguages with TTS Ready (${ttsSuccess.length}/${SUPPORTED_LANGUAGES.length}):`);
  for (const l of ttsSuccess) {
    console.log(`  ✓ [${l.id.padEnd(2)}] ${l.name.padEnd(10)} (${l.nativeLabel}): ${results[l.id].audioBytes} bytes WAV`);
  }

  if (failed.length > 0) {
    console.log(`\nFailed Languages (${failed.length}):`);
    for (const l of failed) {
      console.log(`  ✗ [${l.id}] ${l.name}: ${results[l.id]?.error || "unknown"}`);
    }
  } else {
    console.log(`\nFailed Languages: NONE`);
  }

  console.log("\nExpected Storage Paths for an article {articleId}:");
  for (const l of SUPPORTED_LANGUAGES) {
    console.log(`  articles/{articleId}/${l.id}.wav`);
  }

  if (translatedSuccess.length === SUPPORTED_LANGUAGES.length && ttsSuccess.length === SUPPORTED_LANGUAGES.length) {
    console.log("\n================================================================");
    console.log("MAJOR REGIONAL LANGUAGES READY: YES");
    console.log("================================================================");
  } else {
    console.log("\nMAJOR REGIONAL LANGUAGES READY: NO");
  }
}

testPipeline().catch(console.error);
