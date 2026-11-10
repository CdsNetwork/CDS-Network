import type { ActionState } from "./ActionForm";

export type ActionMessage = { kind: "error" | "ok"; text: string };

/** The message an action result shows: its error, else its success text, else nothing. */
export function actionMessage(state: ActionState): ActionMessage | null {
  if (state.error) return { kind: "error", text: state.error };
  if (state.ok) return { kind: "ok", text: state.ok };
  return null;
}

/**
 * Forms in one group share a message: the action that finished last wins, so a delete after
 * an add replaces the "added" message instead of leaving it on screen.
 */
export function latestActionState(_current: ActionState, result: ActionState): ActionState {
  return { ...result, at: result.at ?? Date.now() };
}
