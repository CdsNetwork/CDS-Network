"use client";

import { createContext, useMemo, useState, type ReactNode } from "react";
import type { ActionState } from "./ActionForm";
import { actionMessage, latestActionState } from "./action-message";

/** Lets the ActionForms inside a group report their results to one shared message. */
export const ActionMessageContext = createContext<{ report: (result: ActionState) => void } | null>(null);

/**
 * Shows one message for all ActionForms inside it, below them: the result of whichever
 * action finished last. Used where a form disappears with its own result (deleting a note
 * removes the note and its delete form), so its message still shows.
 */
export function ActionMessageGroup({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActionState>({});
  const group = useMemo(() => ({ report: (result: ActionState) => setState((s) => latestActionState(s, result)) }), []);
  const message = actionMessage(state);
  return (
    <ActionMessageContext.Provider value={group}>
      {children}
      {message?.kind === "error" && (
        <p className="error" role="alert">
          {message.text}
        </p>
      )}
      {message?.kind === "ok" && (
        <p className="small" role="status">
          {message.text}
        </p>
      )}
    </ActionMessageContext.Provider>
  );
}
