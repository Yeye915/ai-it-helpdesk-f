// Nhi
import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "../../../lib/auth";

const SYSTEM_PROMPT = `Bạn là HelpMate AI, trợ lý IT nội bộ, thân thiện và thực tế.
- Trả lời bằng tiếng Việt, dễ hiểu, theo từng bước khi hướng dẫn xử lý.
- Chỉ dựa trên dữ kiện được cung cấp; nếu thiếu thông tin, hỏi thêm ngắn gọn.
- Không yêu cầu người dùng chia sẻ mật khẩu, mã OTP hoặc thông tin bí mật.
- Với thao tác có nguy cơ mất dữ liệu hoặc ảnh hưởng bảo mật, cảnh báo và hướng dẫn liên hệ đội IT.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

export async function POST(request: NextRequest) {
  const denied = await authorizeRequest(request);
  if (denied) return denied;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ." }, { status: 400 });
  }

  const payload = body as { message?: unknown; history?: unknown };
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  if (!message) {
    return NextResponse.json({ error: "Hãy nhập nội dung cần hỗ trợ." }, { status: 400 });
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: "Tin nhắn tối đa 5.000 ký tự." }, { status: 400 });
  }

  const history: ChatMessage[] = Array.isArray(payload.history)
    ? payload.history
        .filter(
          (item): item is { role: string; content: string } =>
            typeof item === "object" &&
            item !== null &&
            (item as { role?: unknown }).role !== undefined &&
            typeof (item as { content?: unknown }).content === "string"
        )
        .filter((item) => item.role === "user" || item.role === "assistant")
        .slice(-20)
        .map((item) => ({
          role: item.role as ChatMessage["role"],
          content: item.content.trim().slice(0, 5000),
        }))
        .filter((item) => item.content.length > 0)
    : [];

  const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen2.5:3b";

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: message },
        ],
        options: { temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Ollama chat error:", response.status, detail.slice(0, 500));
      return NextResponse.json(
        { error: `Ollama không gọi được model ${model} (HTTP ${response.status}). Hãy kiểm tra Ollama và model đã được tải.` },
        { status: 502 }
      );
    }

    const result = await response.json();
    const reply = result?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      return NextResponse.json({ error: "Ollama không trả về nội dung phản hồi." }, { status: 502 });
    }

    return NextResponse.json({ reply: reply.trim() });
  } catch (error) {
    console.error("Ollama chat request failed:", error);
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Ollama phản hồi quá lâu. Hãy thử lại sau."
      : "Không kết nối được Ollama. Hãy mở Ollama và kiểm tra địa chỉ OLLAMA_BASE_URL.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

