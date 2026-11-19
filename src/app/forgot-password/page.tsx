import Link from "next/link";
import { Brand } from "@/components/Brand";
import { usernameLoginsOnForVisitors } from "@/lib/shop-login-setting";
import { ResetForm } from "./ResetForm";

// Rendered per request: the shop_username_logins switch is read when the page opens, not at build time.
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const usernameLogins = await usernameLoginsOnForVisitors();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div style={{ marginBottom: 18 }}>
          <Brand subtitle="Network Portal" />
        </div>
        <div className="card">
          <h1 style={{ margin: "0 0 12px", fontSize: 22 }}>Reset your password</h1>
          <ResetForm usernameLogins={usernameLogins} />
          <p className="small" style={{ marginBottom: 0 }}>
            <Link className="link" href="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
