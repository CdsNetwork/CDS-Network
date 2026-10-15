"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "./types";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const FAILED = "The request did not go through. Check your connection and try again.";

/** Turns a thrown action (network drop, request too large) into an inline error. */
function safe<A extends unknown[]>(action: (...args: A) => Promise<ActionState>, message: string) {
  return async (...args: A): Promise<ActionState> => {
    try {
      return await action(...args);
    } catch (err) {
      // Let Next.js handle its own control flow (redirect to /login when the session
      // has ended, notFound).
      unstable_rethrow(err);
      return { error: message };
    }
  };
}

/**
 * A form posting to a shop server action. Shows the action's error under the fields and
 * keeps what the user typed when the action fails (React would otherwise reset the form).
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving...",
  submitClass = "btn btn-blue",
  resetOnSuccess = false,
  footer,
  className,
  id,
  onSuccess,
  failMessage = FAILED,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  submitClass?: string;
  resetOnSuccess?: boolean;
  /** Shown next to the submit button. */
  footer?: ReactNode;
  className?: string;
  id?: string;
  /** Runs after each successful submit, for example to clear client state. */
  onSuccess?: () => void;
  /** Shown when the action throws instead of returning. */
  failMessage?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(safe(action, failMessage), {});
  const formRef = useRef<HTMLFormElement>(null);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });

  useEffect(() => {
    if (!state.ok) return;
    if (resetOnSuccess) formRef.current?.reset();
    onSuccessRef.current?.();
  }, [state.ok, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className={className} id={id}>
      {children}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        {footer}
        <button className={submitClass} type="submit" disabled={pending} style={{ minHeight: 44 }}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A single button posting to an action with no fields (Remove, Picked Up). */
export function ActionButton({
  action,
  label,
  pendingLabel = "Saving...",
  className = "btn btn-secondary",
  confirmText,
}: {
  action: (prev: ActionState) => Promise<ActionState>;
  label: string;
  pendingLabel?: string;
  className?: string;
  confirmText?: string;
}) {
  const [state, run, pending] = useActionState<ActionState, void>(safe(action, FAILED), {});
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      <button
        type="button"
        className={className}
        disabled={pending}
        style={{ minHeight: 44 }}
        onClick={() => {
          if (confirmText && !window.confirm(confirmText)) return;
          startTransition(() => run());
        }}
      >
        {pending ? pendingLabel : label}
      </button>
      {state.error && (
        <span className="error" role="alert">
          {state.error}
        </span>
      )}
    </span>
  );
}
