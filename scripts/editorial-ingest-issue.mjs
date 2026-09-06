import fs from "node:fs";
import { pathToFileURL } from "node:url";

const INGEST_URL = "https://cie-daily-studio.vercel.app/api/editorial-ingest";
const ALLOWED_DOMAINS = new Set([
  "Technology",
  "Startups",
  "AI & ML",
  "Science",
  "Engineering",
  "India",
  "Business",
]);

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

export function parseIssueBody(rawBody) {
  const raw = cleanText(rawBody);
  if (!raw)
    throw new Error("Issue body is empty. Add the canonical JSON batch.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  try {
    return JSON.parse(fenced || raw);
  } catch {
    throw new Error(
      'Issue body is not valid JSON. Use {"stories":[...]} with no extra prose.',
    );
  }
}

export function validatePayload(value) {
  const errors = [];
  if (!value || typeof value !== "object" || !Array.isArray(value.stories)) {
    return ["Payload must be an object with a stories array."];
  }
  if (value.stories.length < 1 || value.stories.length > 10) {
    errors.push("stories must contain between 1 and 10 items.");
  }
  value.stories.forEach((story, index) => {
    const prefix = `stories[${index}]`;
    if (!story || typeof story !== "object") {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    if (cleanText(story.title).length < 8)
      errors.push(`${prefix}.title must be at least 8 characters.`);
    try {
      const source = new URL(cleanText(story.sourceUrl));
      if (!["http:", "https:"].includes(source.protocol)) throw new Error();
    } catch {
      errors.push(`${prefix}.sourceUrl must be an HTTP or HTTPS URL.`);
    }
    if (!cleanText(story.sourceName))
      errors.push(`${prefix}.sourceName is required.`);
    if (
      !cleanText(story.publishedAt) ||
      Number.isNaN(Date.parse(story.publishedAt))
    ) {
      errors.push(`${prefix}.publishedAt must be a valid ISO date/time.`);
    }
    if (!ALLOWED_DOMAINS.has(cleanText(story.domain))) {
      errors.push(
        `${prefix}.domain must be one of the configured CIE Daily domains.`,
      );
    }
    if (cleanText(story.summary).length < 40)
      errors.push(`${prefix}.summary must contain at least 40 characters.`);
    if (!Array.isArray(story.keyFacts) || story.keyFacts.length < 2) {
      errors.push(`${prefix}.keyFacts must contain at least 2 facts.`);
    }
    for (const optionalUrl of ["imageUrl"]) {
      if (!cleanText(story[optionalUrl])) continue;
      try {
        const parsed = new URL(story[optionalUrl]);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      } catch {
        errors.push(`${prefix}.${optionalUrl} must be an HTTP or HTTPS URL.`);
      }
    }
  });
  return errors;
}

export function validateIssueTitle(title) {
  return /^CIE Editorial ingest\b/i.test(cleanText(title))
    ? []
    : ['Issue title must start with "CIE Editorial ingest".'];
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(
    outputFile,
    `${name}<<EOF\n${String(value)}\nEOF\n`,
    "utf8",
  );
}

function safeMessage(value) {
  return (
    cleanText(value)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 400) || "No diagnostic was returned."
  );
}

export async function forwardToEditorialIngest(
  payload,
  secret,
  fetchImpl = fetch,
) {
  if (!secret)
    throw new Error(
      "EDITORIAL_INGEST_SECRET is not configured in GitHub Actions secrets.",
    );
  const response = await fetchImpl(INGEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(58_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Editorial backend returned HTTP ${response.status} instead of JSON.`,
    );
  }
  const results = Array.isArray(body?.results) ? body.results : [body];
  if (!response.ok) {
    const messages = results
      .map((item) => safeMessage(item?.message || item?.error))
      .filter(Boolean);
    throw new Error(
      messages.join("; ") ||
        `Editorial backend returned HTTP ${response.status}.`,
    );
  }
  return results;
}

async function main() {
  const titleErrors = validateIssueTitle(process.env.ISSUE_TITLE);
  let payload;
  let results = [];
  try {
    if (titleErrors.length) throw new Error(titleErrors.join(" "));
    payload = parseIssueBody(process.env.ISSUE_BODY);
    const validationErrors = validatePayload(payload);
    if (validationErrors.length) throw new Error(validationErrors.join(" "));
    results = await forwardToEditorialIngest(
      payload,
      process.env.EDITORIAL_INGEST_SECRET,
    );
  } catch (error) {
    setOutput("success_count", 0);
    setOutput("failure_count", 1);
    setOutput("queue_ids", "");
    setOutput("should_close", "false");
    setOutput("diagnostic", safeMessage(error?.message || error));
    process.exitCode = 1;
    return;
  }
  const successCount = results.filter((item) => item?.ok === true).length;
  const failureCount = results.length - successCount;
  const queueIds = results
    .map((item) => item?.id)
    .filter(Boolean)
    .join(", ");
  setOutput("success_count", successCount);
  setOutput("failure_count", failureCount);
  setOutput("queue_ids", queueIds);
  setOutput(
    "should_close",
    failureCount === 0 && successCount > 0 ? "true" : "false",
  );
  setOutput(
    "diagnostic",
    results
      .filter((item) => item?.ok !== true)
      .map((item) => safeMessage(item?.message || item?.error))
      .join("; "),
  );
  if (failureCount > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
