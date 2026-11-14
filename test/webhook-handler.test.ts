import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWebhookEvent, emptyStore, parseUtc, upsertCheckFromApi } from "../lib/checks-state.ts";

const NOW = new Date("2026-10-18T18:30:00Z");

function updated(eventId: string, timestamp: string, status: string, stage: string) {
  return {
    event: "check.updated",
    eventId,
    timestamp,
    id: "chk_9c2e4f6a1b3d4e5f8a7b6c5d",
    externalIdentifier: "vol-8841",
    clientId: "cl_5b0e6f2a8c1d4e7b9a3f2d6c",
    status,
    stage,
    level: 2,
    expirationDate: null,
    completedAt: null,
  };
}

test("a repeated eventId is dropped", () => {
  const state = emptyStore();
  const e = updated("e-1", "2026-10-18T18:00:00Z", "CREATED", "in_progress");
  assert.equal(applyWebhookEvent(state, e, NOW), "applied");
  assert.equal(applyWebhookEvent(state, { ...e, status: "ERROR" }, NOW), "duplicate");
  assert.equal(state.checks[e.id].status, "CREATED");
});

test("out-of-order delivery keeps the latest timestamp per check id", () => {
  const state = emptyStore();
  const newer = updated("e-2", "2026-10-18T18:22:42Z", "CLEAR", "complete");
  const older = updated("e-1", "2026-10-18T18:00:00Z", "CREATED", "in_progress");

  assert.equal(applyWebhookEvent(state, newer, NOW), "applied");
  assert.equal(applyWebhookEvent(state, older, NOW), "older");
  assert.equal(state.checks[newer.id].status, "CLEAR");
  assert.equal(state.checks[newer.id].stage, "complete");
  assert.equal(state.checks[newer.id].lastChangeAt, "2026-10-18T18:22:42Z");
  // The older event was still recorded, so its retry is a duplicate.
  assert.equal(applyWebhookEvent(state, older, NOW), "duplicate");
});

test("in-order delivery applies each change", () => {
  const state = emptyStore();
  applyWebhookEvent(state, updated("e-1", "2026-10-18T18:00:00Z", "CREATED", "awaiting_applicant"), NOW);
  applyWebhookEvent(state, updated("e-2", "2026-10-18T18:10:00Z", "CREATED", "applicant_ready"), NOW);
  assert.equal(state.checks["chk_9c2e4f6a1b3d4e5f8a7b6c5d"].stage, "applicant_ready");
});

test("a webhook older than data from the API does not overwrite it", () => {
  const state = emptyStore();
  upsertCheckFromApi(state, {
    id: "chk_9c2e4f6a1b3d4e5f8a7b6c5d",
    externalIdentifier: "vol-8841",
    clientId: "cl_5b0e6f2a8c1d4e7b9a3f2d6c",
    status: "CLEAR",
    stage: "complete",
    level: 2,
    expirationDate: "2028-10-18T18:22:41Z",
    completedAt: "2026-10-18T18:22:41Z",
    updatedAt: "2026-10-18T18:22:41Z",
  });
  assert.equal(applyWebhookEvent(state, updated("e-1", "2026-10-18T18:00:00Z", "CREATED", "in_progress"), NOW), "older");
  assert.equal(state.checks["chk_9c2e4f6a1b3d4e5f8a7b6c5d"].status, "CLEAR");
});

test("local applicant details survive webhook updates", () => {
  const state = emptyStore();
  upsertCheckFromApi(
    state,
    {
      id: "chk_9c2e4f6a1b3d4e5f8a7b6c5d",
      externalIdentifier: "vol-8841",
      clientId: "cl_5b0e6f2a8c1d4e7b9a3f2d6c",
      status: "CREATED",
      stage: "awaiting_applicant",
      level: 2,
      expirationDate: null,
      completedAt: null,
      updatedAt: "2026-10-18T17:00:00Z",
    },
    { applicant: { firstName: "Jordan", lastName: "Kim", email: "jordan.kim@example.com" } },
  );
  applyWebhookEvent(state, updated("e-9", "2026-10-18T18:22:42Z", "CLEAR", "complete"), NOW);
  assert.equal(state.checks["chk_9c2e4f6a1b3d4e5f8a7b6c5d"].applicant?.firstName, "Jordan");
  assert.equal(state.checks["chk_9c2e4f6a1b3d4e5f8a7b6c5d"].status, "CLEAR");
});

test("check.expiring is noted without changing the status", () => {
  const state = emptyStore();
  applyWebhookEvent(state, updated("e-1", "2026-10-18T18:22:42Z", "CLEAR", "complete"), NOW);
  const result = applyWebhookEvent(
    state,
    {
      event: "check.expiring",
      eventId: "x-1",
      timestamp: "2026-10-18T18:25:00Z",
      id: "chk_9c2e4f6a1b3d4e5f8a7b6c5d",
      externalIdentifier: "vol-8841",
      clientId: "cl_5b0e6f2a8c1d4e7b9a3f2d6c",
      status: "CLEAR",
      expirationDate: "2026-11-17T18:22:41Z",
      daysLeft: 30,
    },
    NOW,
  );
  assert.equal(result, "noted");
  const check = state.checks["chk_9c2e4f6a1b3d4e5f8a7b6c5d"];
  assert.equal(check.status, "CLEAR");
  assert.equal(check.expiring?.daysLeft, 30);
});

test("ping is recorded; unknown events are ignored", () => {
  const state = emptyStore();
  assert.equal(applyWebhookEvent(state, { event: "ping", eventId: "p-1", timestamp: "2026-10-18T18:00:00Z" }, NOW), "ping");
  assert.equal(state.lastPingAt, "2026-10-18T18:00:00Z");
  assert.equal(applyWebhookEvent(state, { event: "something.new", eventId: "n-1", timestamp: "2026-10-18T18:00:00Z" }, NOW), "ignored");
  assert.equal(applyWebhookEvent(state, { event: "batch.completed", eventId: "b-1", timestamp: "2026-10-18T18:00:00Z" }, NOW), "ignored");
});

test("events more than a day old are refused (replay protection)", () => {
  const state = emptyStore();
  assert.equal(applyWebhookEvent(state, updated("old-1", "2026-10-16T18:00:00Z", "CLEAR", "complete"), NOW), "stale");
  assert.equal(Object.keys(state.checks).length, 0);
});

test("events without eventId or timestamp are invalid", () => {
  const state = emptyStore();
  assert.equal(applyWebhookEvent(state, { event: "ping" }, NOW), "invalid");
  assert.equal(applyWebhookEvent(state, null, NOW), "invalid");
});

test("timestamps without a zone designator are read as UTC, not local time", () => {
  const utc = Date.UTC(2026, 10, 14, 19, 57, 44, 337);
  assert.equal(parseUtc("2026-11-14T19:57:44.337504"), utc);
  assert.equal(parseUtc("2026-11-14T19:57:44.337504Z"), utc);
  assert.equal(parseUtc("2026-11-14T14:57:44.337504-05:00"), utc);
});
