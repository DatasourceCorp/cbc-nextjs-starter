// A small, dependency-free client for the Christian Background Checks Partner API.
// Server-side only: it holds your API key.
//
// Docs: https://partners.cbgc.io/docs  (errors: https://partners.cbgc.io/docs/errors.md)
// Branch on the HTTP status, then `code`; never on `title` or `detail`.

import type {
  Check,
  CheckPage,
  Client,
  CreateClientRequest,
  CreateClientResponse,
  CreateOrderRequest,
  Problem,
  Product,
  Settings,
  SimulateStage,
  SimulateStatus,
} from "./types.ts";

export interface CbcClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Inject for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Retries for an order on a network error, 500 or 502 upstream_unavailable. Default 2. */
  orderRetries?: number;
  /** Base delay between those retries (doubles each time). Default 500 ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

/** A non-2xx answer from the API, as problem details. */
export class CbcApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(`CBC API ${status}${problem.code ? ` ${problem.code}` : ""}`);
    this.name = "CbcApiError";
    this.status = status;
    this.code = problem.code;
    this.problem = problem;
  }
}

/** Every documented outcome of POST /clients/{clientRef}/checks. */
export type OrderResult =
  /** 201: ordered; the applicant has been emailed. Billable. */
  | { kind: "created"; check: Check }
  /** 409 duplicate_check: the applicant already has a current check (in `check`). Nothing billed. */
  | { kind: "duplicate"; check: Check; currentStatus: string; message: string }
  /** 502 whose body is the check with status PENDING: answer lost, resolves on its own within about an hour. */
  | { kind: "pending"; check: Check }
  /** 502 whose body is the check with status ERROR: refused outright; nothing billed. */
  | { kind: "rejected"; check: Check }
  /** 400 validation_failed / invalid_json: fix the named fields. */
  | { kind: "invalid"; code: string; errors: Record<string, string[]> }
  /** 422 level_not_available: the church has no product for that level. */
  | { kind: "level_not_available"; detail: string }
  /** 409 external_identifier_in_use: that id belongs to another church's check. */
  | { kind: "external_identifier_in_use" }
  /** Anything else (401, 404, 429, 500 or 502 upstream_unavailable after retries, network). */
  | { kind: "failed"; status: number; code: string | undefined; detail: string | undefined; traceId?: string };

interface RawResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export function createCbcClient(options: CbcClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const orderRetries = options.orderRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function send(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined | null>,
  ): Promise<RawResponse> {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      "X-Api-Key": options.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { detail: "The API answered with a body that isn't JSON." };
      }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  async function json<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined | null>): Promise<T> {
    const res = await send(method, path, body, query);
    if (res.status >= 200 && res.status < 300) return res.body as T;
    throw new CbcApiError(res.status, asProblem(res.body, res.status));
  }

  const seg = encodeURIComponent; // URL-encode ids you put in a path.

  /** One page of GET /clients/{clientRef}/checks, ordered by updatedAt then id. */
  async function listChecks(
    clientRef: string,
    params: { updatedSince?: string | null; limit?: number; cursor?: string | null } = {},
  ): Promise<CheckPage> {
    const page = await json<CheckPage>("GET", `/clients/${seg(clientRef)}/checks`, undefined, {
      updated_since: params.updatedSince,
      limit: params.limit,
      cursor: params.cursor,
    });
    return { items: (page.items ?? []).map(normalizeCheck), nextCursor: page.nextCursor ?? null };
  }

  return {
    /** GET /status: 200 for any working key. */
    checkKey: () => json<unknown>("GET", "/status"),

    /** GET /clients (oldest first), or the 0-or-1 client with this externalClientId. */
    listClients: (externalClientId?: string) =>
      json<Client[]>("GET", "/clients", undefined, { externalClientId }),

    getClient: (clientRef: string) => json<Client>("GET", `/clients/${seg(clientRef)}`),

    /** POST /clients: creates the church and emails its primary contact a portal login. */
    createClient: (req: CreateClientRequest) => json<CreateClientResponse>("POST", "/clients", req),

    /** GET /products: every level 1 to 6 with its base price. Show `feesNote` next to prices. */
    listProducts: async () => (await json<Product[]>("GET", "/products")).map(normalizeProduct),

    /** GET /clients/{clientRef}/checks/{checkRef} */
    getCheck: async (clientRef: string, checkRef: string) =>
      normalizeCheck(await json<Check>("GET", `/clients/${seg(clientRef)}/checks/${seg(checkRef)}`)),

    /** One page of GET /clients/{clientRef}/checks, ordered by updatedAt then id. */
    listChecks,

    /**
     * Every check updated at or after `updatedSince` (all checks when null), following
     * `nextCursor` until it is null. A check can appear on two pages: upsert by `id`.
     */
    async *listAllChecks(clientRef: string, updatedSince: string | null, limit = 500): AsyncGenerator<Check> {
      let cursor: string | null = null;
      do {
        const page: CheckPage = await listChecks(clientRef, { updatedSince, limit, cursor });
        yield* page.items;
        cursor = page.nextCursor;
      } while (cursor);
    },

    /**
     * POST /clients/{clientRef}/checks. Billable once submitted.
     * Always pass your own `externalIdentifier`: this method retries transient failures with
     * the SAME body, and a retry with the same id never creates a second check.
     * It never sets `forceReorder`.
     */
    async orderCheck(clientRef: string, order: CreateOrderRequest): Promise<OrderResult> {
      const path = `/clients/${seg(clientRef)}/checks`;
      let last: OrderResult = { kind: "failed", status: 0, code: undefined, detail: "Not sent." };
      for (let attempt = 0; attempt <= orderRetries; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));
        let res: RawResponse;
        try {
          res = await send("POST", path, order);
        } catch (err) {
          // Network error or timeout: the order may or may not exist; retrying with the same
          // externalIdentifier is always safe (we'll get the check or 409 duplicate_check).
          last = { kind: "failed", status: 0, code: "network_error", detail: (err as Error).message };
          continue;
        }
        const result = interpretOrderResponse(res);
        last = result;
        const retryable =
          result.kind === "failed" &&
          (result.status === 500 || (result.status === 502 && result.code === "upstream_unavailable"));
        if (!retryable) return result;
      }
      return last;
    },

    /** POST /test/checks/{checkRef}/simulate. Sandbox only (404 in production). */
    simulate: async (checkRef: string, status: SimulateStatus, stage?: SimulateStage) =>
      normalizeCheck(
        await json<Check>("POST", `/test/checks/${seg(checkRef)}/simulate`, stage ? { status, stage } : { status }),
      ),

    getSettings: () => json<Settings>("GET", "/settings"),

    /** PUT /settings replaces both URL values: always send the full set. */
    updateSettings: (settings: { webhookUrl: string | null; connectReturnUrls: string[] }) =>
      json<Settings>("PUT", "/settings", settings),

    /** POST /settings/webhook-test: queues a signed `ping` to your webhook URL. */
    sendTestWebhook: () => json<{ status: string }>("POST", "/settings/webhook-test"),
  };
}

export type CbcClient = ReturnType<typeof createCbcClient>;

/** Maps an order response to an OrderResult, exactly as the error catalog describes. */
export function interpretOrderResponse(res: { status: number; body: unknown }): OrderResult {
  const body = (res.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : undefined;

  if (res.status === 201 || res.status === 200) return { kind: "created", check: normalizeCheck(body as unknown as Check) };

  if (res.status === 409 && code === "duplicate_check") {
    // Not problem details: { code, message, currentStatus, instructions, order }.
    return {
      kind: "duplicate",
      check: normalizeCheck(body.order as Check),
      currentStatus: String(body.currentStatus ?? ""),
      message: String(body.message ?? ""),
    };
  }
  if (res.status === 409 && code === "external_identifier_in_use") return { kind: "external_identifier_in_use" };

  if (res.status === 502 && !code && typeof body.id === "string") {
    // The body is the check itself (no `code`).
    const check = normalizeCheck(body as unknown as Check);
    return check.status === "ERROR" ? { kind: "rejected", check } : { kind: "pending", check };
  }

  if (res.status === 400 && (code === "validation_failed" || code === "invalid_json")) {
    return { kind: "invalid", code, errors: (body.errors as Record<string, string[]>) ?? {} };
  }
  if (res.status === 422 && code === "level_not_available") {
    return { kind: "level_not_available", detail: String(body.detail ?? "") };
  }

  const problem = asProblem(body, res.status);
  return { kind: "failed", status: res.status, code: problem.code, detail: problem.detail, traceId: problem.traceId };
}

function asProblem(body: unknown, status: number): Problem {
  if (body && typeof body === "object") return body as Problem;
  return { status, code: "request_failed" };
}

/** `level` and money can arrive as numbers or numeric strings (see the OpenAPI schema). */
export function normalizeCheck(check: Check): Check {
  return {
    ...check,
    level: check.level === null || check.level === undefined ? null : Number(check.level),
    charges: check.charges === null || check.charges === undefined ? (check.charges ?? null) : Number(check.charges),
  };
}

function normalizeProduct(p: Product): Product {
  return { ...p, level: Number(p.level), price: p.price === null ? null : Number(p.price) };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
