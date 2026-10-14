"use client";

import { useActionState } from "react";
import { setPassword, type FormState } from "@/app/login/actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(setPassword, {});
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="password">New password</label>
        <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      <div className="field">
        <label htmlFor="confirm">Repeat password</label>
        <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <button className="btn btn-primary" type="submit" disabled={pending}>Save password</button>
    </form>
  );
}
