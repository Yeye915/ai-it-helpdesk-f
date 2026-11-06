import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/it_helpdesk';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(uri).hostname), 'Tests require local MongoDB.');
const database = `helpmetaai_optimize_test_${randomBytes(6).toString('hex')}`;
process.env.MONGODB_URI = uri;
process.env.MONGODB_DB = database;

async function waitFor(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((done) => setTimeout(done, 50)); }
  throw new Error('Readiness timeout');
}

test('backend integration, database queries and AI resource bounds', { timeout: 120000 }, async (t) => {
  const { default: connectDB } = await import('../src/lib/mongodb.ts');
  let connectCalls = 0;
  const originalConnect = mongoose.connect;
  mongoose.connect = function (...args) { connectCalls++; return originalConnect.apply(this, args); };
  const connections = await Promise.all(Array.from({ length: 20 }, () => connectDB()));
  mongoose.connect = originalConnect;
  assert.equal(connectCalls, 1);
  assert.ok(connections.every((entry) => entry === connections[0]));
  const db = mongoose.connection.db;
  let mode = 'normal';
  const aiCalls = [];
  const webhookCalls = [];
  const classification = { category: 'Network', priority: 'High', assignedTeam: 'Network Support', reason: 'Nhiều thiết bị bị ảnh hưởng.', suggestion: 'Kiểm tra kết nối và báo đội IT.' };
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/webhook') { webhookCalls.push(body); response.end('{}'); return; }
    aiCalls.push(body);
    if (mode === 'http-error') { response.statusCode = 500; response.end('SECRET_PROVIDER_DETAIL'); return; }
    if (mode === 'bad-json') { response.end('not-json'); return; }
    if (mode === 'large') { response.end('x'.repeat(1024 * 1024 + 1)); return; }
    const reply = mode === 'empty' ? '' : body.format ? JSON.stringify(mode === 'bad-classification' ? null : classification) : 'Đã nhận yêu cầu hỗ trợ.';
    const send = () => { if (!response.destroyed) response.end(JSON.stringify({ message: { content: reply } })); };
    if (mode === 'slow') { const timer = setTimeout(send, 3000); response.on('close', () => clearTimeout(timer)); }
    else send();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise((done) => portProbe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root, detached: process.platform !== 'win32', env: { ...process.env, OLLAMA_URL: `${providerUrl}/api/chat`, OLLAMA_TIMEOUT_MS: '1000', OLLAMA_MAX_CONCURRENT: '1', N8N_WEBHOOK_URL: `${providerUrl}/webhook` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs = (logs + data).slice(-16000); });
  child.stderr.on('data', (data) => { logs = (logs + data).slice(-16000); });
  const token = randomBytes(32).toString('hex');
  const user = await db.collection('users').insertOne({ name: 'Backend test', email: 'backend-session@example.test', role: 'user' });
  await db.collection('authsessions').insertOne({ tokenHash: createHash('sha256').update(token).digest('hex'), userId: user.insertedId, expiresAt: new Date(Date.now() + 600000) });
  const authFetch = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Cookie: `helpmate_session=${token}` } });
  const api = (path, body, method = 'POST') => authFetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const fixture = Array.from({ length: 25 }, (_, index) => ({
    ticketId: `TCK-fixture-${index}`, title: index === 0 ? 'Literal [wifi].+' : `Request ${index}`, description: 'Test description',
    category: 'Network', priority: ['Critical', 'High', 'Medium', 'Low'][index % 4], status: ['Open', 'In Progress', 'Resolved'][index % 3],
    assignedTeam: 'IT General', createdAt: new Date(1700000000000 + index * 1000), updatedAt: new Date(1700000000000 + index * 1000),
  }));
  try {
    await db.collection('tickets').insertMany(fixture);
    await waitFor(async () => { try { return (await authFetch(base + '/api/tickets?page=1')).status === 200; } catch { return false; } });
    await t.test('authentication, seeded login and legacy dashboard remain compatible', async () => {
      const result = await (await authFetch(base + '/api/tickets')).json();
      assert.equal(result.data.length, 25);
      const authEnv = { ...process.env, AUTH_TEST_BASE_URL: base };
      delete authEnv.NODE_TEST_CONTEXT;
      const authOutput = execFileSync(process.execPath, ['--test', 'tests/auth.test.mjs', 'tests/seed-users.test.mjs'], { cwd: root, env: authEnv, encoding: 'utf8' });
      assert.match(authOutput, /(?:#|ℹ) fail 0/);
      assert.match(authOutput, /seeded accounts integrate with existing authentication/);
      for (const path of ['/api/tickets', '/api/chat', '/api/tickets/ai/suggest']) {
        assert.equal((await authFetch(base + path, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      }
    });
    await t.test('pagination, filtering, summaries and stable sorting remain compatible', async () => {
      const recent = await (await authFetch(base + '/api/tickets?page=1')).json();
      assert.equal(recent.data.length, 10); assert.equal(recent.meta.total, 25); assert.equal(recent.meta.totalPages, 3);
      assert.equal(recent.data[0].ticketId, 'TCK-fixture-24');
      assert.deepEqual(recent.meta.summary, {
        total: 25, open: 9, inProgress: 8, resolved: 8,
        urgent: fixture.filter((entry) => ['Critical', 'High'].includes(entry.priority) && entry.status !== 'Resolved').length,
      });
      const filtered = await (await authFetch(base + '/api/tickets?status=Resolved&limit=20')).json();
      assert.equal(filtered.meta.total, 8); assert.ok(filtered.data.every((entry) => entry.status === 'Resolved'));
      assert.equal(filtered.meta.summary.total, 25);
      const last = await (await authFetch(base + '/api/tickets?page=999999999999')).json();
      assert.equal(last.meta.page, 3); assert.equal(last.data.length, 5);
      const oldest = await (await authFetch(base + '/api/tickets?sort=oldest')).json(); assert.equal(oldest.data[0].ticketId, 'TCK-fixture-0');
      const priority = await (await authFetch(base + '/api/tickets?sort=priority')).json();
      assert.ok(priority.data.slice(0, 7).every((entry) => entry.priority === 'Critical'));
      assert.deepEqual(priority.priorityTickets, priority.data.slice(0, 4));
    });
    await t.test('search treats regex metacharacters as literal input', async () => {
      const literal = await (await authFetch(base + '/api/tickets?search=' + encodeURIComponent('[wifi].+'))).json();
      assert.equal(literal.meta.total, 1); assert.equal(literal.data[0].ticketId, 'TCK-fixture-0');
      const wildcard = await (await authFetch(base + '/api/tickets?search=' + encodeURIComponent('.*'))).json();
      assert.equal(wildcard.meta.total, 0);
    });
    await t.test('unfiltered listing uses three database reads instead of eight', async () => {
      await db.command({ profile: 2, slowms: 0 });
      try {
        assert.equal((await authFetch(base + '/api/tickets?page=1')).status, 200);
      } finally { await db.command({ profile: 0 }); }
      const reads = await db.collection('system.profile').find({ $or: [{ 'command.aggregate': 'tickets' }, { 'command.find': 'tickets' }] }).toArray();
      assert.equal(reads.length, 3);
    });
    await t.test('bad request shapes and excessive bodies fail before AI inference', async () => {
      const before = aiCalls.length;
      for (const path of ['/api/chat', '/api/tickets', '/api/tickets/ai/suggest']) {
        for (const body of [null, [], {}, { title: {}, description: 'x', message: {} }]) assert.equal((await api(path, body)).status, 400, path);
        assert.equal((await authFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
      }
      assert.equal((await api('/api/tickets', { title: 'x', description: 'x'.repeat(70000) })).status, 413);
      assert.equal((await api('/api/chat', { message: 'x'.repeat(5001) })).status, 400);
      assert.equal((await api('/api/chat', { message: 'Hi', history: {} })).status, 400);
      assert.equal(aiCalls.length, before);
    });
    await t.test('chunked JSON is bounded even without a trustworthy Content-Length', async () => {
      const { readJsonObject } = await import('../src/lib/http.ts');
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2000))); },
        cancel() { cancelled = true; },
      });
      const request = new Request('http://localhost/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
      await assert.rejects(readJsonObject(request, 1024), (error) => error.status === 413);
      assert.equal(cancelled, true);
    });
    await t.test('ticket creation uses UUIDs and delivers complete webhook metadata', async () => {
      const response = await api('/api/tickets', { title: 'New Wi-Fi issue', description: 'Many users disconnected' });
      assert.equal(response.status, 201);
      const result = await response.json(); assert.match(result.data.ticketId, /^TCK-[a-f0-9-]{36}$/);
      assert.equal(result.data.priority, 'High');
      assert.ok(await db.collection('tickets').findOne({ ticketId: result.data.ticketId }));
      await waitFor(() => webhookCalls.length === 1);
      assert.equal(webhookCalls[0].eventId, `ticket.created:${result.data.ticketId}`);
      assert.equal(webhookCalls[0].status, 'Open');
      assert.equal(webhookCalls[0].createdAt, result.data.createdAt);
    });
    await t.test('patch validates fields, preserves creation time and updates timestamps', async () => {
      const before = await db.collection('tickets').findOne({ ticketId: 'TCK-fixture-0' });
      assert.equal((await api('/api/tickets/TCK-fixture-0', null, 'PATCH')).status, 400);
      assert.equal((await api('/api/tickets/TCK-fixture-0', { status: 'Closed' }, 'PATCH')).status, 400);
      assert.equal((await api('/api/tickets/TCK-fixture-0', { description: '  ' }, 'PATCH')).status, 400);
      assert.equal((await api('/api/tickets/TCK-fixture-0', { $set: { status: 'Resolved' } }, 'PATCH')).status, 400);
      const response = await api('/api/tickets/TCK-fixture-0', { status: 'Resolved', priority: 'Low' }, 'PATCH');
      assert.equal(response.status, 200);
      const updated = (await response.json()).data;
      assert.equal(updated.priority, before.priority); assert.equal(updated.status, 'Resolved');
      assert.equal(updated.createdAt, before.createdAt.toISOString()); assert.ok(Date.parse(updated.updatedAt) > before.updatedAt.getTime());
      assert.equal((await api('/api/tickets/TCK-not-found', { status: 'Open' }, 'PATCH')).status, 404);
    });
    await t.test('chat and suggestions share the configured model and bounded context', async () => {
      const history = Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'x'.repeat(5000) }));
      assert.equal((await api('/api/chat', { message: 'Help me', history })).status, 200);
      const call = aiCalls.at(-1); assert.equal(call.model, process.env.OLLAMA_MODEL?.trim() || 'qwen2.5:3b');
      assert.equal(call.options.num_ctx, 4096); assert.equal(call.options.num_predict, 1024);
      assert.ok(call.messages.filter((entry) => entry.role !== 'system').reduce((sum, entry) => sum + entry.content.length, 0) <= 12000);
      assert.equal((await api('/api/tickets/ai/suggest', { title: 'Wi-Fi', description: 'Disconnected' })).status, 200);
      assert.equal(aiCalls.at(-1).model, call.model);
    });
    await t.test('provider failures return safe 502 errors and never create a ticket', async () => {
      const before = await db.collection('tickets').countDocuments();
      for (const value of ['http-error', 'bad-json', 'empty', 'large', 'bad-classification']) {
        mode = value;
        const response = await api('/api/tickets', { title: 'Provider failure', description: 'Test only' });
        assert.equal(response.status, 502, value);
        assert.equal((await response.text()).includes('SECRET_PROVIDER_DETAIL'), false);
      }
      mode = 'normal'; assert.equal(await db.collection('tickets').countDocuments(), before);
    });
    await t.test('AI timeout releases capacity and concurrent requests receive backpressure', async () => {
      mode = 'slow';
      const initialCalls = aiCalls.length;
      const pending = api('/api/chat', { message: 'slow' });
      await waitFor(() => aiCalls.length > initialCalls);
      const busy = await api('/api/chat', { message: 'second' });
      assert.equal(busy.status, 429); assert.equal(busy.headers.get('retry-after'), '2');
      assert.equal((await pending).status, 504);
      mode = 'normal'; assert.equal((await api('/api/chat', { message: 'recovered' })).status, 200);
    });
    await t.test('client cancellation releases the AI slot', async () => {
      mode = 'slow';
      const before = aiCalls.length;
      const controller = new AbortController();
      const pending = authFetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'cancel me' }), signal: controller.signal });
      await waitFor(() => aiCalls.length > before);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      mode = 'normal';
      await waitFor(async () => (await api('/api/chat', { message: 'after cancellation' })).status === 200, 5000);
    });
    await t.test('index migration preserves legacy audit records and enforces event identity', async () => {
      await db.collection('ticket_audit').insertMany([{ legacy: 1 }, { legacy: 2 }]);
      execFileSync(process.execPath, ['scripts/ensure-indexes.mjs'], { cwd: root, env: { ...process.env }, stdio: 'pipe' });
      const indexes = await db.collection('tickets').indexes();
      assert.ok(indexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ status: 1, createdAt: -1, _id: -1 })));
      const audit = db.collection('ticket_audit');
      await Promise.all(Array.from({ length: 10 }, () => audit.updateOne({ eventId: 'event-one' }, { $set: { eventId: 'event-one', value: 1 } }, { upsert: true })));
      assert.equal(await audit.countDocuments({ eventId: 'event-one' }), 1); assert.equal(await audit.countDocuments({ legacy: { $exists: true } }), 2);
    });
    await t.test('workflow audit uses the exported MongoDB upsert contract against a real database', async () => {
      const { createOptimizedWorkflow } = await import('../scripts/optimized-workflows.mjs');
      const workflow = createOptimizedWorkflow('WF09');
      const input = { ticketId: 'TCK-real-audit', title: 'Audit integration', eventId: 'ticket.created:TCK-real-audit', actor: { id: 'test-user', password: 'not-for-storage' }, headers: { authorization: 'not-for-storage' } };
      for (let attempt = 0; attempt < 2; attempt++) {
        let data = { body: input };
        const outputs = new Map();
        for (const node of workflow.nodes) {
          if (node.type === 'n8n-nodes-base.code') {
            const result = new Function('$input', '$execution', '$', node.parameters.jsCode)({ first: () => ({ json: data }) }, { id: 'audit-' + attempt }, (name) => ({ first: () => ({ json: outputs.get(name) }) }));
            data = result[0].json;
          } else if (node.type === 'n8n-nodes-base.mongoDb') {
            const p = node.parameters;
            const record = Object.fromEntries(p.fields.split(',').map((key) => [key, data[key]]));
            await db.collection(p.collection).updateOne({ [p.updateKey]: record[p.updateKey] }, { $set: record }, { upsert: p.upsert });
            data = record;
          }
          outputs.set(node.name, data);
        }
        assert.equal(data.processingComplete, true); assert.equal(data.auditLog.persisted, true);
      }
      const audit = db.collection('ticket_audit');
      assert.equal(await audit.countDocuments({ eventId: input.eventId }), 1);
      assert.equal(JSON.stringify(await audit.findOne({ eventId: input.eventId })).includes('not-for-storage'), false);
    });
    await t.test('seed remains idempotent and duplicate roles are rejected before mutation', async () => {
      const env = { ...process.env, ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: randomBytes(10).toString('hex'), DEMO_USER_EMAIL: 'user@example.test', DEMO_USER_PASSWORD: randomBytes(10).toString('hex'), ADDITIONAL_USER_EMAIL: '', ADDITIONAL_USER_PASSWORD: '' };
      execFileSync(process.execPath, ['scripts/seed-users.mjs'], { cwd: root, env, stdio: 'pipe' });
      execFileSync(process.execPath, ['scripts/seed-users.mjs'], { cwd: root, env, stdio: 'pipe' });
      assert.equal(await db.collection('users').countDocuments({ email: { $in: [env.ADMIN_EMAIL, env.DEMO_USER_EMAIL] } }), 2);
      assert.throws(() => execFileSync(process.execPath, ['scripts/seed-users.mjs'], { cwd: root, env: { ...env, DEMO_USER_EMAIL: env.ADMIN_EMAIL }, stdio: 'pipe' }));
      const admin = await db.collection('users').findOne({ email: env.ADMIN_EMAIL }); assert.equal(admin.role, 'admin'); assert.match(admin.passwordHash, /^scrypt\$/);
    });
    assert.equal(logs.includes('SECRET_PROVIDER_DETAIL'), false);
  } finally {
    if (child.exitCode === null) {
      if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((done) => setTimeout(done, 5000))]);
    }
    provider.closeAllConnections(); await new Promise((done) => provider.close(done));
    assert.ok(database.startsWith('helpmetaai_optimize_test_'));
    await db.dropDatabase(); await mongoose.disconnect();
  }
});
