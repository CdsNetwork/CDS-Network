"use client";

import { useActionState } from "react";
import { requestPasswordReset, type FormState } from "@/app/login/actions";

export function ResetForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(requestPasswordReset, {});
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" autoComplete="email" required />
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.message && <div className="notice">{state.message}</div>}
      <button className="btn btn-primary" type="submit" disabled={pending}>
        Send reset link
      </button>
    </form>
  );
}
