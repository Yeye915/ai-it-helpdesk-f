// Nhi
import { NextResponse } from "next/server";
import connectDB from "../../../../lib/mongodb";
import Ticket from "../../../../models/Ticket";
import { authorizeRequest } from "../../../../lib/auth";

// Những trạng thái hợp lệ của ticket
const ALLOWED_STATUSES = ["Open", "In Progress", "Resolved"] as const;

type TicketStatus = (typeof ALLOWED_STATUSES)[number];

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const denied = await authorizeRequest(request);
    if (denied) return denied;
    // 1. Kết nối MongoDB
    await connectDB();

    // 2. Lấy ID ticket từ URL
    const { id } = await params;

    if (!id || !id.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Ticket ID không hợp lệ.",
        },
        { status: 400 }
      );
    }

    // 3. Đọc dữ liệu yêu cầu
    let body: Record<string, unknown>;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: "Dữ liệu gửi lên không phải JSON hợp lệ.",
        },
        { status: 400 }
      );
    }

    // 4. Chỉ cho phép cập nhật những trường được chỉ định
    const updateData: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      const status = body.status;

      if (
        typeof status !== "string" ||
        !ALLOWED_STATUSES.includes(status as TicketStatus)
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Trạng thái không hợp lệ. Chỉ chấp nhận Open, In Progress hoặc Resolved.",
          },
          { status: 400 }
        );
      }

      updateData.status = status;
    }

    // Cho phép cập nhật tiêu đề và mô tả nếu giao diện cần chỉnh sửa ticket.
    if (Object.prototype.hasOwnProperty.call(body, "title")) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 200
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Tiêu đề không hợp lệ hoặc vượt quá 200 ký tự.",
          },
          { status: 400 }
        );
      }

      updateData.title = body.title.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      if (
        typeof body.description !== "string" ||
        body.description.length > 10000
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Mô tả không hợp lệ hoặc vượt quá 10.000 ký tự.",
          },
          { status: 400 }
        );
      }

      updateData.description = body.description.trim();
    }

    // Không cho phép gửi request rỗng hoặc cập nhật trường không được hỗ trợ.
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Không có trường hợp lệ để cập nhật.",
        },
        { status: 400 }
      );
    }

    // 5. Cập nhật thời gian
    updateData.updatedAt = new Date();

    // 6. Tìm ticket theo ticketId và cập nhật
    const updatedTicket = await Ticket.findOneAndUpdate(
      { ticketId: id },
      { $set: updateData },
      {
        new: true,
        runValidators: true,
      }
    );

    // 7. Kiểm tra ticket có tồn tại hay không
    if (!updatedTicket) {
      return NextResponse.json(
        {
          success: false,
          error: "Không tìm thấy ticket.",
        },
        { status: 404 }
      );
    }

    // 8. Trả dữ liệu mới nhất về frontend
    return NextResponse.json(
      {
        success: true,
        message: "Cập nhật ticket thành công.",
        data: updatedTicket,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error("PATCH /api/tickets/[id] error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Đã xảy ra lỗi máy chủ.";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
