// Nhi
import { authError, logout } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    return await logout(request);
  } catch {
    return authError("Chưa thể đăng xuất. Vui lòng thử lại sau.", 503);
  }
}
