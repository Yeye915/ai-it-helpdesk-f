import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Standalone n8n exports: no local modules or environment access inside Code nodes.
const stages = {
  "WF07": [
    {
      "name": "01 - Receive Ticket",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "parameters": {
        "httpMethod": "POST",
        "path": "high-priority-alert",
        "responseMode": "responseNode",
        "options": {}
      }
    },
    {
      "name": "02 - Normalize Webhook Data",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\n// Recover ticket fields from a normal webhook body or legacy nested webhook bodies.\nconst allowed = ['ticketId','title','description','category','priority','assignedTeam','status','createdAt','aiReason','aiSuggestion','suggestedResponse','deduplication','alert','sla','actor','eventId','updatedAt','source','categoryRationale','aiClassification','priorityReason','assignmentQueue','assignmentReason','assignment','prioritySignals','deduplication','stepTrace'];\nconst layers = [];\nlet value = input;\nfor (let depth = 0; depth < 16; depth++) {\n  if (typeof value === 'string') value = JSON.parse(value);\n  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ticket payload must be a JSON object');\n  layers.push(value);\n  if (!Object.prototype.hasOwnProperty.call(value, 'body')) break;\n  value = value.body;\n  if (depth === 15) throw new Error('Webhook body nesting is too deep');\n}\nconst ticket = {};\nconst trace = [];\nfor (const layer of layers.reverse()) {\n  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(layer, key)) ticket[key] = layer[key];\n  if (Array.isArray(layer.workflowTrace)) for (const entry of layer.workflowTrace.slice(-32)) {\n    if (typeof entry === 'string' && entry.length <= 80 && !trace.includes(entry)) trace.push(entry);\n  }\n}\nticket.workflowTrace = trace.slice(-32);\nif (JSON.stringify(ticket).length > 65536) throw new Error('Ticket payload exceeds the workflow size limit');\nticket._workflowTime = new Date().toISOString();\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "03 - Validate Ticket",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst ticket = { ...input };\nif (typeof ticket.ticketId !== 'string' || !ticket.ticketId.trim() || ticket.ticketId.length > 100) throw new Error('ticketId is required and must be at most 100 characters');\nticket.ticketId = ticket.ticketId.trim();\nfor (const key of ['title','description','category','priority','status','assignedTeam','aiReason','aiSuggestion','suggestedResponse']) {\n  if (ticket[key] !== undefined && typeof ticket[key] !== 'string') throw new Error(key + ' must be a string');\n}\nif (ticket.title && ticket.title.length > 200) throw new Error('title is too long');\nif (ticket.description && ticket.description.length > 10000) throw new Error('description is too long');\n\nfor (const key of ['createdAt','updatedAt']) {\n const value = ticket[key];\n if (value != null && ((!['string','number'].includes(typeof value)) || !Number.isFinite(new Date(value).getTime()))) throw new Error(key + ' must be a valid date');\n}\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "04 - Normalize Priority",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst names = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };\nconst raw = String(input.priority ?? 'Medium').trim().toLowerCase();\nif (!Object.prototype.hasOwnProperty.call(names, raw)) throw new Error('priority must be Critical, High, Medium, or Low');\nreturn [{ json: { ...input, priority: names[raw] } }];"
      }
    },
    {
      "name": "05 - Evaluate Alert Eligibility",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst statusNames = { open: 'Open', 'in progress': 'In Progress', resolved: 'Resolved', closed: 'Resolved' };\nconst status = statusNames[String(input.status ?? 'Open').trim().toLowerCase()];\nif (!status) throw new Error('status must be Open, In Progress, or Resolved');\nconst required = status !== 'Resolved' && ['Critical','High'].includes(input.priority);\nreturn [{ json: { ...input, status, alert: { required, sent: false, reason: status === 'Resolved' ? 'Ticket is resolved' : required ? 'High or Critical priority requires attention' : 'Priority does not require an alert' } } }];"
      }
    },
    {
      "name": "06 - Compose Alert Message",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst title = input.title || 'Ticket without a title';\nconst message = `[${input.priority}] ${input.ticketId}: ${title}. Assigned team: ${input.assignedTeam || 'IT General'}.`;\nreturn [{ json: { ...input, alert: { ...input.alert, message } } }];"
      }
    },
    {
      "name": "07 - Prepare Notification Plan",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nreturn [{ json: { ...input, alert: { ...input.alert, channel: null, severity: input.priority === 'Critical' ? 'critical' : input.priority === 'High' ? 'high' : 'normal', recipients: input.alert.required ? ['IT on-call','Support lead'] : [], status: input.alert.required ? 'pending_configuration' : 'not_required', evaluatedAt: input._workflowTime } } }];"
      }
    },
    {
      "name": "08 - Append Workflow Trace",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst workflowTrace = [...(input.workflowTrace ?? [])];\nif (!workflowTrace.includes('WF07')) workflowTrace.push('WF07');\nreturn [{ json: { ...input, workflowTrace } }];"
      }
    },
    {
      "name": "09 - Validate SLA Handoff",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nif (typeof input.alert.required !== 'boolean' || input.alert.sent !== false) throw new Error('Invalid alert handoff');\nif (input.createdAt !== undefined && !Number.isFinite(new Date(input.createdAt).getTime())) throw new Error('createdAt must be a valid date');\nreturn [{ json: { ...input, assignedTeam: (input.assignedTeam || 'IT General').trim() || 'IT General' } }];"
      }
    },
    {
      "name": "10 - Call SLA Monitoring",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": {
        "method": "POST",
        "url": "http://localhost:5678/webhook/sla-monitoring",
        "sendBody": true,
        "contentType": "raw",
        "rawContentType": "application/json",
        "body": "={{ JSON.stringify($json) }}",
        "options": {
          "timeout": 30000
        }
      }
    },
    {
      "name": "11 - Validate Downstream Result",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst expectedTicketId = $('09 - Validate SLA Handoff').first().json.ticketId;\nif (input.processingComplete !== true || !input.auditLog || typeof input.auditLog.eventId !== 'string') throw new Error('Downstream workflow did not return a completed audit event');\nif (input.ticketId !== expectedTicketId || input.auditLog.ticketId !== expectedTicketId || input.auditLog.persisted !== true) throw new Error('Downstream ticketId does not match the audit event');\nreturn [{ json: input }];"
      }
    },
    {
      "name": "12 - Respond",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}",
        "options": {
          "responseCode": 200
        }
      }
    }
  ],
  "WF08": [
    {
      "name": "01 - Receive Ticket",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "parameters": {
        "httpMethod": "POST",
        "path": "sla-monitoring",
        "responseMode": "responseNode",
        "options": {}
      }
    },
    {
      "name": "02 - Normalize Webhook Data",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\n// Recover ticket fields from a normal webhook body or legacy nested webhook bodies.\nconst allowed = ['ticketId','title','description','category','priority','assignedTeam','status','createdAt','aiReason','aiSuggestion','suggestedResponse','deduplication','alert','sla','actor','eventId','updatedAt','source','categoryRationale','aiClassification','priorityReason','assignmentQueue','assignmentReason','assignment','prioritySignals','deduplication','stepTrace'];\nconst layers = [];\nlet value = input;\nfor (let depth = 0; depth < 16; depth++) {\n  if (typeof value === 'string') value = JSON.parse(value);\n  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ticket payload must be a JSON object');\n  layers.push(value);\n  if (!Object.prototype.hasOwnProperty.call(value, 'body')) break;\n  value = value.body;\n  if (depth === 15) throw new Error('Webhook body nesting is too deep');\n}\nconst ticket = {};\nconst trace = [];\nfor (const layer of layers.reverse()) {\n  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(layer, key)) ticket[key] = layer[key];\n  if (Array.isArray(layer.workflowTrace)) for (const entry of layer.workflowTrace.slice(-32)) {\n    if (typeof entry === 'string' && entry.length <= 80 && !trace.includes(entry)) trace.push(entry);\n  }\n}\nticket.workflowTrace = trace.slice(-32);\nif (JSON.stringify(ticket).length > 65536) throw new Error('Ticket payload exceeds the workflow size limit');\nticket._workflowTime = new Date().toISOString();\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "03 - Validate Ticket",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst ticket = { ...input };\nif (typeof ticket.ticketId !== 'string' || !ticket.ticketId.trim() || ticket.ticketId.length > 100) throw new Error('ticketId is required and must be at most 100 characters');\nticket.ticketId = ticket.ticketId.trim();\nfor (const key of ['title','description','category','priority','status','assignedTeam','aiReason','aiSuggestion','suggestedResponse']) {\n  if (ticket[key] !== undefined && typeof ticket[key] !== 'string') throw new Error(key + ' must be a string');\n}\nif (ticket.title && ticket.title.length > 200) throw new Error('title is too long');\nif (ticket.description && ticket.description.length > 10000) throw new Error('description is too long');\n\nfor (const key of ['createdAt','updatedAt']) {\n const value = ticket[key];\n if (value != null && ((!['string','number'].includes(typeof value)) || !Number.isFinite(new Date(value).getTime()))) throw new Error(key + ' must be a valid date');\n}\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "04 - Apply SLA Policy",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst names = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };\nconst raw = String(input.priority ?? 'Medium').trim().toLowerCase();\nif (!Object.prototype.hasOwnProperty.call(names, raw)) throw new Error('priority must be Critical, High, Medium, or Low');\nreturn [{ json: { ...input, priority: names[raw], sla: { targetHours: ({ Critical: 1, High: 4, Medium: 24, Low: 72 })[names[raw]] } } }];"
      }
    },
    {
      "name": "05 - Resolve Creation Time",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst source = input.createdAt == null ? 'received_at' : 'ticket_created_at';\nconst created = input.createdAt == null ? new Date(input._workflowTime) : new Date(input.createdAt);\nif (!Number.isFinite(created.getTime())) throw new Error('createdAt must be a valid date');\nconst statusNames = { open: 'Open', 'in progress': 'In Progress', resolved: 'Resolved', closed: 'Resolved' };\nconst status = statusNames[String(input.status ?? 'Open').trim().toLowerCase()];\nif (!status) throw new Error('status must be Open, In Progress, or Resolved');\nreturn [{ json: { ...input, status, createdAt: created.toISOString(), sla: { ...input.sla, createdAtSource: source } } }];"
      }
    },
    {
      "name": "06 - Calculate SLA Deadline",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst due = new Date(new Date(input.createdAt).getTime() + input.sla.targetHours * 3600000);\nreturn [{ json: { ...input, sla: { ...input.sla, dueAt: due.toISOString() } } }];"
      }
    },
    {
      "name": "07 - Evaluate SLA Breach",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst now = new Date(input._workflowTime).getTime();\nconst due = new Date(input.sla.dueAt).getTime();\nconst resolved = input.status === 'Resolved';\nconst breached = !resolved && now > due;\nreturn [{ json: { ...input, sla: { ...input.sla, breached, state: resolved ? 'resolved' : breached ? 'overdue' : 'within_target', evaluatedAt: new Date(now).toISOString(), overdueMinutes: breached ? Math.ceil((now - due) / 60000) : 0 } } }];"
      }
    },
    {
      "name": "08 - Prepare Escalation Plan",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nreturn [{ json: { ...input, sla: { ...input.sla, escalationRequired: input.sla.breached, escalationSent: false, escalationStatus: input.sla.breached ? 'pending_configuration' : 'not_required' } } }];"
      }
    },
    {
      "name": "09 - Append Workflow Trace",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst workflowTrace = [...(input.workflowTrace ?? [])];\nif (!workflowTrace.includes('WF08')) workflowTrace.push('WF08');\nreturn [{ json: { ...input, workflowTrace } }];"
      }
    },
    {
      "name": "10 - Call Audit Log",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": {
        "method": "POST",
        "url": "http://localhost:5678/webhook/audit-log",
        "sendBody": true,
        "contentType": "raw",
        "rawContentType": "application/json",
        "body": "={{ JSON.stringify($json) }}",
        "options": {
          "timeout": 30000
        }
      }
    },
    {
      "name": "11 - Validate Downstream Result",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst expectedTicketId = $('09 - Append Workflow Trace').first().json.ticketId;\nif (input.processingComplete !== true || !input.auditLog || typeof input.auditLog.eventId !== 'string') throw new Error('Downstream workflow did not return a completed audit event');\nif (input.ticketId !== expectedTicketId || input.auditLog.ticketId !== expectedTicketId || input.auditLog.persisted !== true) throw new Error('Downstream ticketId does not match the audit event');\nreturn [{ json: input }];"
      }
    },
    {
      "name": "12 - Respond",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}",
        "options": {
          "responseCode": 200
        }
      }
    }
  ],
  "WF09": [
    {
      "name": "01 - Receive Ticket",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "parameters": {
        "httpMethod": "POST",
        "path": "audit-log",
        "responseMode": "responseNode",
        "options": {}
      }
    },
    {
      "name": "02 - Normalize Webhook Data",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\n// Recover ticket fields from a normal webhook body or legacy nested webhook bodies.\nconst allowed = ['ticketId','title','description','category','priority','assignedTeam','status','createdAt','aiReason','aiSuggestion','suggestedResponse','deduplication','alert','sla','actor','eventId','updatedAt','source','categoryRationale','aiClassification','priorityReason','assignmentQueue','assignmentReason','assignment','prioritySignals','deduplication','stepTrace'];\nconst layers = [];\nlet value = input;\nfor (let depth = 0; depth < 16; depth++) {\n  if (typeof value === 'string') value = JSON.parse(value);\n  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ticket payload must be a JSON object');\n  layers.push(value);\n  if (!Object.prototype.hasOwnProperty.call(value, 'body')) break;\n  value = value.body;\n  if (depth === 15) throw new Error('Webhook body nesting is too deep');\n}\nconst ticket = {};\nconst trace = [];\nfor (const layer of layers.reverse()) {\n  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(layer, key)) ticket[key] = layer[key];\n  if (Array.isArray(layer.workflowTrace)) for (const entry of layer.workflowTrace.slice(-32)) {\n    if (typeof entry === 'string' && entry.length <= 80 && !trace.includes(entry)) trace.push(entry);\n  }\n}\nticket.workflowTrace = trace.slice(-32);\nif (JSON.stringify(ticket).length > 65536) throw new Error('Ticket payload exceeds the workflow size limit');\nticket._workflowTime = new Date().toISOString();\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "03 - Validate Ticket",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst ticket = { ...input };\nif (typeof ticket.ticketId !== 'string' || !ticket.ticketId.trim() || ticket.ticketId.length > 100) throw new Error('ticketId is required and must be at most 100 characters');\nticket.ticketId = ticket.ticketId.trim();\nfor (const key of ['title','description','category','priority','status','assignedTeam','aiReason','aiSuggestion','suggestedResponse']) {\n  if (ticket[key] !== undefined && typeof ticket[key] !== 'string') throw new Error(key + ' must be a string');\n}\nif (ticket.title && ticket.title.length > 200) throw new Error('title is too long');\nif (ticket.description && ticket.description.length > 10000) throw new Error('description is too long');\n\nfor (const key of ['createdAt','updatedAt']) {\n const value = ticket[key];\n if (value != null && ((!['string','number'].includes(typeof value)) || !Number.isFinite(new Date(value).getTime()))) throw new Error(key + ' must be a valid date');\n}\nreturn [{ json: ticket }];"
      }
    },
    {
      "name": "04 - Select Audit Snapshot",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst snapshot = {};\nfor (const key of ['ticketId','title','status','category','priority','assignedTeam','createdAt','updatedAt']) if (input[key] !== undefined) snapshot[key] = input[key];\nconst actor = { type: 'system' };\nif (input.actor && typeof input.actor === 'object') {\n for (const key of ['id','name']) if (typeof input.actor[key] === 'string') actor[key] = input.actor[key].slice(0,200);\n if (actor.id) actor.type = 'user';\n}\nconst alert = { required: input.alert?.required === true, sent: input.alert?.sent === true };\nconst sla = { breached: input.sla?.breached === true };\nif (Number.isFinite(input.sla?.targetHours)) sla.targetHours = input.sla.targetHours;\nif (typeof input.sla?.dueAt === 'string' && Number.isFinite(new Date(input.sla.dueAt).getTime())) sla.dueAt = new Date(input.sla.dueAt).toISOString();\nreturn [{json:{...input, actor, _auditSnapshot:snapshot, _auditAlert:alert, _auditSla:sla}}];"
      }
    },
    {
      "name": "05 - Build Audit Event",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst version = input.updatedAt || input.createdAt || 'unknown';\nconst eventId = input.eventId ?? ['ticket.processed',input.ticketId,input.status || 'Open',version].join(':');\nif (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 300) throw new Error('eventId must be a nonempty string of at most 300 characters');\nconst auditLog = { event:'ticket.processed', eventId, ticketId:input.ticketId, processedAt:input._workflowTime, actor:input.actor, ticket:input._auditSnapshot, alert:input._auditAlert, sla:input._auditSla, persisted:false };\nreturn [{json:{...input, eventId, auditLog}}];"
      }
    },
    {
      "name": "06 - Append Audit Trace",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst workflowTrace = [...(input.workflowTrace || [])];\nif (!workflowTrace.includes('WF09')) workflowTrace.push('WF09');\nreturn [{json:{...input, workflowTrace, auditLog:{...input.auditLog,workflowTrace}}}];"
      }
    },
    {
      "name": "07 - Validate Audit Record",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst record = input.auditLog;\nif (record.ticketId !== input.ticketId || record.eventId !== input.eventId || !Number.isFinite(new Date(record.processedAt).getTime())) throw new Error('Invalid audit identity or timestamp');\nif (!record.workflowTrace.includes('WF09')) throw new Error('Audit trace is incomplete');\nreturn [{json:input}];"
      }
    },
    {
      "name": "08 - Prepare Audit Storage",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nreturn [{json:{eventId:input.eventId, ticketId:input.ticketId, auditTimestamp:input.auditLog.processedAt, status:input.status || 'Open', auditLog:{...input.auditLog,persisted:true}}}];"
      }
    },
    {
      "name": "09 - Upsert Audit in MongoDB",
      "type": "n8n-nodes-base.mongoDb",
      "typeVersion": 1.1,
      "parameters": {
        "operation": "update",
        "collection": "ticket_audit",
        "updateKey": "eventId",
        "upsert": true,
        "fields": "eventId,ticketId,auditTimestamp,status,auditLog",
        "options": {
          "useDotNotation": false
        }
      }
    },
    {
      "name": "10 - Confirm Audit Persistence",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst ticket = $('07 - Validate Audit Record').first().json;\nreturn [{json:{...ticket,auditLog:{...ticket.auditLog,persisted:true,storageStatus:'stored'}}}];"
      }
    },
    {
      "name": "11 - Build Final Response",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const input = $input.first().json;\nconst { _workflowTime, _auditSnapshot, _auditAlert, _auditSla, ...ticket } = input;\nreturn [{json:{...ticket,processingComplete:true,workflowResult:{workflow:'WF09 - Audit Log',ticketId:input.ticketId,processedAt:input.auditLog.processedAt,success:true}}}];"
      }
    },
    {
      "name": "12 - Respond",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}",
        "options": {
          "responseCode": 200
        }
      }
    }
  ]
};
const filenames = { WF07:'WF07_high-priority-alert.json', WF08:'WF08_sla-monitoring.json', WF09:'WF09_audit-log.json' };
function stableId(text) {
 const hex = createHash('sha256').update(text).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function createOptimizedWorkflow(id, previous = {}) {
 if (!stages[id]) throw new Error('Unsupported optimized workflow');
 const nodes = structuredClone(stages[id]).map((node,index) => ({...node,id:stableId(id+':'+node.name),position:[(index<6?index:11-index)*300,index<6?0:350]}));
 const oldWebhook = previous.nodes?.find(node=>node.type==='n8n-nodes-base.webhook');
 nodes[0].webhookId = oldWebhook?.webhookId || stableId(id+':webhook');
 const savedMongo = previous.nodes?.find(node=>node.type==='n8n-nodes-base.mongoDb');
 const mongo = nodes.find(node=>node.type==='n8n-nodes-base.mongoDb');
 if (mongo && savedMongo?.credentials) mongo.credentials = structuredClone(savedMongo.credentials);
 const connections = Object.fromEntries(nodes.slice(0,-1).map((node,index)=>[node.name,{main:[[{node:nodes[index+1].name,type:'main',index:0}]]}]));
 const result = {name:previous.name || ({WF07:'WF07 - High Priority Alert',WF08:'WF08 - SLA Monitoring',WF09:'WF09 - Audit Log'})[id],nodes,connections,active:false,settings:{executionOrder:'v1',saveManualExecutions:true},tags:previous.tags || [{name:'HelpDeskAI'}]};
 return {...result,versionId:stableId(JSON.stringify(result))};
}
export async function writeOptimizedWorkflow(id,outDir) {
 const file=path.join(outDir,filenames[id]);
 let previous={};
 try { previous=JSON.parse(await readFile(file,'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
 const result=createOptimizedWorkflow(id,previous);
 await writeFile(file,JSON.stringify(result,null,2)+'\n','utf8');
 return result;
}
