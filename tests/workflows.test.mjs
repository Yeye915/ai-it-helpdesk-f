import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const names = ["WF07_high-priority-alert.json", "WF08_sla-monitoring.json", "WF09_audit-log.json"];
const workflows = names.map((name) => JSON.parse(readFileSync(new URL(`../n8n-workflows/${name}`, import.meta.url))));
const now = Date.parse("2026-10-31T06:00:00.000Z");
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const ticket = { ticketId: "TCK-100001", title: "Wi-Fi unavailable", description: "Cannot connect", priority: "High", status: "Open", createdAt: new Date(now - 3600000).toISOString() };

async function run(workflow, input, downstream) {
  let data = input;
  const outputs = new Map();
  for (const node of workflow.nodes) {
    if (node.type === "n8n-nodes-base.code") {
      const execute = new Function("$input", "$execution", "$", "Date", node.parameters.jsCode);
      const output = execute({ first: () => ({ json: data }) }, { id: "test-execution" }, (name) => ({ first: () => ({ json: outputs.get(name) }) }), Clock);
      assert.equal(output.length, 1, node.name);
      data = output[0].json;
    } else if (node.type === "n8n-nodes-base.httpRequest") {
      if (!downstream) return data;
      data = await downstream(node, JSON.parse(JSON.stringify(data)));
    }
    outputs.set(node.name, data);
  }
  return data;
}

test("each workflow has exactly 12 reachable, numbered nodes and a valid webhook response", () => {
  const expectedPaths = ["high-priority-alert", "sla-monitoring", "audit-log"];
  const ids = new Set();
  for (const [index, workflow] of workflows.entries()) {
    assert.equal(workflow.nodes.length, 12);
    assert.equal(workflow.active, false);
    assert.equal(workflow.nodes[0].parameters.path, expectedPaths[index]);
    assert.equal(workflow.nodes[0].parameters.responseMode, "responseNode");
    for (const [i, node] of workflow.nodes.entries()) {
      assert.ok(node.name.startsWith(`${String(i + 1).padStart(2, "0")} - `));
      assert.ok(!ids.has(node.id));
      ids.add(node.id);
      if (i < 11) assert.deepEqual(workflow.connections[node.name].main[0], [{ node: workflow.nodes[i + 1].name, type: "main", index: 0 }]);
      else assert.equal(workflow.connections[node.name], undefined);
      if (node.type === "n8n-nodes-base.code") new Function("$input", "$execution", "$", "Date", node.parameters.jsCode);
      if (node.type === "n8n-nodes-base.httpRequest") {
        assert.equal(node.parameters.method, "POST");
        assert.equal(new URL(node.parameters.url).pathname, `/webhook/${expectedPaths[index + 1]}`);
        assert.equal(node.parameters.body, "={{ JSON.stringify($json) }}");
      }
    }
    assert.equal(workflow.nodes[11].type, "n8n-nodes-base.respondToWebhook");
    assert.equal(workflow.nodes[11].parameters.responseBody, "={{ $json }}");
  }
});

test("WF07 normalizes nested webhook payloads and preserves ticket fields and traces", async () => {
  const data = await run(workflows[0], { headers: { authorization: "private" }, body: { body: { ...ticket, workflowTrace: ["WF01"] }, priority: " high ", workflowTrace: ["WF06"] } });
  assert.equal(data.ticketId, ticket.ticketId);
  assert.equal(data.priority, "High");
  assert.equal(data.alert.required, true);
  assert.equal(data.alert.sent, false);
  assert.equal(data.alert.status, "pending_configuration");
  assert.ok(data.alert.message.includes(ticket.ticketId));
  assert.deepEqual(data.workflowTrace, ["WF01", "WF06", "WF07"]);
  assert.equal(data.headers, undefined);
  assert.equal(data.body, undefined);
});

test("WF07 alerts only for active High or Critical tickets and never claims delivery", async () => {
  for (const priority of ["Critical", "High", "Medium", "Low"]) {
    for (const status of ["Open", "In Progress", "Resolved"]) {
      const data = await run(workflows[0], { ...ticket, priority, status });
      const required = status !== "Resolved" && ["High", "Critical"].includes(priority);
      assert.equal(data.alert.required, required);
      assert.equal(data.alert.sent, false);
      assert.equal(data.alert.status, required ? "pending_configuration" : "not_required");
    }
  }
});

test("workflows reject missing IDs, invalid JSON shapes, unsupported priority and invalid dates", async () => {
  for (const workflow of workflows) {
    await assert.rejects(run(workflow, { title: "Missing ID" }), /ticketId/);
    await assert.rejects(run(workflow, { body: [] }), /JSON object/);
    await assert.rejects(run(workflow, { ...ticket, priority: { invalid: true } }), /priority must be a string/);
  }
  for (const workflow of workflows.slice(0, 2)) {
    await assert.rejects(run(workflow, { ...ticket, priority: "constructor" }), /priority must be/);
    await assert.rejects(run(workflow, { ...ticket, createdAt: "not-a-date" }), /createdAt/);
    await assert.rejects(run(workflow, { ...ticket, status: "anything" }), /status/);
  }
});

test("WF08 assigns 1/4/24/72 hour deadlines from the original creation timestamp", async () => {
  for (const [priority, hours] of Object.entries({ Critical: 1, High: 4, Medium: 24, Low: 72 })) {
    const data = await run(workflows[1], { body: { ...ticket, priority } });
    assert.equal(data.sla.targetHours, hours);
    assert.equal(data.sla.dueAt, new Date(Date.parse(ticket.createdAt) + hours * 3600000).toISOString());
    assert.equal(data.sla.createdAtSource, "ticket_created_at");
    assert.equal(data.sla.escalationSent, false);
  }
});

test("WF08 handles overdue, exact deadline, resolved tickets and missing creation time", async () => {
  const expired = { ...ticket, createdAt: new Date(now - 5 * 3600000).toISOString() };
  const overdue = await run(workflows[1], expired);
  assert.equal(overdue.sla.breached, true);
  assert.equal(overdue.sla.overdueMinutes, 60);
  assert.equal(overdue.sla.escalationRequired, true);
  assert.equal(overdue.sla.escalationStatus, "pending_configuration");
  const exact = await run(workflows[1], { ...ticket, createdAt: new Date(now - 4 * 3600000).toISOString() });
  assert.equal(exact.sla.breached, false);
  const resolved = await run(workflows[1], { ...expired, status: "Resolved" });
  assert.equal(resolved.sla.breached, false);
  assert.equal(resolved.sla.state, "resolved");
  const missing = await run(workflows[1], { ...ticket, createdAt: undefined });
  assert.equal(missing.createdAt, new Date(now).toISOString());
  assert.equal(missing.sla.createdAtSource, "received_at");
});

test("WF09 builds an auditable event without claiming persistence or copying credentials", async () => {
  const data = await run(workflows[2], { body: { ...ticket, actor: { id: "user-1", name: "Example", password: "private" }, passwordHash: "private", MONGODB_URI: "private", workflowTrace: ["WF07", "WF08"] } });
  assert.equal(data.processingComplete, true);
  assert.equal(data.auditLog.ticketId, ticket.ticketId);
  assert.equal(data.auditLog.event, "ticket.processed");
  assert.equal(data.auditLog.eventId, `ticket.processed:${ticket.ticketId}:test-execution`);
  assert.equal(data.auditLog.persisted, false);
  assert.equal(data.auditLog.storageStatus, "not_configured");
  assert.deepEqual(data.workflowTrace, ["WF07", "WF08", "WF09"]);
  assert.deepEqual(data.auditLog.workflowTrace, data.workflowTrace);
  assert.deepEqual(data.auditLog.actor, { type: "user", id: "user-1", name: "Example" });
  assert.equal(JSON.stringify(data).includes("private"), false);
  assert.equal(data._auditSnapshot, undefined);
  assert.equal(data._auditAlert, undefined);
  assert.equal(data._auditSla, undefined);
});

test("the three workflow code pipelines interoperate across serialized webhook handoffs", async () => {
  const dispatch = async (node, payload) => {
    const path = new URL(node.parameters.url).pathname;
    const target = path.endsWith("sla-monitoring") ? workflows[1] : workflows[2];
    return run(target, { body: payload }, dispatch);
  };
  const data = await run(workflows[0], { body: ticket }, dispatch);
  assert.equal(data.processingComplete, true);
  assert.equal(data.ticketId, ticket.ticketId);
  assert.equal(data.description, ticket.description);
  assert.deepEqual(data.workflowTrace, ["WF07", "WF08", "WF09"]);
  assert.equal(data.alert.required, true);
  assert.equal(data.sla.targetHours, 4);
  assert.equal(data.auditLog.alert.required, true);
  assert.equal(data.auditLog.sla.breached, false);
});

test("WF07 and WF08 reject incomplete or mismatched downstream responses", async () => {
  for (const workflow of workflows.slice(0, 2)) {
    await assert.rejects(run(workflow, ticket, async () => ({ processingComplete: false })), /completed audit/);
    await assert.rejects(run(workflow, ticket, async () => ({ ticketId: "TCK-OTHER", processingComplete: true, auditLog: { ticketId: "TCK-OTHER", eventId: "event" } })), /does not match/);
  }
});
