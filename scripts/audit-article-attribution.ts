import "dotenv/config";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || "cie-connect";
if (!getApps().length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  initializeApp(raw ? { credential: cert(JSON.parse(raw)), projectId } : { projectId });
}

const snapshot = await getFirestore().collection("posts").get();
const report = snapshot.docs
  .filter((document) => String(document.data().category || "").toLowerCase() === "article")
  .map((document) => {
    const data = document.data();
    const publisher = data.originalPublisher || data.publisher || data.sourceName || data.source || null;
    const sourceUrl = data.originalSourceUrl || data.sourceUrl || data.url || null;
    const publishedAt = data.publishedAt || data.createdAt || data.timestamp || null;
    const missingNormalized = ["originalPublisher", "originalSourceUrl", "publishedAt", "sourceType"]
      .filter((field) => !data[field]);
    const unresolved = [
      !publisher && "originalPublisher",
      data.sourceType !== "original" && !sourceUrl && "originalSourceUrl",
      !publishedAt && "publishedAt",
    ].filter(Boolean);
    return {
      id: document.id,
      title: data.title || data.headline || "Untitled",
      missingNormalized,
      unresolved,
      manualReviewRequired: unresolved.length > 0 || !data.sourceType,
    };
  })
  .filter((article) => article.missingNormalized.length > 0);

console.log(JSON.stringify({
  auditedArticles: snapshot.docs.length,
  articlesMissingNormalizedAttribution: report.length,
  manualReviewRequired: report.filter((article) => article.manualReviewRequired).length,
  articles: report,
}, null, 2));
