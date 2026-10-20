import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// The webhooks have no session: the ShipStation webhook checks the ShipStation signature,
// the email intake webhook checks INTAKE_WEBHOOK_TOKEN, the cron routes check CRON_SECRET.
// /legal/ (terms, privacy) and /quickbooks/ (Intuit's disconnect, launch and connect URLs)
// must open without a login; the launch and connect routes check the login themselves.
export const PUBLIC_PATHS = [
  "/login",
  "/forgot-password",
  "/auth/confirm",
  "/api/shipstation/webhook",
  "/api/intake/email",
  "/api/cron/",
  "/legal/",
  "/quickbooks/",
];

/** Refreshes the Supabase session cookie and sends signed-out visitors to /login. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));
  // A server action call (POST with a Next-Action header) must not get a plain redirect:
  // the browser would follow it and hand the action an HTML page, which the form shows as
  // a connection error. Each action checks the login itself (requireShop / requireCds)
  // and redirects to /login in a way the client understands.
  const isServerAction = request.method === "POST" && request.headers.has("next-action");
  if (!user && !isPublic && !isServerAction) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
