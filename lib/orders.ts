// Ordering a check: validation, the API call, every documented outcome, and storage.

import { randomUUID } from "node:crypto";
import type { CbcClient, OrderResult } from "./cbc-client.ts";
import { upsertCheckFromApi } from "./checks-state.ts";
import { updateStore } from "./store.ts";

export interface OrderInput {
  /** Generated once per order form and reused on every retry of that order. */
  externalIdentifier: string;
  firstName: string;
  lastName: string;
  email: string;
  level: number;
  jobLocation: string;
  stateOfEmployment: string;
}

export interface OrderOutcome {
  ok: boolean;
  message: string;
  /** The check to show (new, existing duplicate, or pending). */
  checkId?: string;
  fieldErrors?: Record<string, string>;
  /** Set only when the form must use a new externalIdentifier from now on. */
  newExternalIdentifier?: string;
}

/** Your id for a check: unique across all your churches, at most 100 characters. */
export function newExternalIdentifier(): string {
  return `vol-${randomUUID()}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks the form before anything is sent (the API validates again). */
export function validateOrderInput(input: OrderInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.firstName) errors.firstName = "First name is required.";
  if (!input.lastName) errors.lastName = "Last name is required.";
  if (!EMAIL.test(input.email)) errors.email = "Enter a valid email address.";
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 6) errors.level = "Choose a level.";
  // The church must tell us where the person will serve; never guess it from the church's address.
  if (!input.jobLocation) errors.jobLocation = "Where will this person serve? (e.g. Blue Springs, MO)";
  else if (input.jobLocation.length > 100) errors.jobLocation = "At most 100 characters.";
  if (!input.stateOfEmployment) errors.stateOfEmployment = "Choose the state.";
  if (!input.externalIdentifier || input.externalIdentifier.length > 100) errors.form = "Reload the form and try again.";
  return errors;
}

/** API field names (case-insensitive) -> form field names, for 400 validation_failed. */
const FIELD_MAP: Record<string, string> = {
  firstname: "firstName",
  lastname: "lastName",
  applicantemail: "email",
  level: "level",
  joblocation: "jobLocation",
  stateofemployment: "stateOfEmployment",
};

export async function placeOrder(client: CbcClient, clientRef: string, input: OrderInput): Promise<OrderOutcome> {
  const fieldErrors = validateOrderInput(input);
  if (Object.keys(fieldErrors).length) return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };

  const result = await client.orderCheck(clientRef, {
    externalIdentifier: input.externalIdentifier,
    firstName: input.firstName,
    lastName: input.lastName,
    applicantEmail: input.email,
    level: input.level,
    jobLocation: input.jobLocation,
    stateOfEmployment: input.stateOfEmployment,
  });

  // Keep every check we learn about, with the applicant details only we hold.
  if ("check" in result && result.check?.id) {
    const check = result.check;
    await updateStore((data) => {
      const known = data.checks[check.id];
      upsertCheckFromApi(data, check, {
        // A duplicate may be an earlier check for the same email: keep its original details.
        applicant: known?.applicant ?? { firstName: input.firstName, lastName: input.lastName, email: input.email },
        jobLocation: known?.jobLocation ?? input.jobLocation,
        stateOfEmployment: known?.stateOfEmployment ?? input.stateOfEmployment,
      });
    });
  }

  // Log ids and outcomes only: never names or emails.
  const checkId = "check" in result ? ` ${result.check.id}` : "";
  console.info(`[cbc] order ${input.externalIdentifier} -> ${result.kind}${checkId}`);
  return describe(result);
}

function describe(result: OrderResult): OrderOutcome {
  switch (result.kind) {
    case "created":
      return {
        ok: true,
        checkId: result.check.id,
        message: "Ordered. The applicant has been emailed an invitation to give their details and consent.",
      };
    case "duplicate":
      return {
        ok: true,
        checkId: result.check.id,
        message: `This person already has a check (${result.currentStatus}). Nothing new was ordered or billed; here is the existing one.`,
      };
    case "pending":
      return {
        ok: true,
        checkId: result.check.id,
        message:
          "The order was sent but its confirmation was lost. It is PENDING and resolves on its own within about an hour (a webhook follows). Do not order again.",
      };
    case "rejected":
      return {
        ok: false,
        checkId: result.check.id,
        message: result.check.errorMessage || "The screening provider refused this order. Nothing was billed.",
      };
    case "invalid": {
      const fieldErrors: Record<string, string> = {};
      const other: string[] = [];
      for (const [field, messages] of Object.entries(result.errors)) {
        const key = FIELD_MAP[field.toLowerCase()];
        if (key) fieldErrors[key] = messages.join(" ");
        else other.push(...messages);
      }
      return { ok: false, fieldErrors, message: other.length ? other.join(" ") : "Please fix the highlighted fields." };
    }
    case "level_not_available":
      return {
        ok: false,
        fieldErrors: { level: "This church can't order this level." },
        message: "This church has no product for that level. Pick another level, or contact support@datasourcecorp.com.",
      };
    case "external_identifier_in_use":
      return {
        ok: false,
        newExternalIdentifier: newExternalIdentifier(),
        message: "That order id is already used by another church's check. A new id was generated: submit again.",
      };
    case "failed":
      return { ok: false, message: failureMessage(result) };
  }
}

function failureMessage(r: Extract<OrderResult, { kind: "failed" }>): string {
  if (r.status === 401) return "The API key was rejected (invalid_api_key). Check CBC_API_KEY and CBC_BASE_URL.";
  if (r.status === 404) return "This church isn't under your account (client_not_found). Connect it again on the home page.";
  if (r.status === 429) return "Too many requests (rate_limited). Wait a minute and try again.";
  if (r.status === 0) return "Couldn't reach the API. Submit again: the same order id is reused, so nothing is ordered twice.";
  if (r.status === 502)
    return "The screening provider is unavailable (upstream_unavailable). Nothing was ordered: submit again in a moment.";
  if (r.status === 500)
    return `Something failed on the API side${r.traceId ? ` (traceId ${r.traceId})` : ""}. Submit again: the same order id is reused.`;
  return `The order failed (${r.status}${r.code ? ` ${r.code}` : ""}).`;
}
