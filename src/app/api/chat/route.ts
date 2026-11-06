// Nhi
import { authorizeRequest } from '../../../lib/auth';
import { ApiError, errorResponse, json, readJsonObject, requiredText } from '../../../lib/http';
import { requestOllama, type ChatMessage } from '../../../lib/ollama';

const SYSTEM_PROMPT = 'Bạn là HelpMate AI, trợ lý IT nội bộ. Trả lời bằng tiếng Việt, thân thiện, thực tế và theo từng bước. Chỉ dựa trên dữ kiện được cung cấp; nếu thiếu thông tin, hỏi thêm. Không yêu cầu mật khẩu, mã OTP hoặc thông tin bí mật. Với thao tác có nguy cơ mất dữ liệu hoặc ảnh hưởng bảo mật, hướng dẫn liên hệ IT.';

export async function POST(request: Request) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const body = await readJsonObject(request, 512 * 1024);
    const message = requiredText(body, 'message', 5000);
    if (body.history !== undefined && !Array.isArray(body.history)) throw new ApiError(400, 'history phải là một mảng tin nhắn.');
    const history: ChatMessage[] = [];
    let budget = Math.max(0, 12000 - message.length);
    // Preserve recent context without constructing an unbounded model prompt.
    for (const item of (Array.isArray(body.history) ? body.history : []).slice(-20).reverse()) {
      if (!item || typeof item !== 'object' || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
      const content = item.content.trim().slice(0, Math.min(5000, budget));
      if (content) { history.unshift({ role: item.role, content }); budget -= content.length; }
      if (!budget) break;
    }
    const reply = await requestOllama([{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: message }], { signal: request.signal, temperature: 0.4 });
    return json({ reply });
  } catch (error) { return errorResponse(error); }
}
