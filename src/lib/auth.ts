import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { io } from "next/cache";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import connectDB from "./mongodb";
import User from "../models/User";
import { AuthAttempt, AuthSession } from "../models/AuthSession";

const deriveKey = promisify(scrypt);
const COOKIE_NAME = "helpmate_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

export type AuthUser = { id: string; name: string; email: string; role: "admin" | "user" };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function publicUser(user: { _id: { toString(): string }; name: string; email: string; role?: string }): AuthUser {
  return { id: user._id.toString(), name: user.name, email: user.email, role: user.role === "admin" ? "admin" : "user" };
}

export function authError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      // Next.js can normalize request.url to an internal hostname. Host is the
      // browser-facing request authority; never accept an arbitrary forwarded host.
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const source = new URL(origin);
      if (!["http:", "https:"].includes(source.protocol) || source.host !== host || source.origin !== origin) {
        return authError("Nguồn gửi yêu cầu không hợp lệ.", 403);
      }
    } catch {
      return authError("Nguồn gửi yêu cầu không hợp lệ.", 403);
    }
  }
  return null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  // Session expiry needs a fresh clock value, including when Next.js validates
  // authenticated runtime prerenders with cookies already available.
  await io();
  await connectDB();
  const session = await AuthSession.findOne({
    tokenHash: digest(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await User.findById(session.userId);
  return user ? publicUser(user) : null;
}

export async function authorizeRequest(request?: Request) {
  if (request && request.method !== "GET" && request.method !== "HEAD") {
    const originError = checkOrigin(request);
    if (originError) return originError;
  }
  if (!(await getCurrentUser())) {
    return authError("Vui lòng đăng nhập để tiếp tục.", 401);
  }
  return null;
}

async function createSession(user: AuthUser, status = 200) {
  const token = randomBytes(32).toString("hex");
  await AuthSession.create({
    tokenHash: digest(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  const response = NextResponse.json({ success: true, user }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return response;
}

export async function handleCredentials(request: Request, mode: "login" | "register") {
  const originError = checkOrigin(request);
  if (originError) return originError;

  let body: Record<string, unknown>;
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return authError("Vui lòng gửi dữ liệu JSON.", 415);
    }
    const text = await request.text();
    if (text.length > 4096) return authError("Dữ liệu gửi lên quá dài.", 413);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return authError("Dữ liệu gửi lên không hợp lệ.", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return authError("Dữ liệu gửi lên không phải JSON hợp lệ.", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return authError("Vui lòng nhập địa chỉ email hợp lệ.", 400);
  }
  if (password.length < 8 || password.length > 128) {
    return authError("Mật khẩu cần từ 8 đến 128 ký tự.", 400);
  }
  if (mode === "register" && (name.length < 2 || name.length > 80)) {
    return authError("Họ tên cần từ 2 đến 80 ký tự.", 400);
  }
  if (mode === "register" && password !== body.confirmPassword) {
    return authError("Mật khẩu xác nhận không khớp.", 400);
  }

  try {
    await connectDB();
    await Promise.all([User.init(), AuthSession.init(), AuthAttempt.init()]);
    // Shared across server processes; TTL removes old counters automatically.
    const window = Math.floor(Date.now() / (15 * 60 * 1000));
    const attempts = await AuthAttempt.findOneAndUpdate(
      { _id: digest(`${mode}:${email}:${window}`) },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((window + 1) * 15 * 60 * 1000) },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (attempts.count > 20) {
      const response = authError("Bạn đã thử quá nhiều lần. Vui lòng thử lại sau 15 phút.", 429);
      response.headers.set("Retry-After", "900");
      return response;
    }

    if (mode === "register") {
      const salt = randomBytes(16).toString("hex");
      const key = (await deriveKey(password, salt, 64)) as Buffer;
      const user = await User.create({ name, email, role: "user", passwordHash: `${salt}:${key.toString("hex")}` });
      return await createSession(publicUser(user), 201);
    }

    const user = await User.findOne({ email }).select("+passwordHash");
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const normalizedHash = passwordHash.startsWith("scrypt$")
      ? passwordHash.slice(7).replace("$", ":")
      : passwordHash;
    const validHash = /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(normalizedHash);
    const [salt, storedKey] = (validHash ? normalizedHash : DUMMY_HASH).split(":");
    const key = (await deriveKey(password, salt, 64)) as Buffer;
    if (!timingSafeEqual(key, Buffer.from(storedKey, "hex")) || !user || !validHash) {
      return authError("Email hoặc mật khẩu không đúng.", 401);
    }
    return await createSession(publicUser(user));
  } catch (error) {
    if (mode === "register" && typeof error === "object" && error && "code" in error && error.code === 11000) {
      return authError("Email này đã được đăng ký. Vui lòng đăng nhập.", 409);
    }
    console.error("Authentication failed:", error instanceof Error ? error.name : "UnknownError");
    return authError("Chưa thể kết nối dịch vụ tài khoản. Vui lòng thử lại sau.", 503);
  }
}

export async function logout(request: Request) {
  const originError = checkOrigin(request);
  if (originError) return originError;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await connectDB();
    await AuthSession.deleteOne({ tokenHash: digest(token) });
  }
  const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0,
  });
  return response;
}
