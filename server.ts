import "dotenv/config";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeApp,
  cert,
  getApps,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { AccessToken } from "livekit-server-sdk";
import OpenAI from "openai";

const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  "cie-connect";
if (!getApps().length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  initializeApp(
    raw
      ? { credential: cert(JSON.parse(raw)), projectId }
      : { projectId },
  );
}
const app = express();
app.use(express.json({ limit: "4mb" }));

type VerifiedUser = { uid: string; email?: string; name?: string };
type AuthedRequest = Request & {
  firebaseUser?: VerifiedUser;
  idToken?: string;
};
function bearer(req: Request) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: () => void,
) {
  const token = bearer(req);
  if (!token) return void res.status(401).json({ error: "unauthenticated" });
  try {
    const decoded = await getAuth().verifyIdToken(token, true);
    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    };
  } catch {
    // Local Studio installations may not have Application Default Credentials.
    // Identity Toolkit validates the same Firebase ID token without trusting
    // client-provided identity fields.
    const apiKey = process.env.VITE_FIREBASE_API_KEY;
    if (!apiKey)
      return void res
        .status(503)
        .json({ error: "firebase_auth_not_configured" });
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: token }),
        },
      );
      const body: any = await response.json();
      const account = body.users?.[0];
      if (!response.ok || !account?.localId)
        return void res.status(401).json({ error: "invalid_auth" });
      req.firebaseUser = {
        uid: account.localId,
        email: account.email,
        name: account.displayName,
      };
    } catch {
      return void res.status(503).json({ error: "firebase_auth_unreachable" });
    }
  }
  req.idToken = token;
  next();
}
function decodeValue(v: any): any {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v)
    return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [
        k,
        decodeValue(x),
      ]),
    );
  return undefined;
}
async function readDocument(collection: string, id: string, idToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`firestore_${response.status}`);
  const json: any = await response.json();
  return Object.fromEntries(
    Object.entries(json.fields || {}).map(([k, v]) => [k, decodeValue(v)]),
  );
}
const staffRoles = new Set([
  "admin",
  "editor",
  "author",
  "moderator",
  "creator",
]);
async function requireStaff(
  req: AuthedRequest,
  res: Response,
  next: () => void,
) {
  try {
    const profile = await readDocument(
      "users",
      req.firebaseUser!.uid,
      req.idToken!,
    );
    const role = String(profile?.role || "").toLowerCase();
    if (
      !staffRoles.has(role) &&
      req.firebaseUser!.email !== "manasvig43@gmail.com"
    )
      return void res.status(403).json({ error: "staff_required" });
    next();
  } catch {
    return void res.status(503).json({ error: "identity_check_failed" });
  }
}

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    firebase: { projectId, auth: true },
    ai: { configured: !!process.env.NVIDIA_API_KEY },
    livekit: {
      configured: !!(
        process.env.LIVEKIT_API_KEY &&
        process.env.LIVEKIT_API_SECRET &&
        (process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL)
      ),
    },
  }),
);

const prompt = `You are the editorial engine for CIE Daily. Use only the supplied source. Return strict JSON with exactly two independent representations: quick_brief and full_article. quick_brief has category, headline, quick_summary (35-60 words), three_things_to_know (exactly 3 concise facts), key_number ({value,label} or null). full_article has headline, hook, in_20_seconds, what_happened (60+ words), why_this_matters (50+ words), bigger_picture, key_stats (array), explore_sections (3-6 story-specific sections, never generic "Key Story Breakdown"; each has title, summary, content, items [{title,description}]), takeaways (3-5), quote ({text,speaker,role} or null). Do not copy the brief into the full article. Never invent facts or quotes.`;

function parseGeneratedArticle(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned no JSON object");
  const article = JSON.parse(cleaned.slice(start, end + 1));
  if (!article?.quick_brief || !article?.full_article) {
    throw new Error("AI response is missing quick_brief or full_article");
  }
  return article;
}
app.post(
  "/api/generate-article",
  requireAuth,
  requireStaff,
  async (req: AuthedRequest, res) => {
    const source = String(req.body?.sourceText || "").trim();
    if (source.length < 80)
      return res.status(400).json({ error: "source_too_short" });
    if (!process.env.NVIDIA_API_KEY)
      return res.status(503).json({ error: "ai_not_configured" });
    try {
      const ai = new OpenAI({
        apiKey: process.env.NVIDIA_API_KEY,
        baseURL:
          process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
      });
      const result = await ai.chat.completions.create({
        model: process.env.AI_MODEL || "meta/llama-3.2-11b-vision-instruct",
        temperature: 0.15,
        max_tokens: 5000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: `Category: ${String(req.body?.category || "General")}\nSource:\n${source}`,
          },
        ],
      });
      const text = result.choices[0]?.message?.content;
      if (!text) throw new Error("empty_ai_response");
      const article = parseGeneratedArticle(text);
      return res.json({ article });
    } catch (error: any) {
      return res
        .status(502)
        .json({
          error: "generation_failed",
          detail: error?.message?.slice(0, 160) || "unknown",
        });
    }
  },
);

const tokenBuckets = new Map<string, { count: number; reset: number }>();
app.post("/api/livekit/token", requireAuth, async (req: AuthedRequest, res) => {
  const uid = req.firebaseUser!.uid,
    now = Date.now(),
    bucket = tokenBuckets.get(uid);
  if (bucket && bucket.reset > now && bucket.count >= 12)
    return res.status(429).json({ error: "rate_limited" });
  tokenBuckets.set(
    uid,
    bucket && bucket.reset > now
      ? { ...bucket, count: bucket.count + 1 }
      : { count: 1, reset: now + 60_000 },
  );
  const spaceId = String(req.body?.spaceId || ""),
    roomName = String(req.body?.roomName || "");
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(spaceId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(roomName)
  )
    return res.status(400).json({ error: "invalid_request" });
  try {
    let stream = await readDocument("liveStreams", spaceId, req.idToken!);
    if (!stream) {
      stream = await readDocument("live_spaces", spaceId, req.idToken!);
    }
    if (!stream) return res.status(404).json({ error: "stream_not_found" });
    const canonical = String(
      stream.roomName || stream.room_name || stream.channelId || stream.channel_name || "",
    ).trim();
    if (!canonical || canonical !== roomName)
      return res.status(403).json({ error: "room_mismatch" });
    
    const presenters = [
      stream.hostId,
      stream.host_id,
      stream.presenterId,
      stream.presenter_id,
      ...(stream.presenterIds || []),
      ...(stream.coHostIds || []),
      ...(stream.moderatorIds || []),
    ];
    const canPublish = presenters.includes(uid);
    const status = String(stream.status || "").toLowerCase();
    // Presenters must connect and publish before advertising a live stream.
    if (stream.endedAt || stream.ended_at ||
        (status !== "live" && !(canPublish && status === "scheduled")))
      return res.status(409).json({ error: "stream_ended" });
    if (
      stream.isPublic === false &&
      !canPublish &&
      !(stream.allowedUserIds || []).includes(uid)
    )
      return res.status(403).json({ error: "not_authorized" });
    if (
      [
        ...(stream.bannedUserIds || []),
        ...(stream.removedUserIds || []),
      ].includes(uid)
    )
      return res.status(403).json({ error: "not_authorized" });
    const key = process.env.LIVEKIT_API_KEY,
      secret = process.env.LIVEKIT_API_SECRET,
      url = process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL;
    if (!key || !secret || !url)
      return res.status(503).json({ error: "livekit_not_configured" });
    const token = new AccessToken(key, secret, {
      identity: uid,
      name:
        req.firebaseUser!.name || req.firebaseUser!.email || "CIE Daily user",
      ttl: 300,
    });
    token.addGrant({
      roomJoin: true,
      room: canonical,
      canSubscribe: true,
      canPublish,
      canPublishData: canPublish,
    });
    return res.json({
      token: await token.toJwt(),
      serverUrl: url,
      roomName: canonical,
      role: canPublish ? "presenter" : "listener",
      expiresInSeconds: 300,
    });
  } catch (error: any) {
    return res
      .status(503)
      .json({
        error: "token_service_failed",
        detail: error?.message?.slice(0, 120) || "unknown",
      });
  }
});

app.post("/api/streams", requireAuth, requireStaff, async (req: AuthedRequest, res) => {
  const uid = req.firebaseUser!.uid;
  const { id: reqId, title, description, roomName: reqRoom, status, isPublic } = req.body || {};
  if (!title) return res.status(400).json({ error: "title_required" });

  const streamId = String(reqId || "").trim() || `stream_${Date.now()}`;
  const roomName = String(reqRoom || "").trim() || `cie_${streamId.replace(/[^A-Za-z0-9]/g, "")}`;
  const hostName = req.firebaseUser?.name || req.firebaseUser?.email || "Host";

  const livekitUrl = "wss://cie-daily-79ts1icb.livekit.cloud";
  const isLive = false; // Never advertise an unconnected presenter as live.
  const streamData = {
    id: streamId,
    title: String(title).trim(),
    description: String(description || "").trim(),
    roomName,
    room_name: roomName,
    channelId: roomName,
    channel_name: roomName,
    spaceId: streamId,
    space_id: streamId,
    hostId: uid,
    host_id: uid,
    hostName,
    host_name: hostName,
    presenterId: uid,
    presenter_id: uid,
    presenterIds: [uid],
    status: isLive ? "live" : "scheduled",
    isLive,
    is_live: isLive,
    isPublic: isPublic !== false,
    is_public: isPublic !== false,
    participantCount: 0,
    participant_count: 0,
    viewersCount: 0,
    viewers_count: 0,
    peakViewerCount: 0,
    peak_viewer_count: 0,
    livekitUrl,
    livekit_url: livekitUrl,
    serverUrl: livekitUrl,
    server_url: livekitUrl,
  };

  try {
    try {
      const db = getFirestore();
      const existing = await db.collection("liveStreams").doc(streamId).get();
      if (existing.exists && existing.data()?.hostId !== uid)
        return res.status(403).json({ error: "not_authorized" });
      await db.collection("liveStreams").doc(streamId).set({
        ...streamData,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await db.collection("live_spaces").doc(streamId).set({
        ...streamData,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ ok: true, id: streamId, roomName });
    } catch (adminErr: any) {
      console.warn("Admin SDK write notice, attempting REST API fallback:", adminErr?.message);
    }

    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/liveStreams?documentId=${encodeURIComponent(streamId)}`;
    const firestoreBody = {
      fields: {
        id: { stringValue: streamId },
        title: { stringValue: streamData.title },
        description: { stringValue: streamData.description },
        roomName: { stringValue: streamData.roomName },
        room_name: { stringValue: streamData.roomName },
        channelId: { stringValue: streamData.roomName },
        spaceId: { stringValue: streamId },
        hostId: { stringValue: uid },
        host_id: { stringValue: uid },
        hostName: { stringValue: hostName },
        host_name: { stringValue: hostName },
        presenterId: { stringValue: uid },
        presenter_id: { stringValue: uid },
        presenterIds: { arrayValue: { values: [{ stringValue: uid }] } },
        status: { stringValue: streamData.status },
        isLive: { booleanValue: isLive },
        is_live: { booleanValue: isLive },
        isPublic: { booleanValue: streamData.isPublic },
        is_public: { booleanValue: streamData.isPublic },
        participantCount: { integerValue: "0" },
        peakViewerCount: { integerValue: "0" },
        livekitUrl: { stringValue: livekitUrl },
        livekit_url: { stringValue: livekitUrl },
        serverUrl: { stringValue: livekitUrl },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.idToken}`,
      },
      body: JSON.stringify(firestoreBody),
    });

    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Firestore REST status: ${response.status}`);
    }

    return res.json({ ok: true, id: streamId, roomName });
  } catch (error: any) {
    console.error("Stream creation server error:", error);
    return res.status(500).json({ error: "stream_creation_failed", detail: error?.message || "Unknown error" });
  }
});

app.delete("/api/streams/:id", requireAuth, requireStaff, async (req: AuthedRequest, res) => {
  const streamId = String(req.params.id || "").trim();
  if (!streamId) return res.status(400).json({ error: "invalid_id" });

  try {
    try {
      const db = getFirestore();
      const existing = await db.collection("liveStreams").doc(streamId).get();
      if (existing.exists && existing.data()?.hostId !== req.firebaseUser!.uid)
        return res.status(403).json({ error: "not_authorized" });
      await db.collection("liveStreams").doc(streamId).delete();
      return res.json({ ok: true });
    } catch (adminErr: any) {
      console.warn("Admin SDK delete notice:", adminErr?.message);
    }

    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/liveStreams/${encodeURIComponent(streamId)}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${req.idToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Firestore REST status: ${response.status}`);
    }

    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: "stream_deletion_failed", detail: error?.message });
  }
});

// Keep API failures machine-readable. Without this guard, the SPA fallback can
// return HTML for a mistyped or unavailable API route and obscure the real error.
app.use("/api", (req, res) =>
  res.status(404).json({
    error: "api_route_not_found",
    detail: `${req.method} ${req.originalUrl}`,
  }),
);

const port = Number(process.env.STUDIO_PORT || 3100);
export default app;

async function startServer() {
if (process.env.NODE_ENV === "production") {
  const root = path.dirname(fileURLToPath(import.meta.url));
  app.use(
    express.static(path.join(root, "dist"), {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  app.get("/{*splat}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.sendFile(path.join(root, "dist", "index.html"));
  });
  const productionServer = app.listen(port, "127.0.0.1", () =>
    console.log(`CIE Daily Studio listening on http://127.0.0.1:${port}`),
  );
  productionServer.on("error", (error) => console.error("Studio server error", error));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  const developmentServer = app.listen(port, "127.0.0.1", () =>
    console.log(`CIE Daily Studio listening on http://127.0.0.1:${port}`),
  );
  developmentServer.on("error", (error) => console.error("Studio server error", error));
}
}

// Vercel invokes the exported Express handler; it must not start Vite or listen.
if (!process.env.VERCEL) void startServer();
