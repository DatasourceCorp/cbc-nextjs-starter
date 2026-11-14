import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createCbcClient } from "../lib/cbc-client.ts";
import { startFakeApi, type FakeApi } from "./fake-api.ts";

let api: FakeApi;
const order = (externalIdentifier: string, email: string, level = 2) => ({
  externalIdentifier,
  firstName: "Jordan",
  lastName: "Kim",
  applicantEmail: email,
  level,
  jobLocation: "Blue Springs, MO",
  stateOfEmployment: "MO",
});

before(async () => {
  api = await startFakeApi({ apiKey: "pk_test_abc" });
});
after(() => api.close());

const client = () => createCbcClient({ baseUrl: api.url + "/", apiKey: "pk_test_abc", retryDelayMs: 0 });

test("orders send X-Api-Key, JSON and the documented body to an encoded path", async () => {
  const result = await client().orderCheck("org-1042", order("vol-shape-1", "shape@example.com"));
  assert.equal(result.kind, "created");

  const req = api.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/clients/org-1042/checks");
  assert.equal(req.headers["x-api-key"], "pk_test_abc");
  assert.match(String(req.headers["content-type"]), /^application\/json/);
  assert.deepEqual(req.body, order("vol-shape-1", "shape@example.com"));
  assert.equal("forceReorder" in (req.body as object), false, "never sends forceReorder");
});

test("path segments are URL-encoded", async () => {
  await client().listChecks("org/with space").catch(() => undefined);
  assert.equal(api.requests.at(-1)!.path, "/clients/org%2Fwith%20space/checks");
});

test("409 duplicate_check returns the existing check from `order`", async () => {
  const first = await client().orderCheck("org-1042", order("vol-dup-1", "dup@example.com"));
  assert.equal(first.kind, "created");
  const again = await client().orderCheck("org-1042", order("vol-dup-1", "dup@example.com"));
  assert.equal(again.kind, "duplicate");
  if (again.kind === "duplicate" && first.kind === "created") {
    assert.equal(again.check.id, first.check.id);
    assert.equal(again.currentStatus, "CREATED");
  }
});

test("502 with a PENDING check body is 'pending', not an error, and is not retried", async () => {
  const before = api.requests.length;
  const result = await client().orderCheck("org-1042", order("vol-pending-1", "pending@example.com"));
  assert.equal(result.kind, "pending");
  if (result.kind === "pending") assert.equal(result.check.status, "PENDING");
  assert.equal(api.requests.length - before, 1);
});

test("502 upstream_unavailable is retried with the SAME externalIdentifier", async () => {
  const before = api.requests.length;
  const result = await client().orderCheck("org-1042", order("vol-flaky-1", "flaky@example.com"));
  assert.equal(result.kind, "created");
  const sent = api.requests.slice(before);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((r) => (r.body as { externalIdentifier: string }).externalIdentifier),
    ["vol-flaky-1", "vol-flaky-1"],
  );
});

test("400 validation_failed returns the field errors", async () => {
  const result = await client().orderCheck("org-1042", { ...order("vol-bad-1", ""), firstName: "" });
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") {
    assert.ok(result.errors.firstName);
    assert.ok(result.errors.applicantEmail);
  }
});

test("422 level_not_available", async () => {
  const result = await client().orderCheck("org-1042", order("vol-l4-1", "l4@example.com", 4));
  assert.equal(result.kind, "level_not_available");
});

test("401 invalid_api_key is a failure, not retried", async () => {
  const before = api.requests.length;
  const bad = createCbcClient({ baseUrl: api.url, apiKey: "pk_test_wrong", retryDelayMs: 0 });
  const result = await bad.orderCheck("org-1042", order("vol-401", "x@example.com"));
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.code, "invalid_api_key");
  assert.equal(api.requests.length - before, 1);
});

test("listing follows nextCursor with updated_since and limit", async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c.orderCheck("org-1042", order(`vol-page-${i}`, `page${i}@example.com`));
  const before = api.requests.length;
  const since = "2000-01-01T00:00:00Z";
  const ids: string[] = [];
  for await (const check of c.listAllChecks("org-1042", since, 2)) ids.push(check.id);

  const pages = api.requests.slice(before);
  assert.ok(pages.length >= 3, "several pages fetched");
  assert.equal(pages[0].query.updated_since, since);
  assert.equal(pages[0].query.limit, "2");
  assert.equal(pages[0].query.cursor, undefined);
  assert.ok(pages[1].query.cursor, "second page sends cursor");
  assert.equal(new Set(ids).size, api.checks.length);
});

test("GET /products normalizes levels and keeps feesNote", async () => {
  const products = await client().listProducts();
  assert.equal(products.length, 6);
  assert.equal(products[0].feesNote, "Plus pass-through fees.");
  assert.equal(api.requests.at(-1)!.path, "/products");
});

test("simulate posts the status (and stage) to /test/checks/{checkRef}/simulate", async () => {
  const c = client();
  await c.orderCheck("org-1042", order("vol-sim-1", "sim@example.com"));
  const check = await c.simulate("vol-sim-1", "CREATED", "applicant_ready");
  assert.equal(check.stage, "applicant_ready");
  const req = api.requests.at(-1)!;
  assert.equal(req.path, "/test/checks/vol-sim-1/simulate");
  assert.deepEqual(req.body, { status: "CREATED", stage: "applicant_ready" });
});
