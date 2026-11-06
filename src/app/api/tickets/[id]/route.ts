// Nhi
import { authorizeRequest } from '../../../../lib/auth';
import connectDB from '../../../../lib/mongodb';
import Ticket from '../../../../models/Ticket';
import { ApiError, errorResponse, json, readJsonObject, requiredText } from '../../../../lib/http';
import { STATUSES } from '../../../../lib/tickets';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const { id } = await params;
    if (!id?.trim() || id.length > 100) throw new ApiError(400, 'Ticket ID không hợp lệ.');
    const body = await readJsonObject(request);
    const update: Record<string, string> = {};
    if ('status' in body) {
      if (typeof body.status !== 'string' || !(STATUSES as readonly string[]).includes(body.status)) throw new ApiError(400, 'Trạng thái không hợp lệ.');
      update.status = body.status;
    }
    if ('title' in body) update.title = requiredText(body, 'title', 200);
    if ('description' in body) update.description = requiredText(body, 'description', 10000);
    if (!Object.keys(update).length) throw new ApiError(400, 'Không có trường hợp lệ để cập nhật.');
    await connectDB();
    const ticket = await Ticket.findOneAndUpdate({ ticketId: id.trim() }, { $set: update }, { returnDocument: 'after', runValidators: true }).maxTimeMS(5000).lean();
    if (!ticket) throw new ApiError(404, 'Không tìm thấy ticket.');
    return json({ success: true, message: 'Cập nhật ticket thành công.', data: ticket });
  } catch (error) { return errorResponse(error); }
}
