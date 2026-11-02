// Nhi
import { NextResponse } from "next/server";
import { authError, getCurrentUser } from "../../../../lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return user
      ? NextResponse.json({ success: true, user }, { headers: { "Cache-Control": "no-store" } })
      : authError("Vui lòng đăng nhập để tiếp tục.", 401);
  } catch {
    return authError("Chưa thể kiểm tra phiên đăng nhập. Vui lòng thử lại sau.", 503);
  }
}
