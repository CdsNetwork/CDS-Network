import { NextResponse, type NextRequest } from "next/server";
import { getProfile } from "@/lib/auth";

/**
 * Entry points Intuit links to from QuickBooks (the app's Launch URL and Connect/Reconnect
 * URL). A CDS login goes to `target`; a signed-out visitor signs in first and comes back
 * through `next`; a shop login goes to its own portal (QuickBooks is CDS only).
 */
export async function quickBooksEntry(request: NextRequest, target: string, next: string): Promise<NextResponse> {
  const profile = await getProfile();
  if (!profile) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  }
  return NextResponse.redirect(new URL(profile.kind === "cds" ? target : "/shop", request.url));
}
