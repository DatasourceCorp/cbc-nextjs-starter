"use client";

import { useActionState } from "react";
import { US_STATES } from "../../../lib/us-states.ts";
import type { Product } from "../../../lib/types.ts";
import { orderCheckAction, type OrderFormState } from "../../actions.ts";
import { SubmitButton } from "../../SubmitButton.tsx";

export function OrderForm({ products, externalIdentifier }: { products: Product[]; externalIdentifier: string }) {
  const [state, formAction] = useActionState<OrderFormState, FormData>(orderCheckAction, {
    ok: false,
    message: "",
    externalIdentifier,
  });
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const err = (name: string) => (errors[name] ? <span className="field-error">{errors[name]}</span> : null);

  return (
    <form action={formAction} className="stack" noValidate>
      {state.message ? <div className={`alert ${state.ok ? "alert-ok" : "alert-bad"}`}>{state.message}</div> : null}

      {/* Your id for this order. It stays the same when you resubmit after an error,
          so a retry can never order the same check twice. */}
      <input type="hidden" name="externalIdentifier" value={state.externalIdentifier} readOnly />

      <div className="row2">
        <label>
          First name
          <input name="firstName" defaultValue={v.firstName} autoComplete="off" required aria-invalid={!!errors.firstName} />
          {err("firstName")}
        </label>
        <label>
          Last name
          <input name="lastName" defaultValue={v.lastName} autoComplete="off" required aria-invalid={!!errors.lastName} />
          {err("lastName")}
        </label>
      </div>
      <label>
        Email <span className="hint">The invitation to give details and consent goes here.</span>
        <input name="email" defaultValue={v.email} type="email" autoComplete="off" required aria-invalid={!!errors.email} />
        {err("email")}
      </label>
      <label>
        Level
        <select name="level" key={`level-${v.level ?? ""}`} required defaultValue={v.level ?? ""} aria-invalid={!!errors.level}>
          <option value="" disabled>
            Choose a level
          </option>
          {products.map((p) => (
            <option key={p.level} value={p.level}>
              {p.level}. {p.name}
              {p.price !== null ? ` · $${p.price.toFixed(2)} ${p.feesNote}` : ""}
            </option>
          ))}
        </select>
        {err("level")}
      </label>
      <div className="row2">
        <label>
          Job location <span className="hint">Where this person will serve, as the church tells you.</span>
          <input name="jobLocation" defaultValue={v.jobLocation} maxLength={100} placeholder="Blue Springs, MO" required aria-invalid={!!errors.jobLocation} />
          {err("jobLocation")}
        </label>
        <label>
          State of employment
          <select name="stateOfEmployment" key={`st-${v.stateOfEmployment ?? ""}`} required defaultValue={v.stateOfEmployment ?? ""} aria-invalid={!!errors.stateOfEmployment}>
            <option value="" disabled>
              Choose a state
            </option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {err("stateOfEmployment")}
        </label>
      </div>
      {err("form")}
      <p className="small muted">
        Ordering is billable once submitted (nothing is billed in the sandbox). Order id: <code>{state.externalIdentifier}</code>
      </p>
      <div className="actions">
        <SubmitButton>Order check</SubmitButton>
      </div>
    </form>
  );
}
