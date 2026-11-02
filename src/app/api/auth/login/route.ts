// Nhi
import { handleCredentials } from "../../../../lib/auth";

export async function POST(request: Request) {
  return handleCredentials(request, "login");
}
