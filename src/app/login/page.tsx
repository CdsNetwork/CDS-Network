import Link from "next/link";
import { Brand } from "@/components/Brand";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { reason, next } = await searchParams;
  const notice =
    reason === "no-access"
      ? "This login has no access yet. Ask CDS to set up your account."
      : reason === "signed-out"
        ? "Your session has ended. Sign in again to continue."
        : reason === "link-expired"
          ? "That link has expired or was already used. Ask CDS for a new invite, or reset your password."
          : undefined;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div style={{ marginBottom: 18 }}>
          <Brand subtitle="Network Portal" />
        </div>
        <div className="card">
          <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Sign in</h1>
          <p className="small" style={{ marginTop: 0 }}>For CDS staff and network shops. Logins are by invitation.</p>
          <LoginForm notice={notice} next={typeof next === "string" ? next : undefined} />
        </div>
        <p className="small legal-links">
          <Link className="link" href="/legal/terms">Terms of Use</Link>
          <span aria-hidden="true"> · </span>
          <Link className="link" href="/legal/privacy">Privacy Policy</Link>
        </p>
      </div>
    </main>
  );
}
