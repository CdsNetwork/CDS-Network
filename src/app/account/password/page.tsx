import { Brand } from "@/components/Brand";
import { PasswordForm } from "./PasswordForm";

export default function SetPasswordPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div style={{ marginBottom: 18 }}>
          <Brand subtitle="Network Portal" />
        </div>
        <div className="card">
          <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Choose your password</h1>
          <p className="small" style={{ marginTop: 0 }}>At least 10 characters.</p>
          <PasswordForm />
        </div>
      </div>
    </main>
  );
}
