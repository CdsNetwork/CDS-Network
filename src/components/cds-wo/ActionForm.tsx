"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";

export type ActionState = { error?: string; ok?: string; at?: number };

type Props = {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  buttonClass?: string;
  /** Asks the browser to confirm before submitting. */
  confirmText?: string;
  disabled?: boolean;
  className?: string;
  /** Renders the button on the same row as the fields. */
  inline?: boolean;
  /** Clears the fields after a successful save (for "add" forms). */
  resetOnSuccess?: boolean;
};

/**
 * A form bound to a server action that shows the action's error or success message.
 * Submits by hand so a failed save keeps what the user typed.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving...",
  buttonClass = "btn btn-primary",
  confirmText,
  disabled = false,
  className,
  inline = false,
  resetOnSuccess = false,
}: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state.ok && !state.error) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(fd));
  }

  const button = (
    <button className={buttonClass} type="submit" disabled={pending || disabled}>
      {pending ? pendingLabel : submitLabel}
    </button>
  );
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className}>
      {inline ? (
        <div className="row" style={{ alignItems: "flex-end" }}>
          {children}
          {button}
        </div>
      ) : (
        <>
          {children}
          {button}
        </>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && !state.error && (
        <p className="small" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}
