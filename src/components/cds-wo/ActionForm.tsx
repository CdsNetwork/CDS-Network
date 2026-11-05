"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { formChanged, runWithPendingEdits } from "./pending-edits";

export type ActionState = { error?: string; ok?: string; at?: number };

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** What each form with an id looked like when it was last loaded or saved. */
const savedSnapshots = new WeakMap<HTMLFormElement, FormData>();

/** The other form's current fields when they differ from its last saved snapshot, else null. */
function pendingEdits(formId: string): { form: HTMLFormElement; data: FormData } | null {
  const form = document.getElementById(formId);
  if (!(form instanceof HTMLFormElement)) return null;
  const data = new FormData(form);
  const saved = savedSnapshots.get(form);
  return saved && !formChanged(saved, data) ? null : { form, data };
}

type Props = {
  action: FormAction;
  /** Form id, so another form can save this one's unsaved changes first (see saveFirst). */
  id?: string;
  /** Before running the action, saves the form with this id when it has unsaved changes; a failed save stops the action. */
  saveFirst?: { formId: string; action: FormAction };
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
  id,
  saveFirst,
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
  const pendingRef = useRef<{ form: HTMLFormElement; data: FormData } | null>(null);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(async (prev, formData) => {
    const edits = pendingRef.current;
    pendingRef.current = null;
    if (!saveFirst || !edits) return action(prev, formData);
    // Both callbacks return ActionState, so the result is one too.
    return (await runWithPendingEdits({
      pending: edits.data,
      save: async (data) => {
        const saved = await saveFirst.action({}, data);
        if (!saved.error) savedSnapshots.set(edits.form, data);
        return saved;
      },
      run: () => action(prev, formData),
    })) as ActionState;
  }, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state.ok && !state.error) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  // Remember the loaded and the last saved fields, so only real changes count as unsaved.
  useEffect(() => {
    const form = formRef.current;
    if (id && form && (!savedSnapshots.has(form) || (state.ok && !state.error))) savedSnapshots.set(form, new FormData(form));
  }, [id, state]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(e.currentTarget, submitter);
    pendingRef.current = saveFirst ? pendingEdits(saveFirst.formId) : null;
    startTransition(() => formAction(fd));
  }

  const button = (
    <button className={buttonClass} type="submit" disabled={pending || disabled}>
      {pending ? pendingLabel : submitLabel}
    </button>
  );
  return (
    <form ref={formRef} id={id} onSubmit={onSubmit} className={className}>
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
