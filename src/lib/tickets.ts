import type { PipelineStage } from 'mongoose';
import Ticket from '../models/Ticket';

export const STATUSES = ['Open', 'In Progress', 'Resolved'] as const;
export function parseTicketQuery(url: string) {
  const params = new URL(url).searchParams;
  const rawPage = Number(params.get('page') || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 1000000) : 1;
  const rawLimit = Number(params.get('limit') || 10);
  const limit = [10, 20, 50].includes(rawLimit) ? rawLimit : 10;
  const status = params.get('status') || 'All';
  const search = (params.get('search') || '').trim().slice(0, 120);
  const query: Record<string, unknown> = {};
  if ((STATUSES as readonly string[]).includes(status)) query.status = status;
  if (search) {
    const literal = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = ['ticketId', 'title', 'description', 'category', 'assignedTeam'].map((name) => ({ [name]: literal }));
  }
  const requestedSort = params.get('sort') || 'recent';
  const sort = ['recent', 'oldest', 'updated', 'priority'].includes(requestedSort) ? requestedSort : 'recent';
  return { page, limit, query, sort };
}

const priorityPipeline: PipelineStage[] = [
  { $addFields: { __priorityOrder: { $switch: { branches: ['Critical', 'High', 'Medium', 'Low'].map((value, index) => ({ case: { $eq: ['$priority', value] }, then: index })), default: 4 } } } },
  { $sort: { __priorityOrder: 1, createdAt: -1, _id: -1 } },
];

export async function listTickets(url: string) {
  const input = parseTicketQuery(url);
  const summaryQuery = Ticket.aggregate([{
    $group: {
      _id: null, total: { $sum: 1 },
      open: { $sum: { $cond: [{ $eq: ['$status', 'Open'] }, 1, 0] } },
      inProgress: { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] }, 1, 0] } },
      resolved: { $sum: { $cond: [{ $eq: ['$status', 'Resolved'] }, 1, 0] } },
      urgent: { $sum: { $cond: [{ $and: [{ $in: ['$priority', ['Critical', 'High']] }, { $ne: ['$status', 'Resolved'] }] }, 1, 0] } },
    },
  }]).option({ maxTimeMS: 5000 });
  const filtered = Object.keys(input.query).length > 0;
  const [summaries, filteredCount] = await Promise.all([summaryQuery, filtered ? Ticket.countDocuments(input.query).maxTimeMS(5000) : Promise.resolve(null)]);
  const row = summaries[0];
  const summary = { total: row?.total || 0, open: row?.open || 0, inProgress: row?.inProgress || 0, resolved: row?.resolved || 0, urgent: row?.urgent || 0 };
  const total = filteredCount ?? summary.total;
  const totalPages = Math.max(1, Math.ceil(total / input.limit));
  const page = Math.min(input.page, totalPages);
  const skip = (page - 1) * input.limit;
  const sort: Record<string, 1 | -1> = input.sort === 'oldest' ? { createdAt: 1 as const, _id: 1 as const }
    : input.sort === 'updated' ? { updatedAt: -1 as const, createdAt: -1 as const, _id: -1 as const }
      : { createdAt: -1 as const, _id: -1 as const };
  const list = input.sort === 'priority'
    ? Ticket.aggregate([{ $match: input.query }, ...priorityPipeline, { $skip: skip }, { $limit: input.limit }, { $project: { __priorityOrder: 0 } }]).option({ maxTimeMS: 5000 })
    : Ticket.find(input.query).sort(sort).skip(skip).limit(input.limit).maxTimeMS(5000).lean();
  // On the first unfiltered priority page the preview is already in the list.
  const reusePreview = !filtered && input.sort === 'priority' && page === 1;
  const [tickets, preview] = await Promise.all([list, reusePreview ? Promise.resolve(null)
    : Ticket.aggregate([...priorityPipeline, { $limit: 4 }, { $project: { __priorityOrder: 0 } }]).option({ maxTimeMS: 5000 })]);
  return { success: true, data: tickets, priorityTickets: preview ?? tickets.slice(0, 4), meta: { page, limit: input.limit, total, totalPages, summary } };
}
