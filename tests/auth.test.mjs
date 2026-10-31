import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";

const baseUrl = process.env.AUTH_TEST_BASE_URL || "http://127.0.0.1:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Run these tests against a local development instance.");
const client = new MongoClient(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/it_helpdesk");
const runId = randomBytes(10).toString("hex");
const email = `auth-test-${runId}@example.test`;
const otherEmail = `auth-race-${runId}@example.test`;
const limitedEmail = `auth-limit-${runId}@example.test`;
const password = randomBytes(20).toString("hex");
// Public registration must ignore an attempt to grant an admin role.
const registration = { name: "Người dùng kiểm thử", email, password, confirmPassword: password, role: "admin" };
const emails = [email, otherEmail, limitedEmail];
let db;

async function request(path, { body, cookie, origin, ...options } = {}) {
  return fetch(new URL(path, baseUrl), {
    redirect: "manual",
    ...options,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(cookie && { Cookie: cookie }),
      ...(origin && { Origin: origin }),
      ...options.headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function cookieOf(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

before(async () => {
  await client.connect();
  db = client.db();
});

after(async () => {
  if (db) {
    const users = await db.collection("users").find({ email: { $in: emails } }).toArray();
    await db.collection("authsessions").deleteMany({ userId: { $in: users.map((user) => user._id) } });
    await db.collection("users").deleteMany({ email: { $in: emails } });
    const window = Math.floor(Date.now() / (15 * 60 * 1000));
    const ids = emails.flatMap((address) => ["login", "register"].flatMap((mode) => [window - 1, window].map((w) => createHash("sha256").update(`${mode}:${address}:${w}`).digest("hex"))));
    await db.collection("authattempts").deleteMany({ _id: { $in: ids } });
  }
  await client.close();
});

test("MongoDB authentication lifecycle", async (t) => {
  let cookie;

  await t.test("anonymous requests cannot access user, ticket, or AI APIs", async () => {
    for (const [path, method] of [
      ["/api/auth/me", "GET"], ["/api/tickets", "GET"], ["/api/tickets", "POST"],
      ["/api/tickets/TCK-123456", "PATCH"], ["/api/chat", "POST"], ["/api/tickets/ai/suggest", "POST"],
    ]) {
      assert.equal((await request(path, { method })).status, 401, path);
    }
  });

  await t.test("invalid inputs and cross-site registration are rejected", async () => {
    for (const body of [null, [], { ...registration, email: "invalid" }, { ...registration, password: "short" }, { ...registration, name: " " }, { ...registration, confirmPassword: "different" }, { ...registration, email: { $ne: null } }]) {
      assert.equal((await request("/api/auth/register", { method: "POST", body })).status, 400);
    }
    assert.equal((await request("/api/auth/register", { method: "POST", body: registration, origin: "https://untrusted.example" })).status, 403);
    const malformed = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: undefined });
    assert.equal(malformed.status, 400);
  });

  await t.test("registration stores a password hash and issues an HttpOnly session", async () => {
    const response = await request("/api/auth/register", { method: "POST", body: registration, origin: new URL(baseUrl).origin });
    assert.equal(response.status, 201);
    const data = await response.json();
    assert.deepEqual(Object.keys(data.user).sort(), ["email", "id", "name", "role"]);
    assert.equal(data.user.role, "user");
    assert.equal(data.user.email, email);
    const header = response.headers.get("set-cookie");
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=lax/i);
    assert.match(header, /Path=\//i);
    cookie = cookieOf(response);
    const user = await db.collection("users").findOne({ email });
    assert.notEqual(user.passwordHash, password);
    assert.match(user.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    const session = await db.collection("authsessions").findOne({ userId: user._id });
    assert.notEqual(session.tokenHash, cookie.split("=")[1]);
    assert.equal(session.tokenHash, createHash("sha256").update(cookie.split("=")[1]).digest("hex"));
  });

  await t.test("session identifies the user and authorizes ticket reads", async () => {
    const response = await request("/api/auth/me", { cookie });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.name, registration.name);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const tickets = await request("/api/tickets", { cookie });
    assert.equal(tickets.status, 200);
    assert.ok(Array.isArray((await tickets.json()).data));
  });

  await t.test("duplicate email and wrong password are rejected", async () => {
    assert.equal((await request("/api/auth/register", { method: "POST", body: { ...registration, email: email.toUpperCase() } })).status, 409);
    const response = await request("/api/auth/login", { method: "POST", body: { email, password: `${password}wrong` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  await t.test("cross-site logout fails, and logout revokes the server session", async () => {
    assert.equal((await request("/api/auth/logout", { method: "POST", cookie, origin: "https://untrusted.example" })).status, 403);
    assert.equal((await request("/api/auth/me", { cookie })).status, 200);
    const response = await request("/api/auth/logout", { method: "POST", cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
    assert.equal((await request("/api/auth/me", { cookie })).status, 401);
  });

  await t.test("login normalizes email; expired or forged sessions are denied", async () => {
    const response = await request("/api/auth/login", { method: "POST", body: { email: ` ${email.toUpperCase()} `, password } });
    assert.equal(response.status, 200);
    cookie = cookieOf(response);
    assert.equal((await request("/api/auth/me", { cookie })).status, 200);
    await db.collection("authsessions").updateOne({ tokenHash: createHash("sha256").update(cookie.split("=")[1]).digest("hex") }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await request("/api/auth/me", { cookie })).status, 401);
    assert.equal((await request("/api/auth/me", { cookie: `helpmate_session=${"a".repeat(64)}` })).status, 401);
  });

  await t.test("concurrent registration cannot create duplicate accounts", async () => {
    const statuses = await Promise.all([1, 2].map(async () => (await request("/api/auth/register", { method: "POST", body: { ...registration, email: otherEmail } })).status));
    assert.deepEqual(statuses.sort(), [201, 409]);
    assert.equal(await db.collection("users").countDocuments({ email: otherEmail }), 1);
  });

  await t.test("repeated failed login is rate limited", async () => {
    for (let i = 0; i < 20; i++) {
      assert.equal((await request("/api/auth/login", { method: "POST", body: { email: limitedEmail, password } })).status, 401);
    }
    const response = await request("/api/auth/login", { method: "POST", body: { email: limitedEmail, password } });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  });
});
