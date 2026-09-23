import dotenv from "dotenv";
dotenv.config();

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { processLocalization } from "../src/lib/localization.ts";
import { SUPPORTED_LANGUAGES, getLanguageConfig } from "../src/lib/languages.ts";

function initFirebase() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || "cie-connect";
  initializeApp(
    raw
      ? { credential: cert(JSON.parse(raw)), projectId }
      : { projectId }
  );
}

async function run() {
  const startTime = Date.now();
  console.log("=== STARTING MULTILINGUAL LOCALIZATION PIPELINE VERIFICATION ===");
  initFirebase();
  const db = getFirestore();

  // Find an approved or published article to test
  console.log("Searching for test article in Firestore...");
  const snapshot = await db.collection("posts")
    .where("status", "in", ["approved", "published"])
    .limit(5)
    .get();

  if (snapshot.empty) {
    console.error("No approved or published posts found in Firestore.");
    process.exit(1);
  }

  const targetDoc = snapshot.docs[0];
  const articleId = targetDoc.id;
  const data = targetDoc.data();
  console.log(`Selected test article: [${articleId}] "${data.quick_brief?.headline || data.title}"`);

  // Step 1: Verify first batch: Hindi, Tamil, Kannada, Bengali, Marathi, Telugu, English
  const firstBatch = ["hi", "ta", "kn", "bn", "mr", "te", "en"];
  console.log(`\n--- Phase 1: Processing Core Batch (${firstBatch.join(", ")}) ---`);
  await processLocalization(articleId, firstBatch);

  // Step 2: Verify second batch: Malayalam, Gujarati, Punjabi, Odia
  const secondBatch = ["ml", "gu", "pa", "od"];
  console.log(`\n--- Phase 2: Processing Remaining Batch (${secondBatch.join(", ")}) ---`);
  await processLocalization(articleId, secondBatch);

  // Step 3: Fetch updated document and inspect all 11 languages
  const updatedSnap = await db.collection("posts").doc(articleId).get();
  const updatedData = updatedSnap.data();
  const languages = updatedData?.languages || {};

  console.log("\n=== LOCALIZATION PIPELINE RESULTS ===");
  const successfulTranslated: string[] = [];
  const successfulAudio: string[] = [];
  const failedLanguages: string[] = [];
  const supabasePaths: string[] = [];

  for (const lang of SUPPORTED_LANGUAGES) {
    const loc = languages[lang.id];
    console.log(`\n[${lang.id.toUpperCase()}] ${lang.name} (${lang.nativeLabel}):`);
    if (!loc) {
      console.log("  Status: NOT FOUND");
      failedLanguages.push(lang.id);
      continue;
    }

    console.log(`  Translation Status: ${loc.translationStatus}`);
    console.log(`  Audio Status:       ${loc.audioStatus}`);
    console.log(`  Title:              ${loc.title ? loc.title.slice(0, 60) + "..." : "(none)"}`);
    console.log(`  Audio URL:          ${loc.audioUrl || "(none)"}`);

    if (loc.translationStatus === "ready") {
      successfulTranslated.push(lang.id);
    } else {
      failedLanguages.push(lang.id);
    }

    if (loc.audioStatus === "ready" && loc.audioUrl) {
      successfulAudio.push(lang.id);
      supabasePaths.push(`articles/${articleId}/${lang.id}.wav`);
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log("\n==========================================");
  console.log(`Execution duration: ${durationSec}s`);
  console.log(`Languages successfully translated (${successfulTranslated.length}/${SUPPORTED_LANGUAGES.length}):`, successfulTranslated.join(", "));
  console.log(`Languages with TTS ready (${successfulAudio.length}/${SUPPORTED_LANGUAGES.length}):`, successfulAudio.join(", "));
  console.log(`Failed languages: ${failedLanguages.length > 0 ? failedLanguages.join(", ") : "NONE"}`);
  console.log("Supabase Audio Paths:\n ", supabasePaths.join("\n  "));

  if (successfulTranslated.length === SUPPORTED_LANGUAGES.length && successfulAudio.length === SUPPORTED_LANGUAGES.length) {
    console.log("\nMAJOR REGIONAL LANGUAGES READY: YES");
  } else {
    console.log("\nMAJOR REGIONAL LANGUAGES READY: NO");
  }
}

run().catch((err) => {
  console.error("Verification script error:", err);
  process.exit(1);
});
