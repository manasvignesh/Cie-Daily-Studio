export interface LanguageConfig {
  id: string;
  code: string;
  name: string;
  nativeLabel: string;
  speaker: string;
  tts: boolean;
  isSource?: boolean;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { id: "en", code: "en-IN", name: "English", nativeLabel: "English", speaker: "ritu", tts: true, isSource: true },
  { id: "hi", code: "hi-IN", name: "Hindi", nativeLabel: "हिन्दी", speaker: "ritu", tts: true },
  { id: "te", code: "te-IN", name: "Telugu", nativeLabel: "తెలుగు", speaker: "kavitha", tts: true },
  { id: "ta", code: "ta-IN", name: "Tamil", nativeLabel: "தமிழ்", speaker: "kavitha", tts: true },
  { id: "kn", code: "kn-IN", name: "Kannada", nativeLabel: "ಕನ್ನಡ", speaker: "kavitha", tts: true },
  { id: "ml", code: "ml-IN", name: "Malayalam", nativeLabel: "മലയാളം", speaker: "kavitha", tts: true },
  { id: "bn", code: "bn-IN", name: "Bengali", nativeLabel: "বাংলা", speaker: "kavitha", tts: true },
  { id: "mr", code: "mr-IN", name: "Marathi", nativeLabel: "मराठी", speaker: "kavitha", tts: true },
  { id: "gu", code: "gu-IN", name: "Gujarati", nativeLabel: "ગુજરાતી", speaker: "kavitha", tts: true },
  { id: "pa", code: "pa-IN", name: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ", speaker: "kavitha", tts: true },
  { id: "od", code: "od-IN", name: "Odia", nativeLabel: "ଓଡ଼ିଆ", speaker: "kavitha", tts: true },
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
