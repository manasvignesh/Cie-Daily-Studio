import assert from "node:assert/strict";
import test from "node:test";
import { chronologicalMillis, isPublishedArticle } from "../src/lib/localization.ts";

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
