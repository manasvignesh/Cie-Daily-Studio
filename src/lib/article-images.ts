import type { IngestStory } from './editorial-automation';

export type ImageFetch = (input: string, init?: RequestInit) => Promise<Response>;

function absoluteUrl(value: string, base: string) {
  try {
    const url = new URL(value.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function looksLikeNoise(value: string) {
  return /favicon|logo|sprite|tracking|pixel|avatar|icon|placeholder|thumb(?:nail)?|recommend/i.test(value);
}

function metadataImages(html: string, pageUrl: string) {
  const values: string[] = [];
  const tagPattern = /<meta\b[^>]*>/gi;
  for (const tag of html.match(tagPattern) || []) {
    const property = tag.match(/\b(?:property|name|itemprop)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!property || !['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'].includes(property)) continue;
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (content) values.push(content);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel=["'][^"']*(?:image_src|image)[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href) values.push(href);
  }
  return values.map((value) => absoluteUrl(value, pageUrl)).filter(Boolean);
}

async function reachableImage(url: string, fetchImpl: ImageFetch) {
  if (looksLikeNoise(url)) return false;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    const type = response.headers.get('content-type') || '';
    const length = Number(response.headers.get('content-length') || 0);
    if (response.ok && type.toLowerCase().startsWith('image/') && (!length || length >= 10_000)) return true;
  } catch {
    // Some publishers reject HEAD; validate with a bounded GET below.
  }
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
    const type = response.headers.get('content-type') || '';
    const length = Number(response.headers.get('content-length') || 0);
    if (!response.ok || !type.toLowerCase().startsWith('image/') || (length && length < 10_000)) return false;
    const body = await response.arrayBuffer();
    return body.byteLength >= 10_000;
  } catch {
    return false;
  }
}

export async function resolveArticleImage(
  story: IngestStory,
  fetchImpl: ImageFetch = fetch,
) {
  if (story.imageUrl) {
    const supplied = absoluteUrl(story.imageUrl, story.sourceUrl);
    if (supplied && await reachableImage(supplied, fetchImpl)) return supplied;
  }
  const candidates: string[] = [];
  try {
    const page = await fetchImpl(story.sourceUrl, { method: 'GET', redirect: 'follow' });
    if (page.ok && (page.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
      const html = await page.text();
      candidates.push(...metadataImages(html, story.sourceUrl));
    }
  } catch {
    // Image discovery is best effort and must never block article generation.
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await reachableImage(candidate, fetchImpl)) return candidate;
  }
  return undefined;
}
