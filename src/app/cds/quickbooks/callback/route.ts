import { NextResponse, type NextRequest } from "next/server";
import { requireCds } from "@/lib/auth";
import { automatedSalesTax, companyName } from "@/lib/qbo/api";
import { exchangeCode, QboError } from "@/lib/qbo/client";
import { qboConfig } from "@/lib/qbo/config";
import { STATE_COOKIE, verifyState } from "@/lib/qbo/secure";
import { saveConnection } from "@/lib/qbo/tokens";

/**
 * Intuit redirects here after the consent screen with code, state and realmId (the
 * company id), or with error=access_denied. Exchanges the code for tokens, reads the
 * company name and whether Automated Sales Tax is on, and stores the connection.
 * Result codes for the Settings tab: connected, denied, state, failed, not_configured.
 */
export async function GET(request: NextRequest) {
  const me = await requireCds();
  const params = request.nextUrl.searchParams;
  const back = (result: string) => {
    const response = NextResponse.redirect(new URL(`/cds/admin?tab=settings&qbo=${result}`, request.url));
    response.cookies.set(STATE_COOKIE, "", { path: "/cds/quickbooks", maxAge: 0 });
    return response;
  };

  const config = qboConfig();
  if (!config) return back("not_configured");
  if (!verifyState(config.clientSecret, request.cookies.get(STATE_COOKIE)?.value, params.get("state"), me.id)) {
    return back("state");
  }
  if (params.get("error")) return back("denied");
  const code = params.get("code");
  const realmId = params.get("realmId");
  if (!code || !realmId || !/^\d{1,30}$/.test(realmId)) return back("failed");

  try {
    const tokens = await exchangeCode(config, code);
    const api = { environment: config.environment, realmId, accessToken: tokens.access_token };
    // Both are informational: the connection is kept even if one of them fails.
    const [name, ast] = await Promise.all([
      companyName(api).catch(() => null),
      automatedSalesTax(api).catch(() => null),
    ]);
    await saveConnection({ config, realmId, companyName: name, astEnabled: ast, tokens, connectedBy: me.id });
  } catch (e) {
    console.error("QuickBooks connect failed", e instanceof QboError ? `${e.status} ${e.message}` : e);
    return back("failed");
  }
  return back("connected");
}
