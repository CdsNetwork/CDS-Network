import Link from "next/link";
import { Brand } from "@/components/Brand";
import { ResetForm } from "./ResetForm";

export default function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div style={{ marginBottom: 18 }}>
          <Brand subtitle="Network Portal" />
        </div>
        <div className="card">
          <h1 style={{ margin: "0 0 12px", fontSize: 22 }}>Reset your password</h1>
          <ResetForm />
          <p className="small" style={{ marginBottom: 0 }}>
            <Link className="link" href="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
