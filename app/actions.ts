"use server";

// Every mutation goes through a Server Action. Next.js only accepts a Server Action
// POST whose Origin matches the Host, which protects these forms from CSRF.
// The API key stays on the server: actions run server-side only.

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCbcClient } from "../lib/api.ts";
import { CbcApiError } from "../lib/cbc-client.ts";
import { upsertCheckFromApi, type Church } from "../lib/checks-state.ts";
import { getConfig } from "../lib/config.ts";
import { placeOrder, type OrderOutcome } from "../lib/orders.ts";
import { readStore, updateStore } from "../lib/store.ts";
import { refreshChecks } from "../lib/sync.ts";
import type { Client, CreateClientRequest, SimulateStage, SimulateStatus } from "../lib/types.ts";

export interface FormState {
  message?: string;
  ok?: boolean;
  fieldErrors?: Record<string, string>;
  /** What was submitted, so the form can show it again after an error (React resets forms after an action). */
  values?: Record<string, string>;
}

const str = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const formValues = (form: FormData) =>
  Object.fromEntries([...form.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
const NO_KEY = "Set CBC_API_KEY in .env.local and restart the app.";

function apiErrorMessage(err: unknown): string {
  if (err instanceof CbcApiError) {
    if (err.status === 401) return "The API key was rejected (invalid_api_key). Check CBC_API_KEY and CBC_BASE_URL.";
    return `The API answered ${err.status}${err.code ? ` ${err.code}` : ""}${err.problem.detail ? `: ${err.problem.detail}` : "."}`;
  }
  return "Couldn't reach the API. Try again.";
}

function toChurch(client: Client): Church {
  return {
    clientId: client.clientId,
    externalClientId: client.externalClientId,
    name: client.name,
    portalUrl: client.portalUrl,
    connectedAt: new Date().toISOString(),
  };
}

async function saveChurch(client: Client) {
  await updateStore((data) => {
    if (data.church?.clientId !== client.clientId) data.lastSync = null; // new church: full refresh next time
    data.church = toChurch(client);
  });
}

// ---- Church ---------------------------------------------------------------

/** POST /clients with your own externalClientId. 409 external_client_id_in_use -> use that client. */
export async function createChurchAction(_prev: FormState, form: FormData): Promise<FormState> {
  const api = getCbcClient();
  const values = formValues(form);
  if (!api) return { message: NO_KEY, values };

  const req: CreateClientRequest = {
    externalClientId: str(form, "externalClientId") || `church-${randomBytes(4).toString("hex")}`,
    legalCompanyName: str(form, "legalCompanyName"),
    primaryContactFirstName: str(form, "primaryContactFirstName"),
    primaryContactLastName: str(form, "primaryContactLastName"),
    primaryContactEmail: str(form, "primaryContactEmail"),
    primaryContactPhone: str(form, "primaryContactPhone"),
    streetLine1: str(form, "streetLine1"),
    city: str(form, "city"),
    state: str(form, "state"),
    postalCode: str(form, "postalCode"),
  };

  try {
    const created = await api.createClient(req);
    await saveChurch(created);
    console.info(`[cbc] church created ${created.clientId}`);
  } catch (err) {
    if (err instanceof CbcApiError && err.status === 409 && err.code === "external_client_id_in_use") {
      const [existing] = await api.listClients(req.externalClientId);
      if (existing) {
        await saveChurch(existing);
        revalidatePath("/");
        return { ok: true, message: "A church with that id already exists under your account, so it was connected instead." };
      }
    }
    if (err instanceof CbcApiError && err.status === 400 && err.problem.errors) {
      const fieldErrors = Object.fromEntries(
        Object.entries(err.problem.errors).map(([field, messages]) => [field, messages.join(" ")]),
      );
      return { message: "Please fix the highlighted fields.", fieldErrors, values };
    }
    return { message: apiErrorMessage(err), values };
  }
  revalidatePath("/");
  return { ok: true, message: "Church created. Its primary contact gets a portal sign-in by email from Datasource." };
}

/** Connects a church picked from GET /clients. */
export async function connectChurchAction(form: FormData): Promise<void> {
  const api = getCbcClient();
  if (!api) redirect(`/?err=${encodeURIComponent(NO_KEY)}`);
  const clientId = str(form, "clientId");
  let error: string | null = null;
  try {
    await saveChurch(await api.getClient(clientId));
  } catch (err) {
    error = apiErrorMessage(err);
  }
  revalidatePath("/");
  redirect(error ? `/?err=${encodeURIComponent(error)}` : "/?msg=Church%20connected.");
}

/** Forgets the church locally (nothing changes at Christian Background Checks). */
export async function disconnectChurchAction(): Promise<void> {
  await updateStore((data) => {
    data.church = null;
    data.lastSync = null;
  });
  revalidatePath("/");
  redirect("/");
}

// ---- Orders ---------------------------------------------------------------

export interface OrderFormState extends OrderOutcome {
  /** The id to submit next time: the same one on retry, a new one after success. */
  externalIdentifier: string;
  values?: Record<string, string>;
}

export async function orderCheckAction(prev: OrderFormState, form: FormData): Promise<OrderFormState> {
  const api = getCbcClient();
  const externalIdentifier = str(form, "externalIdentifier") || prev.externalIdentifier;
  const values = formValues(form);
  if (!api) return { ok: false, message: NO_KEY, externalIdentifier, values };
  const { church } = await readStore();
  if (!church) return { ok: false, message: "Connect a church first.", externalIdentifier, values };

  const outcome = await placeOrder(api, church.clientId, {
    externalIdentifier,
    firstName: str(form, "firstName"),
    lastName: str(form, "lastName"),
    email: str(form, "email"),
    level: Number(str(form, "level")),
    jobLocation: str(form, "jobLocation"),
    stateOfEmployment: str(form, "stateOfEmployment"),
  });

  if (outcome.ok && outcome.checkId) {
    revalidatePath("/checks");
    redirect(`/checks?check=${encodeURIComponent(outcome.checkId)}&msg=${encodeURIComponent(outcome.message)}`);
  }
  // Failed: keep the same externalIdentifier so a retry can never order twice,
  // unless the API told us that id belongs to another church's check.
  return { ...outcome, externalIdentifier: outcome.newExternalIdentifier ?? externalIdentifier, values };
}

// ---- Checks ---------------------------------------------------------------

/** GET /clients/{clientRef}/checks with updated_since, following nextCursor. */
export async function refreshChecksAction(): Promise<void> {
  const api = getCbcClient();
  if (!api) redirect(`/checks?err=${encodeURIComponent(NO_KEY)}`);
  const { church } = await readStore();
  if (!church) redirect("/checks?err=Connect%20a%20church%20first.");
  let target: string;
  try {
    const { fetched, applied } = await refreshChecks(api, church.clientId);
    target = `/checks?msg=${encodeURIComponent(`Refreshed: ${fetched} checks changed since the last refresh, ${applied} updated here.`)}`;
  } catch (err) {
    if (err instanceof CbcApiError && err.code === "invalid_cursor") {
      await updateStore((data) => void (data.lastSync = null));
    }
    target = `/checks?err=${encodeURIComponent(apiErrorMessage(err))}`;
  }
  revalidatePath("/checks");
  redirect(target);
}

const SIMULATE_TARGETS: Record<string, [SimulateStatus, SimulateStage?]> = {
  awaiting_applicant: ["CREATED"],
  applicant_ready: ["CREATED", "applicant_ready"],
  in_progress: ["CREATED", "in_progress"],
  CLEAR: ["CLEAR"],
  REVIEW: ["REVIEW"],
  ERROR: ["ERROR"],
  CANCELLED: ["CANCELLED"],
};

/** Sandbox only: POST /test/checks/{checkRef}/simulate. The API also sends check.updated. */
export async function simulateAction(form: FormData): Promise<void> {
  const config = getConfig();
  const api = getCbcClient();
  if (!api) redirect(`/checks?err=${encodeURIComponent(NO_KEY)}`);
  if (!config.isSandbox) redirect("/checks?err=Simulate%20exists%20only%20in%20the%20sandbox.");

  const checkId = str(form, "checkId");
  const target = SIMULATE_TARGETS[str(form, "target")];
  if (!checkId || !target) redirect("/checks?err=Pick%20a%20status%20to%20simulate.");

  let url: string;
  try {
    const check = await api.simulate(checkId, target[0], target[1]);
    await updateStore((data) => void upsertCheckFromApi(data, check));
    url = `/checks?check=${encodeURIComponent(check.id)}&msg=${encodeURIComponent(`Moved to ${check.status} (${check.stage}). A check.updated webhook is on its way.`)}`;
  } catch (err) {
    url = `/checks?err=${encodeURIComponent(apiErrorMessage(err))}`;
  }
  revalidatePath("/checks");
  redirect(url);
}

// ---- Webhook settings -------------------------------------------------------

/** PUT /settings replaces both URL values, so read the current ones and send the full set. */
export async function saveWebhookUrlAction(form: FormData): Promise<void> {
  const api = getCbcClient();
  if (!api) redirect(`/settings?err=${encodeURIComponent(NO_KEY)}`);
  const webhookUrl = str(form, "webhookUrl");
  let url: string;
  try {
    const current = await api.getSettings();
    await api.updateSettings({ webhookUrl: webhookUrl || null, connectReturnUrls: current.connectReturnUrls ?? [] });
    url = `/settings?msg=${encodeURIComponent(webhookUrl ? "Webhook URL saved." : "Webhooks turned off.")}`;
  } catch (err) {
    url = `/settings?err=${encodeURIComponent(apiErrorMessage(err))}`;
  }
  redirect(url);
}

/** POST /settings/webhook-test: the API sends a signed `ping` to your webhook URL. */
export async function sendTestWebhookAction(): Promise<void> {
  const api = getCbcClient();
  if (!api) redirect(`/settings?err=${encodeURIComponent(NO_KEY)}`);
  let url: string;
  try {
    await api.sendTestWebhook();
    url = "/settings?msg=Ping%20queued.%20Reload%20in%20a%20few%20seconds%20to%20see%20it%20arrive.";
  } catch (err) {
    url = `/settings?err=${encodeURIComponent(apiErrorMessage(err))}`;
  }
  redirect(url);
}
