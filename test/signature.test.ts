import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { computeSignature, verifySignature } from "../lib/signature.ts";

const secret = "whsec_test_4f9a1c2e";
const body = Buffer.from(
  '{"event":"check.updated","eventId":"e7a1c3b5-2d4f-4a6b-8c9d-0e1f2a3b4c5d","id":"chk_9c2e4f6a1b3d4e5f8a7b6c5d","status":"CLEAR","timestamp":"2026-10-18T18:22:42Z"}',
  "utf8",
);
// Computed independently: lowercase hex HMAC-SHA256 of the raw body, keyed with the WHOLE secret.
const good = createHmac("sha256", secret).update(body).digest("hex");

test("a valid signature passes", () => {
  assert.equal(computeSignature(body, secret), good);
  assert.match(good, /^[0-9a-f]{64}$/);
  assert.equal(verifySignature(body, good, secret), true);
});

test("a tampered body fails", () => {
  const tampered = Buffer.from(body.toString("utf8").replace("CLEAR", "REVIEW"), "utf8");
  assert.equal(verifySignature(tampered, good, secret), false);
});

test("whitespace changes to the body fail (the raw bytes are signed, not the parsed JSON)", () => {
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8")), null, 2), "utf8");
  assert.equal(verifySignature(reformatted, good, secret), false);
});

test("the wrong secret fails", () => {
  assert.equal(verifySignature(body, good, "whsec_other"), false);
  // Keyed with the whole secret, `whsec_` prefix included: the suffix alone is wrong.
  assert.equal(verifySignature(body, good, secret.slice("whsec_".length)), false);
});

test("a missing or empty header fails", () => {
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, null, secret), false);
  assert.equal(verifySignature(body, "", secret), false);
});

test("an uppercase or truncated signature fails", () => {
  assert.equal(verifySignature(body, good.toUpperCase(), secret), false);
  assert.equal(verifySignature(body, good.slice(0, 63), secret), false);
});

test("an empty secret never verifies", () => {
  assert.equal(verifySignature(body, createHmac("sha256", "").update(body).digest("hex"), ""), false);
});
