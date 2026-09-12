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
  { id: "ta", sarvamCode: "ta-IN", name: "Tamil", nativeLabel: "தமிழ்", speaker: "ishita", ttsEnabled: true },
  { id: "kn", sarvamCode: "kn-IN", name: "Kannada", nativeLabel: "ಕನ್ನಡ", speaker: "ishita", ttsEnabled: true },
  { id: "ml", sarvamCode: "ml-IN", name: "Malayalam", nativeLabel: "മലയാളം", speaker: "pooja", ttsEnabled: true },
  { id: "bn", sarvamCode: "bn-IN", name: "Bengali", nativeLabel: "বাংলা", speaker: "roopa", ttsEnabled: true },
  { id: "mr", sarvamCode: "mr-IN", name: "Marathi", nativeLabel: "मराठी", speaker: "priya", ttsEnabled: true },
  { id: "gu", sarvamCode: "gu-IN", name: "Gujarati", nativeLabel: "ગુજરાતી", speaker: "priya", ttsEnabled: true },
  { id: "pa", sarvamCode: "pa-IN", name: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ", speaker: "roopa", ttsEnabled: true },
  { id: "od", sarvamCode: "od-IN", name: "Odia", nativeLabel: "ଓଡ଼ିଆ", speaker: "pooja", ttsEnabled: true },
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
