// Builds the API client from the environment. Server-side only.

import { createCbcClient, type CbcClient } from "./cbc-client.ts";
import { getConfig } from "./config.ts";

/** The configured client, or null when CBC_API_KEY isn't set. */
export function getCbcClient(): CbcClient | null {
  const config = getConfig();
  if (!config.hasApiKey) return null;
  return createCbcClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
