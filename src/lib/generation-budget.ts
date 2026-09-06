export const editorialGenerationBudgetMs = 48_000;
export const editorialPersistenceReserveMs = 10_000;
export const geminiProviderMaxMs = 38_000;
export const nvidiaProviderMaxMs = 28_000;

export type EditorialProviderName = 'gemini' | 'nvidia';

/** Returns the next provider's safe timeout, or 0 when no safe attempt fits. */
export function providerTimeoutMs(
  provider: EditorialProviderName,
  elapsedMs: number,
) {
  const remainingMs = editorialGenerationBudgetMs - Math.max(0, elapsedMs);
  if (remainingMs <= editorialPersistenceReserveMs) return 0;
  const providerMax = provider === 'gemini' ? geminiProviderMaxMs : nvidiaProviderMaxMs;
  return Math.min(providerMax, remainingMs - editorialPersistenceReserveMs);
}
