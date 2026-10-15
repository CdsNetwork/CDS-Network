import { unstable_rethrow } from "next/navigation";

/**
 * True for the errors Next.js uses for its own control flow (redirect, notFound), for
 * example the redirect to /login a server action raises when the session has ended.
 * Code that catches errors must let these through instead of showing a message.
 */
export function isNextControlError(err: unknown): boolean {
  try {
    unstable_rethrow(err);
    return false;
  } catch {
    return true;
  }
}
