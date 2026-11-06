import { NextResponse } from 'next/server';
import { isMongoConnectionError } from './mongodb';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function errorResponse(error: unknown) {
  const known = error instanceof ApiError;
  const databaseUnavailable = isMongoConnectionError(error);
  const status = known ? error.status : databaseUnavailable ? 503 : 500;
  const message = known ? error.message : databaseUnavailable
    ? 'Không thể kết nối cơ sở dữ liệu. Hãy kiểm tra MongoDB Atlas và kết nối mạng.'
    : 'Không thể xử lý yêu cầu. Hãy thử lại sau.';
  if (status >= 500) console.error('Backend request failed:', known ? error.code : error instanceof Error ? error.name : 'UnknownError');
  const response = json({ success: false, error: message }, status);
  if (status === 429) response.headers.set('Retry-After', '2');
  return response;
}

export async function readJsonObject(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new ApiError(415, 'Yêu cầu phải dùng Content-Type application/json.');
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new ApiError(413, 'Dữ liệu gửi lên quá lớn.');
  if (!request.body) throw new ApiError(400, 'Dữ liệu JSON không hợp lệ.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'Dữ liệu gửi lên quá lớn.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Dữ liệu phải là một JSON object.');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (request.signal.aborted) throw new ApiError(499, 'Yêu cầu đã được hủy.');
    throw new ApiError(400, 'Dữ liệu JSON không hợp lệ.');
  } finally { reader.releaseLock(); }
}

export function requiredText(body: Record<string, unknown>, key: string, maxLength: number) {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new ApiError(400, `${key} phải là chuỗi có nội dung, tối đa ${maxLength} ký tự.`);
  return value.trim();
}

export function envInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
