/**
 * Recursively removes undefined values before sending an editorial document to
 * Firestore. Non-plain objects (Timestamp, FieldValue sentinels, Date, etc.)
 * are passed through untouched so Firestore can serialize them natively.
 */
export function firestoreSafeValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => firestoreSafeValue(entry)) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) output[key] = firestoreSafeValue(entry);
  }
  return output as T;
}

