"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import type { ActionState } from "./types";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const FAILED = "The request did not go through. Check your connection and try again.";

// Sent on every successful save, so an error left on another form (for example Complete Work
// saying a component is missing data) disappears once that component is saved.
const SAVED_EVENT = "shop-action-saved";

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
 * On success it shows a short confirmation next to the button.
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
  onChange,
  successText = "Saved.",
  successHref,
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
  /** Runs when any field in the form changes. */
  onChange?: () => void;
  /** Shown next to the button after a successful submit. */
  successText?: string;
  /** Opened after a successful submit, for actions that change what the page shows (status changes). */
  successHref?: string;
  /** Shown when the action throws instead of returning. */
  failMessage?: string;
}) {
  const router = useRouter();
  // A status change re-renders the page without this form, so the redirect to the notice
  // runs here, as soon as the action returns, and not in an effect after it.
  const [state, formAction, pending] = useActionState<ActionState, FormData>(async (prev: ActionState, fd: FormData) => {
    const result = await safe(action, failMessage)(prev, fd);
    if (result.ok && successHref) router.replace(successHref);
    return result;
  }, {});
  const formRef = useRef<HTMLFormElement>(null);
  // The result the user has since moved past: a later edit hides "Saved.", a later save elsewhere hides an error.
  const [editedAfter, setEditedAfter] = useState<ActionState | null>(null);
  const [savedAfter, setSavedAfter] = useState<ActionState | null>(null);
  const stateRef = useRef(state);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    stateRef.current = state;
  });

  useEffect(() => {
    const hideError = () => setSavedAfter(stateRef.current);
    window.addEventListener(SAVED_EVENT, hideError);
    return () => window.removeEventListener(SAVED_EVENT, hideError);
  }, []);

  useEffect(() => {
    if (!state.ok) return;
    if (resetOnSuccess) formRef.current?.reset();
    onSuccessRef.current?.();
    window.dispatchEvent(new Event(SAVED_EVENT));
  }, [state.ok, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onChange={() => {
        setEditedAfter(state);
        onChange?.();
      }}
      className={className}
      id={id}
    >
      {children}
      {state.error && savedAfter !== state && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        {footer}
        <button className={submitClass} type="submit" disabled={pending} style={{ minHeight: 44 }}>
          {pending ? pendingLabel : submitLabel}
        </button>
        <span role="status" className="small" style={{ fontWeight: 700 }}>
          {state.ok && !pending && editedAfter !== state ? successText : ""}
        </span>
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
