import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { test } from "node:test";
import { MongoClient } from "mongodb";

test("seeded accounts integrate with existing authentication", async (t) => {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/it_helpdesk";
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(uri).hostname), "Use a local test database.");
  const baseUrl = process.env.AUTH_TEST_BASE_URL || "http://127.0.0.1:3000";
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname));
  const runId = randomBytes(10).toString("hex");
  const accounts = ["admin", "user", "additional"].map((role) => ({
    email: `seed-${role}-${runId}@example.test`,
    password: randomBytes(20).toString("hex"),
    role: role === "admin" ? "admin" : "user",
  }));
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "it_helpdesk");
  const emails = accounts.map((account) => account.email);
  const seed = () => execFileSync(process.execPath, ["scripts/seed-users.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONGODB_URI: uri,
      MONGODB_DB: db.databaseName,
      ADMIN_EMAIL: accounts[0].email,
      ADMIN_PASSWORD: accounts[0].password,
      DEMO_USER_EMAIL: accounts[1].email,
      DEMO_USER_PASSWORD: accounts[1].password,
      ADDITIONAL_USER_EMAIL: accounts[2].email,
      ADDITIONAL_USER_PASSWORD: accounts[2].password,
      ADDITIONAL_USER_NAME: "Tài khoản kiểm thử",
    },
  });
  const login = (account, password = account.password) => fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password }),
  });

  try {
    await t.test("seed writes three accounts with roles and scrypt hashes", async () => {
      seed();
      const saved = await db.collection("users").find({ email: { $in: emails } }).toArray();
      assert.equal(saved.length, 3);
      for (const account of accounts) {
        const user = saved.find((entry) => entry.email === account.email);
        assert.equal(user.role, account.role);
        assert.match(user.passwordHash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
        assert.notEqual(user.passwordHash, account.password);
      }
    });
    await t.test("all seeded passwords log in and return the stored role", async () => {
      for (const account of accounts) {
        const response = await login(account);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.user.email, account.email);
        assert.equal(result.user.role, account.role);
        assert.equal(result.user.passwordHash, undefined);
      }
      assert.equal((await login(accounts[0], "incorrect-password")).status, 401);
    });
    await t.test("repeated seeding preserves account IDs without duplicates", async () => {
      const before = await db.collection("users").find({ email: { $in: emails } }).sort({ email: 1 }).toArray();
      seed();
      const after = await db.collection("users").find({ email: { $in: emails } }).sort({ email: 1 }).toArray();
      assert.deepEqual(after.map((user) => user._id.toString()), before.map((user) => user._id.toString()));
      assert.equal((await login(accounts[0])).status, 200);
    });
    await t.test("malformed stored hashes are rejected without a server error", async () => {
      await db.collection("users").updateOne({ email: accounts[2].email }, { $set: { passwordHash: "scrypt$invalid" } });
      assert.equal((await login(accounts[2])).status, 401);
    });
  } finally {
    const users = await db.collection("users").find({ email: { $in: emails } }).toArray();
    await db.collection("authsessions").deleteMany({ userId: { $in: users.map((user) => user._id) } });
    await db.collection("users").deleteMany({ email: { $in: emails } });
    const window = Math.floor(Date.now() / (15 * 60 * 1000));
    const ids = emails.flatMap((email) => [window - 1, window].map((value) => createHash("sha256").update(`login:${email}:${value}`).digest("hex")));
    await db.collection("authattempts").deleteMany({ _id: { $in: ids } });
    await client.close();
  }
});
