// End to end against the fake API: order -> simulate -> signed webhook -> local store.
// The app's own webhook handler receives the fake API's deliveries over real HTTP.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createCbcClient } from "../lib/cbc-client.ts";
import { placeOrder } from "../lib/orders.ts";
import { computeSignature } from "../lib/signature.ts";
import { readStore } from "../lib/store.ts";
import { refreshChecks } from "../lib/sync.ts";
import { handleWebhookRequest } from "../lib/webhook.ts";
import { startFakeApi, type FakeApi } from "./fake-api.ts";

const SECRET = "whsec_e2e_secret";
let api: FakeApi;
let app: http.Server;
let appUrl: string;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cbc-e2e-"));
  process.env.CBC_STORE_PATH = path.join(dir, "store.json");
  api = await startFakeApi({ apiKey: "pk_test_e2e", webhookSecret: SECRET });

  // A plain HTTP server in front of the same handler the Next route uses.
  app = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks),
    });
    const response = await handleWebhookRequest(request, SECRET);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/cbc/webhooks`;
  api.settings.webhookUrl = appUrl;
});

after(async () => {
  await api.close();
  await new Promise<void>((r) => app.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const client = () => createCbcClient({ baseUrl: api.url, apiKey: "pk_test_e2e", retryDelayMs: 0 });
const input = {
  externalIdentifier: "vol-e2e-1",
  firstName: "Jordan",
  lastName: "Kim",
  email: "jordan.kim@example.com",
  level: 2,
  jobLocation: "Blue Springs, MO",
  stateOfEmployment: "MO",
};

test("order, duplicate on retry, simulate, webhook updates the store", async () => {
  const c = client();
  const first = await placeOrder(c, "org-1042", input);
  assert.equal(first.ok, true);
  const id = first.checkId!;

  // Retrying the same form (same externalIdentifier) shows the existing check.
  const retry = await placeOrder(c, "org-1042", input);
  assert.equal(retry.ok, true);
  assert.equal(retry.checkId, id);
  assert.match(retry.message, /already has a check/);
  assert.equal(api.checks.length, 1, "only one check exists");

  let store = await readStore();
  assert.equal(store.checks[id].status, "CREATED");
  assert.equal(store.checks[id].applicant?.lastName, "Kim");

  // Sandbox simulate -> the fake API sends a signed check.updated to our endpoint.
  await c.simulate(id, "CREATED", "applicant_ready");
  await api.flush();
  await c.simulate(id, "CLEAR");
  await api.flush();

  store = await readStore();
  assert.equal(store.checks[id].status, "CLEAR");
  assert.equal(store.checks[id].stage, "complete");
  assert.ok(store.checks[id].reportUrl);
  assert.equal(store.checks[id].applicant?.firstName, "Jordan", "local details kept");
  assert.equal(Object.keys(store.seenEvents).length, 2);
});

test("ping via webhook-test is verified and recorded", async () => {
  const res = await fetch(`${api.url}/settings/webhook-test`, { method: "POST", headers: { "X-Api-Key": "pk_test_e2e" } });
  assert.equal(res.status, 202);
  await api.flush();
  assert.ok((await readStore()).lastPingAt);
});

test("the endpoint answers 401 to a bad signature and 200 'duplicate' to a repeat", async () => {
  const body = JSON.stringify({ event: "ping", eventId: "dup-ping-1", timestamp: new Date().toISOString() });
  const post = (sig?: string) =>
    fetch(appUrl, { method: "POST", headers: { "Content-Type": "application/json", ...(sig ? { "X-Partner-Signature": sig } : {}) }, body });

  assert.equal((await post()).status, 401);
  assert.equal((await post(computeSignature(body, "whsec_wrong"))).status, 401);

  const ok = await post(computeSignature(body, SECRET));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result, "ping");
  const again = await post(computeSignature(body, SECRET));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).result, "duplicate");
});

test("PENDING (502) orders are stored and explained, not retried", async () => {
  const out = await placeOrder(client(), "org-1042", { ...input, externalIdentifier: "vol-e2e-2", email: "pending@example.com" });
  assert.equal(out.ok, true);
  assert.match(out.message, /PENDING/);
  assert.equal((await readStore()).checks[out.checkId!].status, "PENDING");
});

test("form validation catches a missing job location before calling the API", async () => {
  const before = api.requests.length;
  const out = await placeOrder(client(), "org-1042", { ...input, externalIdentifier: "vol-e2e-3", jobLocation: "" });
  assert.equal(out.ok, false);
  assert.ok(out.fieldErrors?.jobLocation);
  assert.equal(api.requests.length, before);
});

test("refresh from API pages through checks and sets lastSync", async () => {
  const result = await refreshChecks(client(), "org-1042");
  assert.equal(result.fetched, api.checks.length);
  const store = await readStore();
  assert.ok(store.lastSync);
  // The next refresh sends updated_since = lastSync.
  await refreshChecks(client(), "org-1042");
  const last = api.requests.filter((r) => r.path === "/clients/org-1042/checks" && r.method === "GET").at(-1)!;
  assert.equal(last.query.updated_since, store.lastSync);
});
