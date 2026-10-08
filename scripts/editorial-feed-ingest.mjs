import { URL } from "node:url";

const INGEST_URL = "https://cie-daily-studio.vercel.app/api/editorial-ingest";
const DEFAULT_FEEDS = [
  { url: "https://feeds.bbci.co.uk/news/technology/rss.xml", sourceName: "BBC News", domain: "Technology" },
  { url: "https://www.theverge.com/rss/index.xml", sourceName: "The Verge", domain: "Technology" },
  { url: "https://feeds.feedburner.com/TechCrunch/", sourceName: "TechCrunch", domain: "Startups" },
  { url: "https://www.wired.com/feed/rss", sourceName: "WIRED", domain: "AI & ML" },
  { url: "https://www.nasa.gov/rss/dyn/breaking_news.rss", sourceName: "NASA", domain: "Science" },
  { url: "https://www.thehindu.com/sci-tech/technology/feeder/default.rss", sourceName: "The Hindu", domain: "India" },
];

const cleanText = (value) => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:amp|#38);/gi, "&").replace(/&(?:quot|#34);/gi, '"')
  .replace(/&(?:apos|#39);/gi, "'").replace(/&(?:lt|#60);/gi, "<")
  .replace(/&(?:gt|#62);/gi, ">")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ").trim();

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

export function parseFeed(xml, feed) {
  const entries = [];
  const blocks = [...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)];
  for (const match of blocks) {
    const block = match[1];
    const title = tagValue(block, "title");
    const linkTag = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
    const linkAttr = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i);
    const sourceUrl = cleanText(linkAttr?.[1] || linkTag?.[1] || "");
    const publishedAt = tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated") || tagValue(block, "dc:date");
    const summary = tagValue(block, "description") || tagValue(block, "summary") || tagValue(block, "content:encoded");
    if (!title || !sourceUrl || !publishedAt || !summary) continue;
    let validUrl;
    try { validUrl = new URL(sourceUrl); if (!["http:", "https:"].includes(validUrl.protocol)) continue; validUrl.hash = ""; } catch { continue; }
    const date = new Date(publishedAt);
    if (Number.isNaN(date.getTime())) continue;
    const factualSummary = cleanText(summary);
    if (factualSummary.length < 40) continue;
    const sentences = factualSummary.split(/(?<=[.!?])\s+/).filter(Boolean);
    entries.push({ title: title.slice(0, 240), sourceUrl: validUrl.toString(), sourceName: feed.sourceName, publishedAt: date.toISOString(), domain: feed.domain, summary: factualSummary.slice(0, 1000), keyFacts: [sentences[0] || factualSummary, sentences[1] || `The report is published by ${feed.sourceName}.`].slice(0, 2), location: "", imageUrl: "" });
  }
  return entries;
}

export function feedConfig(raw = process.env.EDITORIAL_FEEDS) {
  if (!raw) return DEFAULT_FEEDS;
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter((feed) => feed && typeof feed.url === "string" && typeof feed.sourceName === "string" && typeof feed.domain === "string") : DEFAULT_FEEDS; } catch { return DEFAULT_FEEDS; }
}

export function recentStories(entries, now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1000) {
  return entries.filter((entry) => now - Date.parse(entry.publishedAt) <= maxAgeMs && Date.parse(entry.publishedAt) <= now).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export async function collectStories(feeds = feedConfig(), fetchImpl = fetch) {
  const collected = [];
  for (const feed of feeds) {
    try { const response = await fetchImpl(feed.url, { headers: { Accept: "application/rss+xml, application/atom+xml, text/xml" }, signal: AbortSignal.timeout(15_000) }); if (response.ok) collected.push(...parseFeed(await response.text(), feed)); } catch { /* publisher outages are isolated */ }
  }
  return recentStories(collected).slice(0, 10);
}

export async function submitStories(stories, secret, fetchImpl = fetch) {
  if (!stories.length) return { results: [], submitted: 0 };
  if (!secret) throw new Error("EDITORIAL_INGEST_SECRET is not configured.");
  const response = await fetchImpl(INGEST_URL, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ stories }), signal: AbortSignal.timeout(58_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Editorial ingest returned HTTP ${response.status}.`);
  return { results: Array.isArray(body.results) ? body.results : [body], submitted: stories.length };
}

if (process.argv[1]?.endsWith("editorial-feed-ingest.mjs")) {
  const stories = await collectStories();
  const result = process.env.DRY_RUN === "true" ? { results: [], submitted: stories.length } : await submitStories(stories, process.env.EDITORIAL_INGEST_SECRET);
  console.log(JSON.stringify({ feeds: feedConfig().length, candidates: stories.length, accepted: result.results.filter((item) => item?.ok === true).length }));
}
