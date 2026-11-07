import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOptimizedWorkflow } from './optimized-workflows.mjs';

// WF01-WF06 retain their existing lightweight rule-based business logic.
// Reuse the bounded normalization used by WF07-WF09 at every HTTP boundary.
const definitions = [
  {
    "id": "WF01",
    "file": "WF01_ticket-intake.json",
    "name": "WF01 - Ticket Intake",
    "path": "ticket-intake",
    "code": "const body = $json.body ?? $json;\nconst title = String(body.title ?? '').trim();\nconst description = String(body.description ?? '').trim();\nif (!title || !description) throw new Error('title and description are required');\nconst ticketId = String(body.ticketId ?? `TCK-${Date.now()}`);\nreturn [{json:{...body,ticketId,title,description,status:body.status ?? 'Open',createdAt:body.createdAt ?? new Date().toISOString(),source:'helpdeskai',workflowTrace:['WF01']}}];"
  },
  {
    "id": "WF02",
    "file": "WF02_ticket-classification.json",
    "name": "WF02 - Ticket Classification",
    "path": "ticket-classification",
    "code": "const t = `${$json.title} ${$json.description}`.toLowerCase();\nlet category='Other';\nif (/wifi|wi-fi|network|internet|vpn|router|lan|dns|mạng/.test(t)) category='Network';\nelse if (/laptop|computer|keyboard|mouse|monitor|printer|hardware|screen|máy tính|máy in/.test(t)) category='Hardware';\nelse if (/install|application|software|crash|error|bug|program|app|windows|office|phần mềm/.test(t)) category='Software';\nreturn [{json:{...$json,category,workflowTrace:[...($json.workflowTrace??[]),'WF02']}}];"
  },
  {
    "id": "WF03",
    "file": "WF03_priority-assessment.json",
    "name": "WF03 - Priority Assessment",
    "path": "priority-assessment",
    "code": "const t = `${$json.title} ${$json.description}`.toLowerCase();\nlet priority='Medium';\nif (/urgent|critical|production down|all users|security breach|data loss|cannot work|outage|khẩn cấp|toàn công ty|toàn bộ|mất dữ liệu|không thể làm việc/.test(t)) priority='High';\nelse if (/when possible|minor|question|how to|request information|không gấp|hỏi cách/.test(t)) priority='Low';\nreturn [{json:{...$json,priority,workflowTrace:[...($json.workflowTrace??[]),'WF03']}}];"
  },
  {
    "id": "WF04",
    "file": "WF04_team-assignment.json",
    "name": "WF04 - Team Assignment",
    "path": "team-assignment",
    "code": "const teams={Network:'Network Support',Hardware:'Hardware Support',Software:'Software Support',Other:'IT General',General:'IT General',Security:'Security Operations','Account & Access':'Identity and Access Support'};\nreturn [{json:{...$json,assignedTeam:teams[$json.category]??'IT General',workflowTrace:[...($json.workflowTrace??[]),'WF04']}}];"
  },
  {
    "id": "WF05",
    "file": "WF05_duplicate-detection.json",
    "name": "WF05 - Duplicate Detection",
    "path": "duplicate-detection",
    "code": "const key = `${$json.title} ${$json.description}`.toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();\nreturn [{json:{...$json,deduplication:{checked:false,normalizedFingerprint:key, note:'To compare against existing tickets, configure a MongoDB Find node or call the app duplicate-check API.'},workflowTrace:[...($json.workflowTrace??[]),'WF05']}}];"
  },
  {
    "id": "WF06",
    "file": "WF06_support-response.json",
    "name": "WF06 - Support Response",
    "path": "support-response",
    "code": "const category=$json.category??'General';\nconst tips={Network:'Check whether other devices can connect, reconnect to the network, and capture any error message.',Hardware:'Check power and cable connections, restart the device if safe, and note any indicator lights or error messages.',Software:'Restart the application, record the exact error, and note any recent updates or changes.',General:'Please provide the exact error message, when the issue started, and the steps already attempted.'};\nreturn [{json:{...$json,suggestedResponse:`We received your ticket ${$json.ticketId}. The support team will review it. Suggested first step: ${tips[category]??tips.General}`,workflowTrace:[...($json.workflowTrace??[]),'WF06']}}];"
  }
];
const stableId = (key) => {
  const hex = createHash('sha256').update('helpdesk-local:' + key).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};

export function createLocalWorkflow(id, previous = {}) {
  const definition = definitions.find((entry) => entry.id === id);
  if (!definition) throw new Error('Unknown local workflow');
  const index = definitions.indexOf(definition);
  const normalizer = createOptimizedWorkflow('WF07').nodes[1].parameters.jsCode.replace('return [{ json: ticket }];', `
for (const key of ['title', 'description']) {
  if (typeof ticket[key] !== 'string' || !ticket[key].trim()) throw new Error(key + ' is required');
  ticket[key] = ticket[key].trim();
}
if (ticket.title.length > 200 || ticket.description.length > 10000) throw new Error('Ticket text is too long');
if (ticket.ticketId !== undefined && (typeof ticket.ticketId !== 'string' || !ticket.ticketId.trim() || ticket.ticketId.length > 100)) throw new Error('Invalid ticketId');
if (ticket.ticketId) ticket.ticketId = ticket.ticketId.trim();
return [{ json: ticket }];`);
  const nodes = [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { httpMethod: 'POST', path: definition.path, responseMode: 'responseNode', options: {} }, webhookId: stableId(id + ':webhook') },
    { name: 'Normalize Webhook Data', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode: normalizer } },
    { name: 'Process Ticket', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode: 'const ticket = $input.first().json;\n' + definition.code.replaceAll('$json', 'ticket') } },
    { name: 'Call Next Workflow', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: { method: 'POST', url: 'http://localhost:5678/webhook/' + (definitions[index + 1]?.path || 'high-priority-alert'), sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: '={{ JSON.stringify($json) }}', options: { timeout: 30000 } } },
    { name: 'Respond to Webhook', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, parameters: { respondWith: 'json', responseBody: '={{ $json }}', options: { responseCode: 200 } } },
  ].map((node, index) => {
    const old = previous.nodes?.find((entry) => entry.name === node.name && entry.type === node.type);
    return { ...node, id: old?.id || stableId(id + ':' + node.name), position: [index * 260, 0], ...(node.webhookId && { webhookId: old?.webhookId || node.webhookId }) };
  });
  const connections = Object.fromEntries(nodes.slice(0, -1).map((node, index) => [node.name, { main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] }]));
  return { name: definition.name, nodes, connections, active: false, settings: { executionOrder: 'v1', saveManualExecutions: true }, versionId: stableId(id + ':local-v1'), meta: { templateCredsSetupCompleted: false }, tags: previous.tags || [{ name: 'HelpDeskAI' }] };
}

export async function writeLocalWorkflow(id, outDir) {
  const definition = definitions.find((entry) => entry.id === id);
  if (!definition) throw new Error('Unknown local workflow');
  const file = path.join(outDir, definition.file);
  let previous;
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(file, JSON.stringify(createLocalWorkflow(id, previous), null, 2) + '\n');
}
