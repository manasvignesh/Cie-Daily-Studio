# Live broadcasting deployment

The Vite build alone does not run Express. `api/index.ts` exports the existing
Express app as a Vercel function; `vercel.json` routes `/api/*` to it before the SPA.
Do not deploy the Studio Firestore rules as part of this change.

Configure the existing Vercel project's server environment with `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, and `LIVEKIT_URL` (wss URL for the same LiveKit project the
phone uses). Never prefix the key or secret with `VITE_`. Firebase browser config
is also needed at build time. For Firebase Admin verification and privileged
operations, configure `FIREBASE_SERVICE_ACCOUNT_JSON` and `FIREBASE_PROJECT_ID`.
The existing Identity Toolkit / user-scoped Firestore REST fallback is retained.
Local `.env` values are not automatically supplied to a hosted Vercel function.

Rebuild and deploy the existing Studio project, including `api/`, `server.ts`,
and `vercel.json`, not just `dist/`. No hosted deployment was performed here.

## Verification

1. Studio preflight: Backend PASS and LiveKit PASS, local webcam visible.
2. Create a new stream (old falsely-live records should be ended manually).
3. Start live: authenticated presenter gets a room-scoped 5-minute token;
   connects and publishes camera and microphone; only then Firestore becomes live.
4. Install a newly built mobile APK containing the presenter-selection fix.
5. Join the same room from a separate phone account; confirm remote video/audio,
   rotate phone, mute/unmute presenter, and end stream.

Tests use mocked Firebase identity/Firestore and exercise the real Express
handler and LiveKit JWT generator. They do not prove production credentials,
Vercel routing, camera hardware, or a real phone connection.
