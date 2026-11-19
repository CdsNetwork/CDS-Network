"use client";

import { useActionState } from "react";
import { requestPasswordReset, type FormState } from "@/app/login/actions";

/** usernameLogins: the shop_username_logins switch; off shows the email field from before. */
export function ResetForm({ usernameLogins = false }: { usernameLogins?: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestPasswordReset, {});
  return (
    <form action={action}>
      <div className="field">
        {usernameLogins ? (
          <>
            <label htmlFor="login">Email or username</label>
            <input
              className="input"
              id="login"
              name="login"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <p className="small" style={{ margin: "6px 0 0" }}>
              For a username, the link goes to the recovery email CDS has for that login.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" autoComplete="email" required />
          </>
        )}
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.message && <div className="notice">{state.message}</div>}
      <button className="btn btn-primary" type="submit" disabled={pending}>
        Send reset link
      </button>
    </form>
  );
}
