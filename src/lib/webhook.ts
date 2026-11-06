import { ApiError, envInteger } from './http';

export async function deliverTicketWebhook(payload: Record<string, unknown>) {
  const configured = process.env.N8N_WEBHOOK_URL?.trim();
  if (!configured) return;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid webhook protocol');
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(envInteger('N8N_WEBHOOK_TIMEOUT_MS', 10000, 1000, 120000)), cache: 'no-store',
    });
    await response.body?.cancel();
    if (!response.ok) throw new ApiError(502, 'n8n rejected webhook', 'N8N_HTTP_' + response.status);
  } catch (error) {
    console.error('Ticket webhook delivery failed:', error instanceof ApiError ? error.code : error instanceof Error ? error.name : 'UnknownError');
  }
}
