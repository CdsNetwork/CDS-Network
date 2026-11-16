/**
 * What a key press does in a type-to-search box (SearchSelect, the location picker).
 * Enter is always handled by the box, so it never submits the form around it.
 */
export type ComboboxState = {
  open: boolean;
  /** Index of the highlighted option, -1 for none. */
  active: number;
  /** Options shown in the list. */
  count: number;
  /** A value is already chosen. */
  picked: boolean;
  /** Text was typed since the list opened. */
  typed: boolean;
};

export type ComboboxAction =
  | { type: "move"; active: number }
  | { type: "pick"; index: number }
  | { type: "enter-picked" }
  | { type: "block" }
  | { type: "close" }
  | { type: "none" };

export function comboboxKey(key: string, s: ComboboxState): ComboboxAction {
  const last = Math.max(s.count - 1, 0);
  if (key === "ArrowDown") return { type: "move", active: s.open ? Math.min(Math.max(s.active + 1, 0), last) : Math.max(s.active, 0) };
  if (key === "ArrowUp") return { type: "move", active: Math.max(Math.min(s.active - 1, last), 0) };
  if (key === "Escape") return { type: "close" };
  if (key !== "Enter") return { type: "none" };
  if (s.picked && (!s.open || !s.typed)) return { type: "enter-picked" };
  if (!s.open || s.count === 0) return { type: "block" };
  if (s.active >= 0 && s.active < s.count) return { type: "pick", index: s.active };
  if (s.count === 1) return { type: "pick", index: 0 };
  return { type: "block" };
}
