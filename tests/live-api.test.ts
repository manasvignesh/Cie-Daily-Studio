import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { getAuth } from "firebase-admin/auth";

test("serverless Live API: auth, room validation and presenter/listener grants", async () => {
  process.env.VERCEL = "1";
  process.env.LIVEKIT_API_KEY = "test-key";
  process.env.LIVEKIT_API_SECRET = "test-only-secret-not-a-production-credential";
  process.env.LIVEKIT_URL = "wss://test.invalid";
  const { default: app } = await import("../api/index.js");
  const auth = getAuth();
  const verify = auth.verifyIdToken;
  const realFetch = globalThis.fetch;
  let uid = "host";
  let record: Record<string, unknown> | null = {
    status: "scheduled", roomName: "cie_test", hostId: "host",
  };
  auth.verifyIdToken = async () => ({ uid, name: "Test user" }) as any;
  const encode = (value: unknown): any => Array.isArray(value)
    ? { arrayValue: { values: value.map(encode) } }
    : typeof value === "boolean" ? { booleanValue: value }
    : { stringValue: String(value) };
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://firestore.googleapis.com/")) {
      return record ? new Response(JSON.stringify({ fields: Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, encode(value)]),
      ) }), { status: 200 }) : new Response("{}", { status: 404 });
    }
    return realFetch(input, init);
  };
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (roomName = "cie_test", authenticated = true) => fetch(`${origin}/api/livekit/token`, {
    method: "POST", headers: { "Content-Type": "application/json",
      ...(authenticated ? { Authorization: "Bearer verified-in-test" } : {}) },
    body: JSON.stringify({ spaceId: "test", roomName, canPublish: true }),
  });
  try {
    assert.equal((await request("cie_test", false)).status, 401);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json()).livekit.configured, true);
    assert.equal((await fetch(`${origin}/api/missing`)).status, 404);
    const invalidJson = await fetch(`${origin}/api/editorial-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
      error: "invalid_json",
      message: "The request body must contain valid JSON.",
    });
    record = { role: "admin" };
    const editorial = await fetch(`${origin}/api/editorial`, {
      headers: { Authorization: "Bearer verified-in-test" },
    });
    assert.equal(editorial.status, 503);
    assert.match(editorial.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await editorial.json(), {
      error: "editorial_service_unavailable",
      message: "Editorial stories could not be loaded.",
    });
    record = { status: "scheduled", roomName: "cie_test", hostId: "host" };
    assert.equal((await request("another_room")).status, 403);
    const presenter = await (await request()).json();
    assert.equal(presenter.role, "presenter");
    const claims = JSON.parse(Buffer.from(presenter.token.split(".")[1], "base64url").toString());
    assert.equal(claims.video.room, "cie_test");
    assert.equal(claims.video.canPublish, true);
    assert.ok(claims.exp - claims.nbf <= 300);
    uid = "viewer";
    assert.equal((await request()).status, 409, "scheduled room is presenter-only");
    record!.status = "live";
    const listener = await (await request()).json();
    const listenerClaims = JSON.parse(Buffer.from(listener.token.split(".")[1], "base64url").toString());
    assert.equal(listenerClaims.video.canPublish, false, "client publish override ignored");
    assert.equal(listenerClaims.video.canSubscribe, true);
    record!.bannedUserIds = [uid];
    assert.equal((await request()).status, 403);
    delete record!.bannedUserIds;
    record!.status = "ended";
    record!.isLive = true;
    assert.equal((await request()).status, 409, "stale flag cannot reopen ended room");
    record = null;
    assert.equal((await request()).status, 404);
  } finally {
    auth.verifyIdToken = verify;
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
