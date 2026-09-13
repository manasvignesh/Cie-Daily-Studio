export interface LanguageConfig {
  id: string;
  sarvamCode: string;
  name: string;
  nativeLabel: string;
  speaker: string;
  ttsEnabled: boolean;
  isSource?: boolean;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { id: "en", sarvamCode: "en-IN", name: "English", nativeLabel: "English", speaker: "ritu", ttsEnabled: true, isSource: true },
  { id: "hi", sarvamCode: "hi-IN", name: "Hindi", nativeLabel: "हिन्दी", speaker: "priya", ttsEnabled: true },
  { id: "te", sarvamCode: "te-IN", name: "Telugu", nativeLabel: "తెలుగు", speaker: "priya", ttsEnabled: true },
];

export const LANGUAGE_MAP = new Map<string, LanguageConfig>(
  SUPPORTED_LANGUAGES.map((l) => [l.id, l]),
);

export function getLanguageConfig(id: string): LanguageConfig | undefined {
  return LANGUAGE_MAP.get(id);
}

export function getTargetLanguages(): LanguageConfig[] {
  return SUPPORTED_LANGUAGES.filter((l) => !l.isSource);
}
