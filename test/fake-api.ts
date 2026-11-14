// A tiny in-memory stand-in for the Partner API, for tests and offline development.
// It mimics the documented shapes and status codes; it is NOT the real API.
// Run it alone with `npm run fake-api` (port 4010, key pk_test_fake, secret whsec_fake),
// then start the app with CBC_BASE_URL=http://localhost:4010.
//
// Magic applicant emails:
//   pending@...  -> 502 with the PENDING check as the body (answer lost)
//   flaky@...    -> first attempt 502 upstream_unavailable, then 201
//   level 4      -> 422 level_not_available

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface FakeCheck {
  id: string;
  externalIdentifier: string | null;
  clientId: string;
  status: string;
  stage: string;
  level: number | null;
  expirationDate: string | null;
  completedAt: string | null;
  reportUrl: string | null;
  charges: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  email: string;
}

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  checks: FakeCheck[];
  settings: { webhookUrl: string | null; connectReturnUrls: string[] };
  /** Waits for webhooks the fake has sent. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

const id = (prefix: string) => prefix + randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { type: `https://partners.cbgc.io/docs/errors.md#${code}`, title: code, status, code, ...extra },
});

export async function startFakeApi(opts: { apiKey?: string; webhookSecret?: string; port?: number } = {}): Promise<FakeApi> {
  const apiKey = opts.apiKey ?? "pk_test_fake";
  const secret = opts.webhookSecret ?? "whsec_fake";
  const requests: RecordedRequest[] = [];
  const checks: FakeCheck[] = [];
  const clients = [
    {
      clientId: "cl_000000000000000000000001",
      externalClientId: "org-1042",
      name: "Grace Community Church",
      status: "Active",
      createdAt: "2026-10-16T15:04:05Z",
      portalUrl: "https://portal.example.com",
    },
  ];
  const settings = { webhookUrl: null as string | null, connectReturnUrls: [] as string[], checkValidityYears: 2 };
  const pending: Promise<unknown>[] = [];
  const flaky = new Set<string>();

  const publicCheck = (c: FakeCheck) => {
    const { email: _email, ...rest } = c;
    return rest;
  };

  function deliver(payload: Record<string, unknown>) {
    if (!settings.webhookUrl) return;
    const body = JSON.stringify({ eventId: randomUUID(), timestamp: now(), ...payload });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    pending.push(
      fetch(settings.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Partner-Signature": signature },
        body,
      }).catch(() => undefined),
    );
  }

  const findClient = (ref: string) => clients.find((c) => c.clientId === ref || c.externalClientId === ref);
  const findCheck = (ref: string) => checks.find((c) => c.id === ref || c.externalIdentifier === ref);

  function route(method: string, path: string, query: Record<string, string>, body: any): { status: number; body?: unknown } {
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/status") return { status: 200, body: { status: "ok" } };

    if (method === "GET" && path === "/clients") {
      return { status: 200, body: query.externalClientId ? clients.filter((c) => c.externalClientId === query.externalClientId) : clients };
    }
    if (method === "POST" && path === "/clients") {
      const required = ["legalCompanyName", "primaryContactFirstName", "primaryContactLastName", "primaryContactEmail", "primaryContactPhone", "streetLine1", "city", "state", "postalCode"];
      const errors = Object.fromEntries(required.filter((f) => !body?.[f]).map((f) => [f, [`${f} is required.`]]));
      if (Object.keys(errors).length) return problem(400, "validation_failed", { errors });
      if (body.externalClientId && findClient(body.externalClientId)) return problem(409, "external_client_id_in_use");
      const client = {
        clientId: id("cl_"),
        externalClientId: body.externalClientId ?? null,
        name: body.legalCompanyName,
        status: "Active",
        createdAt: now(),
        portalUrl: "https://portal.example.com",
      };
      clients.push(client);
      return { status: 201, body: { ...client, primaryUsername: body.primaryContactEmail, welcomeEmailSent: true } };
    }
    if (method === "GET" && (m = path.match(/^\/clients\/([^/]+)$/))) {
      const client = findClient(decodeURIComponent(m[1]));
      return client ? { status: 200, body: client } : problem(404, "client_not_found");
    }

    if (method === "GET" && path === "/products") {
      return {
        status: 200,
        body: [1, 2, 3, 4, 5, 6].map((level) => ({
          level,
          name: `Level ${level}`,
          description: `Fake level ${level}.`,
          price: level === 6 ? null : 10 + level * 5,
          feesNote: "Plus pass-through fees.",
        })),
      };
    }

    if ((m = path.match(/^\/clients\/([^/]+)\/checks$/))) {
      const client = findClient(decodeURIComponent(m[1]));
      if (!client) return problem(404, "client_not_found");

      if (method === "POST") {
        const errors: Record<string, string[]> = {};
        for (const f of ["firstName", "lastName", "applicantEmail"]) if (!body?.[f]) errors[f] = [`${f} is required.`];
        if (!body?.level) errors.level = ["level is required."];
        if (!!body?.jobLocation !== !!body?.stateOfEmployment) errors.jobLocation = ["Send jobLocation and stateOfEmployment together."];
        if (Object.keys(errors).length) return problem(400, "validation_failed", { errors });
        if (Number(body.level) === 4) return problem(422, "level_not_available", { detail: "This client has no product for level 4. Contact support." });

        const email = String(body.applicantEmail).toLowerCase();
        if (email.startsWith("flaky@") && !flaky.has(body.externalIdentifier)) {
          flaky.add(body.externalIdentifier);
          return problem(502, "upstream_unavailable");
        }
        const byRef = body.externalIdentifier ? checks.find((c) => c.externalIdentifier === body.externalIdentifier) : undefined;
        if (byRef && byRef.clientId !== client.clientId) return problem(409, "external_identifier_in_use");
        const existing = byRef ?? checks.find((c) => c.clientId === client.clientId && c.email === email);
        if (existing && ["QUEUED", "PENDING", "CREATED", "CLEAR", "REVIEW"].includes(existing.status) && !body.forceReorder) {
          return {
            status: 409,
            body: {
              code: "duplicate_check",
              message: `A background check is currently in progress with status '${existing.status}'.`,
              currentStatus: existing.status,
              instructions: "To force a re-order, submit the request with 'forceReorder': true.",
              order: publicCheck(existing),
            },
          };
        }
        const t = now();
        const check: FakeCheck = {
          id: id("chk_"),
          externalIdentifier: body.externalIdentifier ?? null,
          clientId: client.clientId,
          status: "CREATED",
          stage: "awaiting_applicant",
          level: Number(body.level),
          expirationDate: null,
          completedAt: null,
          reportUrl: null,
          charges: null,
          errorCode: null,
          errorMessage: null,
          createdAt: t,
          updatedAt: t,
          email,
        };
        if (email.startsWith("pending@")) {
          check.status = "PENDING";
          check.stage = "submitting";
          checks.push(check);
          return { status: 502, body: publicCheck(check) };
        }
        checks.push(check);
        return { status: 201, body: publicCheck(check) };
      }

      if (method === "GET") {
        const since = query.updated_since ? Date.parse(query.updated_since) : -Infinity;
        const limit = Math.min(Number(query.limit ?? 100), 500);
        const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString()) : 0;
        if (Number.isNaN(offset)) return problem(400, "invalid_cursor", { errors: { cursor: ["Unknown cursor."] } });
        const all = checks
          .filter((c) => c.clientId === client.clientId && Date.parse(c.updatedAt) >= since)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
        const items = all.slice(offset, offset + limit).map(publicCheck);
        const next = offset + limit < all.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
        return { status: 200, body: { items, nextCursor: next } };
      }
    }

    if (method === "POST" && (m = path.match(/^\/test\/checks\/([^/]+)\/simulate$/))) {
      const check = findCheck(decodeURIComponent(m[1]));
      if (!check) return problem(404, "check_not_found");
      const status = body?.status;
      if (!["CREATED", "CLEAR", "REVIEW", "ERROR", "CANCELLED"].includes(status)) {
        return problem(400, "validation_failed", { errors: { status: ["status must be one of CREATED, CLEAR, REVIEW, ERROR, CANCELLED."] } });
      }
      const t = now();
      check.status = status;
      check.stage =
        status === "CREATED" ? body.stage ?? "awaiting_applicant" : status === "CLEAR" || status === "REVIEW" ? "complete" : "closed";
      const final = !["CREATED"].includes(status);
      check.completedAt = final ? t : null;
      check.expirationDate = status === "CLEAR" || status === "REVIEW" ? new Date(Date.now() + 2 * 365 * 864e5).toISOString() : null;
      check.reportUrl = status === "CLEAR" || status === "REVIEW" ? "https://portal.example.com/report" : null;
      check.charges = final ? 0 : null;
      check.errorCode = status === "ERROR" ? "simulated" : null;
      check.errorMessage = status === "ERROR" ? "Simulated error." : null;
      check.updatedAt = t;
      const { createdAt: _c, updatedAt: _u, ...fields } = publicCheck(check);
      deliver({ event: "check.updated", ...fields });
      return { status: 200, body: publicCheck(check) };
    }

    if (path === "/settings" && method === "GET") return { status: 200, body: settings };
    if (path === "/settings" && method === "PUT") {
      settings.webhookUrl = body?.webhookUrl || null;
      settings.connectReturnUrls = body?.connectReturnUrls ?? [];
      return { status: 200, body: settings };
    }
    if (path === "/settings/webhook-test" && method === "POST") {
      if (!settings.webhookUrl) return problem(400, "validation_failed", { errors: { webhookUrl: ["No webhook URL is registered."] } });
      deliver({ event: "ping" });
      return { status: 202, body: { status: "QUEUED" } };
    }

    return problem(404, "not_found");
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = Symbol.for("invalid");
        }
      }
      const query = Object.fromEntries(url.searchParams);
      requests.push({ method: req.method ?? "GET", path: url.pathname, query, headers: req.headers, body });

      let out: { status: number; body?: unknown };
      if (req.headers["x-api-key"] !== apiKey) out = problem(401, "invalid_api_key");
      else if (typeof body === "symbol") out = problem(400, "invalid_json");
      else out = route(req.method ?? "GET", url.pathname, query, body);

      const isProblem = out.status >= 400 && !(out.status === 409 && (out.body as any)?.code === "duplicate_check") && !(out.status === 502 && !(out.body as any)?.code);
      res.writeHead(out.status, { "Content-Type": isProblem ? "application/problem+json" : "application/json" });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    checks,
    settings,
    async flush() {
      while (pending.length) await pending.shift();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = await startFakeApi({ port: Number(process.env.PORT ?? 4010) });
  console.log(`Fake Partner API on ${api.url} (X-Api-Key: pk_test_fake, webhook secret: whsec_fake)`);
  console.log("Register your local webhook: PUT /settings with webhookUrl http://localhost:3000/api/cbc/webhooks");
}
