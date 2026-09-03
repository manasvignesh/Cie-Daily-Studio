# CIE Daily ecosystem audit — 2 September 2026

## A. Discovered architecture

### Mobile app — `C:\Users\Public\New67\app`

- Flutter 3/Dart application using Riverpod, GoRouter, Firebase Auth, Cloud Firestore, Firebase Messaging/App Check, LiveKit and WebRTC.
- Firebase project: `cie-connect`; Storage bucket: `cie-connect.firebasestorage.app`.
- Auth supports email/password and Google sign-in. Profiles live in `users/{uid}`.
- Discover reads `posts` where `status == approved`, ordered by `createdAt`. Schema-v2 documents are parsed from `quick_brief` and `full_article`.
- Reels are also in `posts`, selected by `category == Reel` and `status == approved`.
- Article/reel comments are top-level `comments` documents keyed by `parentId`. Live messages are under `liveStreams/{streamId}/messages`.
- Live surfaces read `liveStreams` where `status == live`. `roomName` is preferred, with legacy room aliases accepted.
- Topic communities use a separate `spaces` collection (`name`, `description`, `coverImageUrl`, `iconUrl`, `technologyId`, `memberCount`, `moderatorIds`).
- Reading duration is recorded in `postEngagements/{userId_postId}`. Impression, brief-open, full-open, completion, share, Live join-failure and disconnect events are not currently instrumented.
- Cloud Functions contain a secure LiveKit token issuer using Secret Manager, Firebase ID-token verification, stored-room matching, short TTLs and publish restrictions.

### Old admin — `C:\Users\Manas\OneDrive\Desktop\Admin stream`

- React/Vite/TypeScript client with Express, Firebase client/Admin SDKs, LiveKit, OpenAI-compatible AI generation and Cloudinary uploads.
- Uses the same `cie-connect` Firebase project.
- Article publishing writes to `posts`, but creates a very large set of duplicate aliases and substitutes brief content when full-story fields are missing.
- AI generation calls an NVIDIA-hosted OpenAI-compatible endpoint. The route was unauthenticated and contained a hardcoded provider fallback credential.
- The LiveKit Express route has sound fundamentals: verified Firebase tokens, exact stream/room checks, stored role derivation, five-minute grants and rate limiting. Its eight route tests pass.
- The browser auth layer can auto-create an admin profile and even falls back to admin access after Firestore errors. This is not safe to preserve.
- Reels upload through a public Cloudinary upload preset and write to `posts`.
- Live comments code uses `liveStreams/{id}/comments`, while the current mobile uses `liveStreams/{id}/messages`; this is a real contract mismatch.

### Public website — `C:\Users\Manas\Cie daily web`

- React Server Components through Vinext/Vite, hosted with OpenAI Sites/Cloudflare configuration.
- All homepage, brief and full-story content is hardcoded. There is no Firebase SDK, Firestore request, article ID routing or backend API.
- Therefore the current website cannot receive any admin publish operation. A read-only Firebase/server adapter and ID-based story routes are required.

## B. Data map

```text
Flutter mobile ─┐
                ├─ Firebase Auth / Firestore (cie-connect)
Old admin ──────┤    posts, users, comments, liveStreams, spaces,
                │    technologies, postEngagements, chat collections
                └─ Cloudinary media (current practical upload path)

Public website: currently disconnected/static

LiveKit Cloud ← short-lived tokens ← verified server endpoint
AI provider   ← server-only credential ← authenticated Studio endpoint
```

Observed Firestore top-level collections from current code/rules include `posts`, `reels` (legacy/unused by current feed), `users`, `comments`, `liveStreams`, `live_spaces`, `spaces`, `technologies`, `postEngagements`, `notifications`, `follows`, `connectionCodes`, `connection_requests`, `connections`, `conversations`, and `group_chats`.

## C. Canonical contracts

### Article

One `posts/{id}` record. `schema_version: 2`, `category: Article`, `status: approved` for visible content. `quick_brief` and `full_article` are independent. The mobile parser's snake_case fields are authoritative. Compatibility metadata stays top-level only where the feed, author, media or engagement parser needs it.

The Pune Matel Motion document is a legacy record without `schema_version` or `quick_brief`; the mobile app recognizes it via a title/ID special case and renders a hardcoded reference structure. It is a useful editorial example, not a safe schema template.

### Featured Briefs

The Studio writes `isFeatured`, the existing `isTodaysDrop` compatibility flag, and `deckPriority`. The current mobile UI does not query those fields; it simply takes the five newest filtered Discover articles. A small mobile query/sort patch is required for editorial ordering to affect the phone.

### Live

New records use `roomName` only. Legacy aliases may be read but never generated. Presenter/listener roles come from the stored record, never from the caller's requested role. Tokens are signed only on a trusted server, scoped to the exact room and expire after five minutes.

## D. Security findings

1. Critical: the mobile app includes LiveKit signing material and locally mints publish-capable JWTs when the backend request fails. Rotate that credential after deploying the secure endpoint, then remove the fallback.
2. Critical: the old admin server contains a hardcoded AI-provider fallback credential. Rotate it and keep only the server environment value.
3. High: old scripts contain a hardcoded administrator login. Remove the scripts/credentials and rotate the password.
4. High: old admin auth grants fallback admin access after profile/rules failures and auto-creates admin profiles.
5. High: the old admin Firestore rules file allows any authenticated user to read/write everything. The mobile project's more specific rules are safer; do not deploy the old file.
6. Medium: staff authorization is split between hardcoded email allowlists and profile roles. Migrate to verified custom claims or a server-enforced role document.
7. Medium: public Cloudinary upload presets permit direct browser uploads. Add signed uploads, file validation, quotas and deletion ownership.
8. Medium: Firebase Storage reads are public and writes are globally denied. Add scoped, owner/staff paths or use a server-mediated upload service.

No credentials were rotated or printed into the new source code.

## E. New Studio

Routes: `/`, `/articles`, `/articles/new`, `/articles/:id`, `/reels`, `/media`, `/live`, `/live/:id`, `/spaces`, `/comments`, `/analytics`, `/users`, `/settings`.

Implemented: existing-account auth, live Firestore collections, article creation/edit/publish, independent AI output, validation, Featured Brief flags/order, reels records, topic spaces view, comment moderation, Storage upload with honest error state, stored-data analytics, user view, global command palette, live stream creation, preflight diagnostics, verified token request and LiveKit broadcast workspace.

## F. Test record

- Existing Express LiveKit route: 8/8 tests passed.
- Existing Firebase Function token issuer: 8/8 tests passed.
- New article contract tests: 2/2 passed.
- New Studio TypeScript + Vite production build: passed.
- Production bundle served locally and login page visually inspected: passed.
- Article E2E to Firestore/mobile/website: not run. Publishing a new production story would be an external data mutation; the website also lacks retrieval code.
- Live admin-to-phone E2E: not run. It requires a deployed secure endpoint, rotated leaked LiveKit credential, patched mobile client and a physical authenticated phone.
- Mobile Flutter regression: not run in this environment.

## G. Remaining blockers

1. Patch and deploy the website's Firebase retrieval and ID routes.
2. Patch mobile Featured Brief selection to use `isFeatured` + `deckPriority`.
3. Patch mobile LiveKit service to remove local signing and target the deployed secure endpoint; rotate the exposed LiveKit credential.
4. Deploy server environment/service identity. Local configuration has no service-account value; the Studio uses verified user-authenticated Firestore REST reads on server authorization paths.
5. Approve and deploy scoped Storage rules or a signed media endpoint.
6. Run the specified production article publish and physical-phone Live acceptance tests.

