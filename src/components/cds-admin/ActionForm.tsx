"use client";

import { useActionState, useEffect, useRef, useTransition, type ReactNode } from "react";
import { confirmed } from "./confirm";

export type ActionState = { error?: string; message?: string; ok?: boolean };
export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * A form bound to a server action with inline error and success messages. Fields keep
 * their values when the action returns an error. Pass `submitLabel` for a single submit
 * button, or put your own submit buttons (with name/value) in `children`. Pass `confirmText`
 * for a destructive action: the form then submits only after the user agrees.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving...",
  submitClassName = "btn btn-primary",
  className,
  resetOnSuccess = false,
  inline = false,
  confirmText,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
  submitClassName?: string;
  className?: string;
  resetOnSuccess?: boolean;
  inline?: boolean;
  confirmText?: string;
}) {
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(action, {});
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={formRef}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (!confirmed(confirmText)) return;
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const data = new FormData(e.currentTarget, submitter);
        startTransition(() => dispatch(data));
      }}
    >
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {inline ? (
          <div className="row" style={{ flexWrap: "nowrap" }}>
            {children}
            {submitLabel && (
              <button className={submitClassName} type="submit">
                {pending ? pendingLabel : submitLabel}
              </button>
            )}
          </div>
        ) : (
          <>
            {children}
            {submitLabel && (
              <div className="row" style={{ marginTop: 6 }}>
                <button className={submitClassName} type="submit">
                  {pending ? pendingLabel : submitLabel}
                </button>
              </div>
            )}
          </>
        )}
      </fieldset>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && !state.error && (
        <p className="small" role="status" style={{ color: "#3b6d12", fontWeight: 700, marginTop: 8 }}>
          {state.message}
        </p>
      )}
    </form>
  );
}

/** A Milestone 2 feature: shown, but not usable yet. */
export function M2Button({ label, className = "btn btn-secondary btn-small" }: { label: string; className?: string }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <button className={className} type="button" disabled title="Milestone 2">
        {label}
      </button>
      <span className="small" style={{ fontSize: 11 }}>
        Milestone 2
      </span>
    </span>
  );
}
