// Nhi

import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "../../../../../lib/auth";

export async function POST(request: NextRequest) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const body = await request.json();

    const title = String(body.title ?? "").trim();
    const description = String(body.description ?? "").trim();
    const category = String(body.category ?? "Chưa phân loại");
    const priority = String(body.priority ?? "Medium");

    if (!title || !description) {
      return NextResponse.json(
        { error: "Ticket cần có tiêu đề và mô tả." },
        { status: 400 }
      );
    }

    const response = await fetch(
      process.env.OLLAMA_URL ??
        "http://127.0.0.1:11434/api/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
          stream: false,
          messages: [
            {
              role: "system",
              content: `
Bạn là chuyên gia hỗ trợ kỹ thuật IT của hệ thống HelpMate AI.
Hãy phân tích ticket và đưa ra đề xuất xử lý bằng tiếng Việt.
Chỉ dựa trên thông tin được cung cấp, không khẳng định nguyên nhân
khi chưa đủ bằng chứng.

Trả lời theo đúng cấu trúc:
1. Nhận định vấn đề
2. Nguyên nhân có thể
3. Đề xuất xử lý theo từng bước
4. Mức độ khẩn cấp và lưu ý

Đề xuất phải thực tế, dễ hiểu, phù hợp với nhân viên IT.
Nếu thiếu thông tin, hãy nêu rõ cần kiểm tra thêm điều gì.
              `.trim(),
            },
            {
              role: "user",
              content: `
Tiêu đề: ${title}
Mô tả: ${description}
Danh mục: ${category}
Mức độ ưu tiên hiện tại: ${priority}

Hãy tạo đề xuất xử lý cho ticket này.
              `.trim(),
            },
          ],
          options: {
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!response.ok) {
      throw new Error(`Ollama trả về HTTP ${response.status}`);
    }

    const result = await response.json();
    const suggestion = result.message?.content?.trim();

    if (!suggestion) {
      throw new Error("Ollama không trả về nội dung đề xuất.");
    }

    return NextResponse.json({ suggestion });
  } catch (error) {
    console.error("AI suggestion error:", error);

    return NextResponse.json(
      {
        error:
          "Không thể tạo đề xuất AI. Hãy kiểm tra Ollama và model đã chạy.",
      },
      { status: 500 }
    );
  }
}
