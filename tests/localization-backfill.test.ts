import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalEnglishArticle,
  chronologicalMillis,
  isPublishedArticle,
} from "../src/lib/localization.ts";

test("historical localization targets published articles but never reels", () => {
  assert.equal(isPublishedArticle({ status: "approved", category: "Article" } as never), true);
  assert.equal(isPublishedArticle({ status: "published", category: "News" } as never), true);
  assert.equal(isPublishedArticle({ status: "approved", category: "Reel" } as never), false);
  assert.equal(isPublishedArticle({ status: "draft", category: "Article" } as never), false);
});

test("chronology prefers publishedAt, falls back to createdAt, and ignores updatedAt", () => {
  const timestamp = (millis: number) => ({ toMillis: () => millis });
  assert.equal(chronologicalMillis({
    publishedAt: timestamp(300),
    createdAt: timestamp(200),
    updatedAt: timestamp(900),
  } as never), 300);
  assert.equal(chronologicalMillis({
    createdAt: timestamp(200),
    updatedAt: timestamp(900),
  } as never), 200);
  assert.equal(chronologicalMillis({ updatedAt: timestamp(900) } as never), 0);
});

test("English backfill maps legacy description and rich top-level fields", () => {
  const simple = canonicalEnglishArticle({
    status: "approved",
    category: "Event",
    title: "Legacy story",
    description: "Existing English source content.",
  } as never)!;
  assert.equal(simple.quick_brief.quick_summary, "Existing English source content.");
  assert.equal(simple.full_article.what_happened, "Existing English source content.");

  const rich = canonicalEnglishArticle({
    status: "approved",
    category: "News",
    title: "Early production story",
    description: "Existing summary.",
    whatHappened: "Existing event detail.",
    whyThisMatters: "Existing impact detail.",
    takeaways: ["Existing takeaway."],
  } as never)!;
  assert.equal(rich.full_article.what_happened, "Existing event detail.");
  assert.equal(rich.full_article.why_this_matters, "Existing impact detail.");
  assert.deepEqual(rich.full_article.takeaways, ["Existing takeaway."]);
});
