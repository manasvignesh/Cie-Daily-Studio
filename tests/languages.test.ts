import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES, getLanguageConfig } from "../src/lib/languages.ts";

test("the language registry matches Bulbul v3's 11-language contract", () => {
  const expectedCodes = [
    "en-IN", "hi-IN", "te-IN", "ta-IN", "kn-IN", "ml-IN",
    "bn-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN",
  ];

  assert.deepEqual(SUPPORTED_LANGUAGES.map((language) => language.sarvamCode), expectedCodes);
  assert.equal(new Set(SUPPORTED_LANGUAGES.map((language) => language.id)).size, 11);
  assert.ok(SUPPORTED_LANGUAGES.every((language) => language.ttsEnabled && language.speaker));
  assert.equal(getLanguageConfig("te")?.nativeLabel, "తెలుగు");
  assert.equal(getLanguageConfig("unknown"), undefined);
});
