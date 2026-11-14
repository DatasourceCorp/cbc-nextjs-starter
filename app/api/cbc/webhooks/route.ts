// POST /api/cbc/webhooks: register https://YOUR-HOST/api/cbc/webhooks with PUT /settings.
// Signed by the API, so it needs no CSRF token; the signature is checked over the raw body.

import { getConfig } from "../../../../lib/config.ts";
import { handleWebhookRequest } from "../../../../lib/webhook.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleWebhookRequest(req, getConfig().webhookSecret);
}
