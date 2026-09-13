import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES, getLanguageConfig } from "../src/lib/languages.ts";

test("the production language registry is limited to English, Hindi, and Telugu", () => {
  const expectedCodes = [
    "en-IN", "hi-IN", "te-IN",
  ];

  assert.deepEqual(SUPPORTED_LANGUAGES.map((language) => language.sarvamCode), expectedCodes);
  assert.equal(new Set(SUPPORTED_LANGUAGES.map((language) => language.id)).size, 3);
  assert.ok(SUPPORTED_LANGUAGES.every((language) => language.ttsEnabled && language.speaker));
  assert.equal(getLanguageConfig("te")?.nativeLabel, "తెలుగు");
  assert.equal(getLanguageConfig("unknown"), undefined);
});
