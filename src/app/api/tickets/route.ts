// Nhi
import { authorizeRequest } from '../../../lib/auth';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import connectDB from '../../../lib/mongodb';
import Ticket from '../../../models/Ticket';
import { classifyTicket } from '../../../lib/ollama';
import { errorResponse, json, readJsonObject, requiredText } from '../../../lib/http';
import { listTickets } from '../../../lib/tickets';
import { deliverTicketWebhook } from '../../../lib/webhook';

export async function GET(request: Request) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const url = request.url;
    await connectDB();
    // The existing dashboard fetches every ticket and filters locally.
    // Pagination is opt-in so that older clients keep their complete list.
    const params = new URL(url).searchParams;
    if (!['page', 'limit', 'status', 'search', 'sort'].some((key) => params.has(key))) {
      return json({ success: true, data: await Ticket.find({}).sort({ createdAt: -1, _id: -1 }).maxTimeMS(5000).lean() });
    }
    return json(await listTickets(url));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const body = await readJsonObject(request);
    const title = requiredText(body, 'title', 200);
    const description = requiredText(body, 'description', 10000);
    // Fail quickly on database outages before spending resources on inference.
    await connectDB();
    const result = await classifyTicket(title, description, request.signal);
    const ticket = await Ticket.create({
      ticketId: `TCK-${randomUUID()}`, title, description,
      category: result.category, priority: result.priority, assignedTeam: result.assignedTeam,
      aiReason: result.reason, aiSuggestion: result.suggestion, status: 'Open',
    });
    if (process.env.N8N_WEBHOOK_URL?.trim()) {
      const payload = {
        eventId: `ticket.created:${ticket.ticketId}`, ticketId: ticket.ticketId,
        title: ticket.title, description: ticket.description, category: ticket.category,
        priority: ticket.priority, assignedTeam: ticket.assignedTeam,
        aiReason: ticket.aiReason, aiSuggestion: ticket.aiSuggestion,
        status: ticket.status, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt?.toISOString(),
      };
      after(() => deliverTicketWebhook(payload));
    }
    return json({ success: true, message: 'Ollama đã phân loại và tạo ticket thành công.', data: ticket }, 201);
  } catch (error) { return errorResponse(error); }
}
