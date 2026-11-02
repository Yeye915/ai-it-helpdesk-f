// Nhi
import { NextResponse } from 'next/server';
import connectDB from '../../../lib/mongodb';
import Ticket from '../../../models/Ticket';
import { authorizeRequest } from '../../../lib/auth';


type Classification = {
  category:
    | 'Network'
    | 'Hardware'
    | 'Software'
    | 'Account & Access'
    | 'Security'
    | 'Other';
  priority: 'Low' | 'Medium' | 'High';
  assignedTeam: string;
  reason: string;
  suggestion: string;
};

const categories: Classification['category'][] = [
  'Network',
  'Hardware',
  'Software',
  'Account & Access',
  'Security',
  'Other',
];

const priorities: Classification['priority'][] = [
  'Low',
  'Medium',
  'High',
];

async function classifyTicket(
  title: string,
  description: string
): Promise<Classification> {
  const baseUrl =
    process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

  const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: categories,
          },
          priority: {
            type: 'string',
            enum: priorities,
          },
          assignedTeam: {
            type: 'string',
          },
          reason: {
            type: 'string',
          },
          suggestion: {
            type: 'string',
          },
        },
        required: [
          'category',
          'priority',
          'assignedTeam',
          'reason',
          'suggestion',
        ],
      },
      messages: [
        {
          role: 'system',
          content: `
Bạn là chuyên viên IT Helpdesk.
Phân tích ticket và chỉ trả về JSON theo cấu trúc được yêu cầu.

Quy tắc phân loại:
- Network: Wi-Fi, Internet, mạng, DNS, VPN, kết nối mạng.
- Hardware: máy tính, bàn phím, chuột, màn hình, máy in hoặc thiết bị vật lý.
- Software: ứng dụng, lỗi phần mềm, cài đặt hoặc cập nhật phần mềm.
- Account & Access: đăng nhập, tài khoản, mật khẩu, quyền truy cập.
- Security: phishing, tài khoản bị xâm nhập, mã độc hoặc nguy cơ bảo mật.
- Other: các vấn đề không phù hợp nhóm trên.

Mức ưu tiên:
- High: nhiều người bị ảnh hưởng, công việc quan trọng bị dừng,
  có dấu hiệu tấn công hoặc nguy cơ mất dữ liệu.
- Medium: sự cố ảnh hưởng đáng kể nhưng vẫn có cách làm việc tạm thời.
- Low: yêu cầu thông thường, câu hỏi hoặc sự cố ít ảnh hưởng.

Không tự bịa dữ kiện.
reason và suggestion phải viết bằng tiếng Việt, ngắn gọn.
Không yêu cầu người dùng cung cấp mật khẩu hoặc OTP.
Nếu chưa đủ thông tin, hãy nêu điều cần kiểm tra thêm.
          `.trim(),
        },
        {
          role: 'user',
          content: `Tiêu đề: ${title}\nMô tả: ${description}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error('Ollama API error:', response.status, detail);

    throw new Error(
      `Không gọi được Ollama (HTTP ${response.status}). ` +
        'Hãy kiểm tra Ollama và tên mô hình.'
    );
  }

  const result = await response.json();
  const content = result?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama không trả về kết quả phân loại.');
  }

  let classification: Classification;

  try {
    classification = JSON.parse(content);
  } catch {
    throw new Error('Ollama trả về dữ liệu JSON không hợp lệ.');
  }

  if (
    !categories.includes(classification.category) ||
    !priorities.includes(classification.priority) ||
    typeof classification.assignedTeam !== 'string' ||
    typeof classification.reason !== 'string' ||
    typeof classification.suggestion !== 'string'
  ) {
    throw new Error('Kết quả phân loại từ Ollama không đúng cấu trúc.');
  }

  return classification;
}

export async function GET() {
  try {
    const denied = await authorizeRequest();
    if (denied) return denied;
    await connectDB();

    const tickets = await Ticket.find({}).sort({ createdAt: -1 });

    return NextResponse.json(
      { success: true, data: tickets },
      { status: 200 }
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Không thể tải ticket.';

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    const body = await request.json();

    const title =
      typeof body.title === 'string' ? body.title.trim() : '';

    const description =
      typeof body.description === 'string'
        ? body.description.trim()
        : '';

    if (!title || !description) {
      return NextResponse.json(
        {
          success: false,
          error: 'Tiêu đề và mô tả không được để trống.',
        },
        { status: 400 }
      );
    }

    if (title.length > 200 || description.length > 10000) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Tiêu đề tối đa 200 ký tự và mô tả tối đa 10.000 ký tự.',
        },
        { status: 400 }
      );
    }

    // Phân loại bằng Ollama trước khi lưu ticket.
    const classification = await classifyTicket(title, description);

    await connectDB();

    const ticketId = `TCK-${Math.floor(
      100000 + Math.random() * 900000
    )}`;

    const newTicket = await Ticket.create({
      ticketId,
      title,
      description,
      category: classification.category,
      priority: classification.priority,
      assignedTeam: classification.assignedTeam,
      aiReason: classification.reason,
      aiSuggestion: classification.suggestion,
      status: 'Open',
    });

    const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

    if (n8nWebhookUrl) {
      fetch(n8nWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ticketId: newTicket.ticketId,
          title: newTicket.title,
          description: newTicket.description,
          category: newTicket.category,
          priority: newTicket.priority,
          assignedTeam: newTicket.assignedTeam,
          aiReason: newTicket.aiReason,
          aiSuggestion: newTicket.aiSuggestion,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch((error) => {
        console.error('Lỗi khi gọi n8n webhook:', error);
      });
    }

    return NextResponse.json(
      {
        success: true,
        message: 'Ollama đã phân loại và tạo ticket thành công.',
        data: newTicket,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Tạo ticket thất bại.';

    console.error('Lỗi tạo ticket:', message);

    const status =
      message.includes('Ollama') ||
      message.includes('fetch failed') ||
      message.includes('ECONNREFUSED')
        ? 503
        : 500;

    return NextResponse.json(
      { success: false, error: message },
      { status }
    );
  }
}
