import { NextResponse, type NextRequest } from "next/server";
import { requireCds } from "@/lib/auth";
import { QBO_AUTHORIZE_URL, QBO_SCOPE, qboConfig } from "@/lib/qbo/config";
import { createState, STATE_COOKIE, STATE_TTL_SECONDS } from "@/lib/qbo/secure";

/**
 * Starts the Intuit OAuth 2.0 authorization code flow
 * (https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0).
 * Only a QuickBooks Primary Admin or Company Admin can approve the connection on Intuit's
 * screen. The state value is tied to this browser and this login by a signed cookie.
 */
export async function GET(request: NextRequest) {
  const me = await requireCds();
  const config = qboConfig();
  if (!config) {
    return NextResponse.redirect(new URL("/cds/admin?tab=settings&qbo=not_configured", request.url));
  }

  const { state, cookie } = createState(config.clientSecret, me.id);
  const authorize = new URL(QBO_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", QBO_SCOPE);
  authorize.searchParams.set("redirect_uri", config.redirectUri);
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(STATE_COOKIE, cookie, {
    httpOnly: true,
    // Lax: the cookie must come back on Intuit's top-level redirect to the callback.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/cds/quickbooks",
    maxAge: STATE_TTL_SECONDS,
  });
  return response;
}
