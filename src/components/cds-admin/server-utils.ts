import "server-only";
import { pacificToday } from "@/lib/dates";

/** Today's Pacific date, the date the database starts and ends prices on (private.today()). */
export function today(): string {
  return pacificToday();
}

export function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export function optionalText(formData: FormData, name: string): string | null {
  const value = text(formData, name);
  return value === "" ? null : value;
}

/** A non-negative number, null when blank, or NaN when the input is not a number. */
export function optionalAmount(formData: FormData, name: string): number | null {
  const raw = text(formData, name).replace(/[$,\s]/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

/** "true" / "false" / "" from a select, as boolean or null. */
export function triState(formData: FormData, name: string): boolean | null {
  const value = text(formData, name);
  return value === "true" ? true : value === "false" ? false : null;
}

export function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) !== null;
}

type DbError = { code?: string; message?: string } | null | undefined;

/** A short, user-facing message for a database error. */
export function dbMessage(error: DbError, fallback = "Could not save. Try again."): string {
  if (!error) return fallback;
  if (error.code === "23505") return "That already exists. Use a different code or value.";
  if (error.code === "23503") return "That record is linked to something that no longer exists.";
  if (error.code === "23514") return "One of the values is not allowed. Check the form and try again.";
  if (error.code === "42501") return "You do not have permission to do this.";
  if (error.code === "P0001" && error.message) return error.message;
  return fallback;
}

/** Embedded one-to-one rows come back as an object or a one-item array. */
export function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
