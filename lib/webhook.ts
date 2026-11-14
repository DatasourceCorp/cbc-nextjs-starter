// The webhook endpoint's logic, framework-free (app/api/cbc/webhooks/route.ts calls it).

import { applyWebhookEvent } from "./checks-state.ts";
import { verifySignature } from "./signature.ts";
import { updateStore } from "./store.ts";

/** Bodies larger than this are refused; real events are a few hundred bytes. */
const MAX_BODY_BYTES = 256 * 1024;

export async function handleWebhookRequest(req: Request, secret: string): Promise<Response> {
  if (!secret) {
    console.error("[cbc] webhook refused: CBC_WEBHOOK_SECRET is not set");
    return new Response("Webhook secret not configured", { status: 503 });
  }

  // 1. The RAW body, exactly as sent. Never re-serialize parsed JSON to verify it.
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  // 2. Verify before parsing. A bad signature is 401 (it is retried, which is harmless).
  if (!verifySignature(raw, req.headers.get("x-partner-signature"), secret)) {
    console.warn("[cbc] webhook rejected: bad or missing X-Partner-Signature");
    return new Response(null, { status: 401 });
  }

  // 3. Parse, then apply: dedupe by eventId, latest timestamp per check id.
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response(null, { status: 400 });
  }
  // Local file work is milliseconds. If your processing is slow, store the event here and
  // process it from a queue: the API waits at most 15 seconds for a 2xx.
  const result = await updateStore((data) => applyWebhookEvent(data, event));

  const e = event as { event?: unknown; eventId?: unknown; id?: unknown };
  // Events carry ids and statuses only; still, log just these.
  console.info(`[cbc] webhook ${String(e.event)} ${String(e.eventId)}${e.id ? ` ${String(e.id)}` : ""} -> ${result}`);

  if (result === "invalid") return new Response(null, { status: 400 });
  return Response.json({ received: true, result });
}
