"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, type FormState } from "./actions";

export function LoginForm({ notice, next }: { notice?: string; next?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {});
  return (
    <form action={action}>
      {next && <input type="hidden" name="next" value={next} />}
      {notice && <div className="notice warning">{notice}</div>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <div className="row between" style={{ marginTop: 14, alignItems: "center" }}>
        <Link className="link small" href="/forgot-password">Forgot password?</Link>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </div>
    </form>
  );
}
