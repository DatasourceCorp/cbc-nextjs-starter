// Pure state logic shared by the webhook endpoint, ordering and "refresh from API".
// No I/O here, so it is easy to test and easy to move onto your own database.

import type { Check } from "./types.ts";

export interface Church {
  clientId: string;
  externalClientId: string | null;
  name: string | null;
  portalUrl: string | null;
  connectedAt: string;
}

/** What we know about the person, kept in YOUR database only. Never log it. */
export interface Applicant {
  firstName: string;
  lastName: string;
  email: string;
}

export interface StoredCheck extends Check {
  applicant?: Applicant;
  jobLocation?: string;
  stateOfEmployment?: string;
  /** Newest change applied: a webhook `timestamp` or an API `updatedAt`. Older data is ignored. */
  lastChangeAt: string;
  /** Set by the `check.expiring` webhook. */
  expiring?: { daysLeft: number; expirationDate: string; notifiedAt: string };
}

export interface StoreData {
  church: Church | null;
  /** Keyed by the check's `id` (`chk_...`), the reliable key for a check. */
  checks: Record<string, StoredCheck>;
  /** eventId -> when we first processed it. Webhooks are delivered at least once. */
  seenEvents: Record<string, string>;
  /** Start time of the last successful "refresh from API" (used as updated_since). */
  lastSync: string | null;
  lastPingAt: string | null;
}

export function emptyStore(): StoreData {
  return { church: null, checks: {}, seenEvents: {}, lastSync: null, lastPingAt: null };
}

/**
 * The API's timestamps are UTC. Date.parse reads a date-time without a zone designator as local time, so a missing "Z"
 * would shift it by hours; such a value is read as UTC instead.
 */
export function parseUtc(iso: string): number {
  return Date.parse(/T.*([zZ]|[+-]\d{2}:?\d{2})$/.test(iso) || !iso.includes("T") ? iso : iso + "Z");
}

const time = (iso: string | null | undefined) => {
  const t = iso ? parseUtc(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Upserts a check from an API response (order, refresh, simulate), keeping the newer
 * `updatedAt`. `extra` adds what only we know (who the applicant is).
 */
export function upsertCheckFromApi(
  state: StoreData,
  check: Check,
  extra: Partial<Pick<StoredCheck, "applicant" | "jobLocation" | "stateOfEmployment">> = {},
): "applied" | "older" {
  const existing = state.checks[check.id];
  const changeAt = check.updatedAt ?? new Date().toISOString();
  const merged: StoredCheck = { ...(existing ?? {}), ...stripUndefined(extra) } as StoredCheck;

  if (existing && time(changeAt) < time(existing.lastChangeAt)) {
    // Older than what we have: keep the state, but still attach local-only details.
    state.checks[check.id] = merged;
    return "older";
  }
  state.checks[check.id] = { ...merged, ...check, lastChangeAt: changeAt };
  return "applied";
}

// ---- Webhooks --------------------------------------------------------------

export type WebhookResult = "applied" | "older" | "duplicate" | "stale" | "ping" | "noted" | "ignored" | "invalid";

/** Events older than this are refused (replay protection; the signature covers only the body). */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
/** How long eventIds are remembered. Retries arrive within minutes; replays get a new eventId. */
export const SEEN_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Fields of `check.updated` that describe the check (everything but event, eventId, timestamp). */
const CHECK_FIELDS = [
  "externalIdentifier",
  "clientId",
  "status",
  "stage",
  "level",
  "expirationDate",
  "completedAt",
  "reportUrl",
  "charges",
  "errorCode",
  "errorMessage",
] as const;

/**
 * Applies one VERIFIED webhook event to the state. Call it only after the signature check.
 *  - drops repeats by `eventId` (delivery is at least once)
 *  - per check `id`, keeps the state with the latest `timestamp` (delivery is not ordered)
 *  - handles `check.updated`, `check.expiring` and `ping`; ignores unknown events
 */
export function applyWebhookEvent(state: StoreData, event: unknown, now: Date = new Date()): WebhookResult {
  if (!event || typeof event !== "object") return "invalid";
  const e = event as Record<string, unknown>;
  const eventId = typeof e.eventId === "string" ? e.eventId : "";
  const type = typeof e.event === "string" ? e.event : "";
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";
  if (!eventId || !type || Number.isNaN(parseUtc(timestamp))) return "invalid";

  pruneSeenEvents(state, now);
  if (state.seenEvents[eventId]) return "duplicate";
  if (now.getTime() - parseUtc(timestamp) > MAX_EVENT_AGE_MS) return "stale";
  state.seenEvents[eventId] = now.toISOString();

  switch (type) {
    case "check.updated": {
      const id = typeof e.id === "string" ? e.id : "";
      if (!id) return "invalid";
      const existing = state.checks[id];
      if (existing && time(timestamp) <= time(existing.lastChangeAt)) return "older";
      const next: StoredCheck = existing ? { ...existing } : ({ id, lastChangeAt: timestamp } as StoredCheck);
      for (const field of CHECK_FIELDS) {
        if (field in e) (next as unknown as Record<string, unknown>)[field] = e[field];
      }
      if (next.level !== null && next.level !== undefined) next.level = Number(next.level);
      if (next.charges !== null && next.charges !== undefined) next.charges = Number(next.charges);
      next.lastChangeAt = timestamp;
      state.checks[id] = next;
      return "applied";
    }
    case "check.expiring": {
      const id = typeof e.id === "string" ? e.id : "";
      if (!id) return "invalid";
      const existing = state.checks[id] ?? ({
        id,
        externalIdentifier: (e.externalIdentifier as string) ?? null,
        clientId: String(e.clientId ?? ""),
        status: String(e.status ?? ""),
        stage: "complete",
        level: null,
        completedAt: null,
        expirationDate: null,
        lastChangeAt: timestamp,
      } as StoredCheck);
      const expirationDate = String(e.expirationDate ?? existing.expirationDate ?? "");
      state.checks[id] = {
        ...existing,
        expirationDate,
        expiring: { daysLeft: Number(e.daysLeft), expirationDate, notifiedAt: timestamp },
      };
      return "noted";
    }
    case "ping":
      state.lastPingAt = timestamp;
      return "ping";
    default:
      // batch.completed, client.connected, client.migrated and future events: not used here.
      return "ignored";
  }
}

function pruneSeenEvents(state: StoreData, now: Date) {
  const cutoff = now.getTime() - SEEN_EVENT_TTL_MS;
  for (const [id, at] of Object.entries(state.seenEvents)) {
    if (parseUtc(at) < cutoff) delete state.seenEvents[id];
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
