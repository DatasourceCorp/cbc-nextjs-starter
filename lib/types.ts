// Shapes from the Partner API (https://partners.cbgc.io/openapi/v1.json).
// The API adds fields and enum values without notice, so every enum here also
// accepts any other string, and unknown fields are simply ignored.

export type CheckStatus =
  | "QUEUED"
  | "PENDING"
  | "CREATED"
  | "CLEAR"
  | "REVIEW"
  | "ERROR"
  | "CANCELLED"
  | (string & {});

export type CheckStage =
  | "queued"
  | "submitting"
  | "awaiting_applicant"
  | "applicant_ready"
  | "in_progress"
  | "complete"
  | "closed"
  | (string & {});

/** A check as the API returns it (CheckResponse). Key it by `id`. */
export interface Check {
  id: string;
  externalIdentifier: string | null;
  clientId: string;
  status: CheckStatus;
  stage: CheckStage;
  level: number | null;
  expirationDate: string | null;
  completedAt: string | null;
  reportUrl?: string | null;
  charges?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CheckPage {
  items: Check[];
  nextCursor: string | null;
}

/** A church (ClientResponse). Address it as `{clientRef}` = clientId or externalClientId. */
export interface Client {
  clientId: string;
  externalClientId: string | null;
  name: string | null;
  status: string;
  createdAt: string;
  portalUrl: string | null;
}

export interface CreateClientRequest {
  externalClientId?: string;
  legalCompanyName: string;
  primaryContactFirstName: string;
  primaryContactLastName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  streetLine1: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface CreateClientResponse extends Client {
  primaryUsername: string | null;
  welcomeEmailSent: boolean;
}

export interface Product {
  level: number;
  name: string;
  description: string;
  price: number | null;
  /** Always "Plus pass-through fees.": show it next to every price. */
  feesNote: string;
}

export interface CreateOrderRequest {
  externalIdentifier: string;
  firstName: string;
  lastName: string;
  applicantEmail: string;
  level: number;
  jobLocation?: string;
  stateOfEmployment?: string;
}

/** RFC 9457 problem details, plus the API's stable `code`. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  traceId?: string;
  errors?: Record<string, string[]>;
}

export interface Settings {
  webhookUrl: string | null;
  connectReturnUrls: string[];
  checkValidityYears?: number;
}

/** Simulate targets accepted by POST /test/checks/{checkRef}/simulate. */
export type SimulateStatus = "CREATED" | "CLEAR" | "REVIEW" | "ERROR" | "CANCELLED";
export type SimulateStage = "awaiting_applicant" | "applicant_ready" | "in_progress";
