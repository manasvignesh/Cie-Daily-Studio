# CIE Daily Studio

A new editorial and broadcast operations application for the existing CIE Daily ecosystem. It targets the current `cie-connect` Firebase project and preserves the mobile app's schema-v2 article contract.

## Run

1. Copy `.env.example` to `.env` and populate it from the existing environment. Keep `LIVEKIT_API_SECRET`, `NVIDIA_API_KEY`, and service credentials server-only (never use a `VITE_` prefix).
2. Run `npm install`.
3. Run `npm start` and open `http://127.0.0.1:3100`.
4. Run `npm run build` and `npm test` before deployment.

## Architecture

- React + TypeScript + Vite frontend
- Express server for authenticated AI generation and LiveKit token signing
- Firebase Auth, Firestore and Storage clients
- Firebase ID token verification on protected server endpoints
- LiveKit server SDK with five-minute, exact-room grants

The Studio never includes private token-signing or AI secrets in its browser bundle.

## Article contract

Articles are a single document in `posts/{articleId}` with `schema_version: 2`. The canonical independent representations are:

- `quick_brief`: `category`, `headline`, `quick_summary`, `three_things_to_know`, `key_number`
- `full_article`: `headline`, `hook`, `in_20_seconds`, `what_happened`, `why_this_matters`, `bigger_picture`, `key_stats`, `explore_sections`, `takeaways`, `quote`

Published records retain only the top-level aliases the current feed needs (`category: Article`, `status: approved`, `title`, author/media/engagement fields). New code does not reproduce the old admin's carpet-bombed camelCase and snake_case duplicates.

## Operational truth

- The mobile app consumes Firestore articles today.
- The public website is currently static and must receive a small Firebase read adapter before a Studio publish can appear there.
- Firebase Storage production rules currently deny all client writes. Media upload therefore exposes the real permission failure until an owner-scoped upload policy or server upload endpoint is deployed.
- A real phone LiveKit acceptance test still requires deployment of the token endpoint and removal of mobile client-side JWT signing.

See [AUDIT.md](./AUDIT.md) for the full evidence-backed map and test status.

## Automated editorial inbox

The server supports authenticated news ingestion, duplicate detection,
structuring through the same NVIDIA formatter used by the manual Generate button,
schema validation, and human approval through the Studio's Editorial Inbox. Setup,
payload, and scheduler instructions are in
[EDITORIAL_AUTOMATION.md](./EDITORIAL_AUTOMATION.md).

ChatGPT scheduled-task and custom-action integration is documented in
[CHATGPT_EDITORIAL_TOOL.md](./CHATGPT_EDITORIAL_TOOL.md). It exposes only the
`submit_editorial_story` queue action and deliberately provides no approval or
publishing capability.

If the scheduler should submit through GitHub instead, use the labeled-issue
bridge documented in [GITHUB_EDITORIAL_BRIDGE.md](./GITHUB_EDITORIAL_BRIDGE.md).

For provider resilience, configure `NVIDIA_API_KEY` and optionally
`NVIDIA_API_KEY_2` / `NVIDIA_API_KEY_3` as server-only variables. The server
uses a fallback credential only for authentication, rate-limit, connection,
timeout, or upstream NVIDIA failures. Never expose these values through a
`VITE_*` variable.

`GEMINI_API_KEY` optionally enables a final cross-provider fallback through
Google's OpenAI-compatible endpoint. Configure `GEMINI_MODEL` only when you
need to override the stable `gemini-2.5-flash` default.
