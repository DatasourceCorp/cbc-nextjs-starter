// Settings come from the environment only (.env.local in development).
// This module is imported by server code only: the API key never reaches the browser.

export const SANDBOX_BASE_URL = "https://dev.partners.cbgc.io";
export const PRODUCTION_BASE_URL = "https://partners.cbgc.io";

export interface CbcConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  /** Anything but the production URL counts as sandbox (also a local fake API). */
  isSandbox: boolean;
  /** A human warning when the key prefix doesn't match the environment, else null. */
  keyWarning: string | null;
}

export function getConfig(env: Record<string, string | undefined> = process.env): CbcConfig {
  const baseUrl = (env.CBC_BASE_URL?.trim() || SANDBOX_BASE_URL).replace(/\/+$/, "");
  const apiKey = env.CBC_API_KEY?.trim() ?? "";
  const webhookSecret = env.CBC_WEBHOOK_SECRET?.trim() ?? "";
  const isSandbox = baseUrl !== PRODUCTION_BASE_URL;

  let keyWarning: string | null = null;
  if (apiKey && baseUrl === SANDBOX_BASE_URL && !apiKey.startsWith("pk_test_")) {
    keyWarning = "CBC_BASE_URL is the sandbox, which only accepts pk_test_ keys.";
  } else if (apiKey && baseUrl === PRODUCTION_BASE_URL && !apiKey.startsWith("pk_live_")) {
    keyWarning = "CBC_BASE_URL is production, which only accepts pk_live_ keys.";
  }

  return {
    baseUrl,
    apiKey,
    webhookSecret,
    hasApiKey: apiKey.length > 0,
    hasWebhookSecret: webhookSecret.length > 0,
    isSandbox,
    keyWarning,
  };
}
