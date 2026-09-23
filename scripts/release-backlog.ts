import dotenv from "dotenv";
dotenv.config();

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { toPublishedPost, validateArticle } from "../src/lib/article-contract.ts";
import { defaultEditorialIdentity } from "../src/lib/editorial-automation.ts";
import { firestoreSafeValue } from "../src/lib/firestore-safe.ts";

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

async function runBacklogRelease() {
  console.log("=== BREAKPOINT STUDIO: STARTING EDITORIAL BACKLOG RELEASE ===");
  initFirebase();
  const db = getFirestore();

  const snapshot = await db.collection("editorial_queue").get();
  console.log("Found total queue documents: " + snapshot.docs.length);

  let alreadyPublished = 0;
  let newlyPublished = 0;
  let failed = 0;
  let skippedDuplicates = 0;
  const releaseDetails: any[] = [];

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const id = doc.id;
    const title = data.source?.title || data.normalizedHeadline || id;

    if (data.duplicate) {
      skippedDuplicates += 1;
      continue;
    }

    if (data.status === "published" && data.publishedArticleId) {
      alreadyPublished += 1;
      continue;
    }

    if (!data.generatedArticle) {
      console.warn(`Queue item [${id}] has no generatedArticle — skipping.`);
      failed += 1;
      releaseDetails.push({ id, title, status: "no_article", reason: "Missing generated article content" });
      continue;
    }

    const article = data.generatedArticle;
    const errors = validateArticle(article).filter((issue) => issue.level === "error");
    if (errors.length) {
      console.warn(`Queue item [${id}] failed validation: ${errors.map((e) => e.message).join("; ")}`);
      failed += 1;
      releaseDetails.push({ id, title, status: "validation_failed", errors: errors.map((e) => e.message) });
      continue;
    }

    try {
      const existingPostId = data.publishedArticleId;
      const postRef = existingPostId
        ? db.collection("posts").doc(existingPostId)
        : db.collection("posts").doc();

      const postData = {
        ...toPublishedPost(article, defaultEditorialIdentity),
        sourceUrl: data.source?.sourceUrl || data.canonicalSourceUrl || "",
        sourceName: data.source?.sourceName || article.originalPublisher || "Breakpoint Editorial",
        sourcePublishedAt: data.source?.publishedAt || new Date().toISOString(),
        editorialQueueId: id,
      };

      await postRef.set(firestoreSafeValue({
        ...postData,
        createdAt: data.receivedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        publishedAt: data.receivedAt || FieldValue.serverTimestamp(),
      }), { merge: true });

      await doc.ref.update(firestoreSafeValue({
        status: "published",
        publishedArticleId: postRef.id,
        publishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        failureReason: null,
      }));

      newlyPublished += 1;
      releaseDetails.push({
        id,
        title: article.quick_brief?.headline || title,
        status: "published",
        publishedArticleId: postRef.id,
      });
      console.log(`Successfully published [${id}] -> Post [${postRef.id}] ("${article.quick_brief?.headline || title}")`);
    } catch (err: any) {
      console.error(`Failed to publish [${id}]:`, err);
      failed += 1;
      releaseDetails.push({ id, title, status: "publish_error", reason: err.message });
    }
  }

  console.log("\n=== BACKLOG RELEASE SUMMARY ===");
  console.log("Total queue items scanned: " + snapshot.docs.length);
  console.log("Already published (retained): " + alreadyPublished);
  console.log("Newly published: " + newlyPublished);
  console.log("Skipped duplicates: " + skippedDuplicates);
  console.log("Failed / unpublishable: " + failed);
  console.log("===============================\n");
}

runBacklogRelease().catch((err) => {
  console.error("Backlog release error:", err);
  process.exit(1);
});