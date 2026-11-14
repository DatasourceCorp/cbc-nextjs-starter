"use client";

import { useActionState } from "react";
import { createChurchAction, type FormState } from "./actions.ts";
import { SubmitButton } from "./SubmitButton.tsx";

const FIELDS: Array<[name: string, label: string, type?: string, hint?: string]> = [
  ["legalCompanyName", "Church legal name"],
  ["primaryContactFirstName", "Contact first name"],
  ["primaryContactLastName", "Contact last name"],
  ["primaryContactEmail", "Contact email", "email", "Becomes their portal sign-in."],
  ["primaryContactPhone", "Contact phone", "tel"],
  ["streetLine1", "Street address"],
  ["city", "City"],
  ["state", "State", "text", "2-letter code, e.g. CO"],
  ["postalCode", "ZIP code"],
];

export function CreateChurchForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createChurchAction, {});
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="stack" noValidate>
      {state.message ? <div className={`alert ${state.ok ? "alert-ok" : "alert-bad"}`}>{state.message}</div> : null}
      <label>
        Your id for this church <span className="hint">externalClientId: optional, generated if empty (at most 100 characters)</span>
        <input name="externalClientId" defaultValue={state.values?.externalClientId} maxLength={100} placeholder="org-1042" aria-invalid={!!errors.externalClientId} />
        {errors.externalClientId ? <span className="field-error">{errors.externalClientId}</span> : null}
      </label>
      <div className="row2">
        {FIELDS.map(([name, label, type, hint]) => (
          <label key={name}>
            {label} {hint ? <span className="hint">{hint}</span> : null}
            <input name={name} type={type ?? "text"} defaultValue={state.values?.[name]} required aria-invalid={!!errors[name]} />
            {errors[name] ? <span className="field-error">{errors[name]}</span> : null}
          </label>
        ))}
      </div>
      <div className="actions">
        <SubmitButton>Create church</SubmitButton>
      </div>
    </form>
  );
}
