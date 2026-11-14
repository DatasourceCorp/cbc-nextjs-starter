"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** Disables itself while its form is posting, so a double click can't send twice. */
export function SubmitButton({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} aria-busy={pending}>
      {pending ? "Working..." : children}
    </button>
  );
}
