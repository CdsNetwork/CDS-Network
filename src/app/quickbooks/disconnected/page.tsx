import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/Brand";

export const metadata: Metadata = { title: "QuickBooks disconnected | CDS Network Portal" };

/**
 * Intuit's Disconnect URL: where QuickBooks sends a user who disconnects the app from the
 * QuickBooks side. Intuit has already revoked the tokens by then. The page changes nothing
 * (a public GET must not); the stored connection is cleared in Admin > Settings, and any
 * QuickBooks call made with the revoked tokens asks CDS to connect again.
 */
export default function QuickBooksDisconnectedPage() {
  return (
    <main className="legal-page">
      <div className="legal-card">
        <Brand subtitle="Network Portal" />
        <div className="card" style={{ marginTop: 18 }}>
          <h1>The portal is disconnected from QuickBooks</h1>
          <p>
            The CDS Network Portal no longer has access to your QuickBooks Online company. It cannot read customers, items
            or tax settings from QuickBooks or create invoices there until it is connected again. Invoices the portal
            already created stay in QuickBooks.
          </p>
          <h2>To reconnect</h2>
          <p>
            Only a CDS admin can reconnect, and the person approving the connection must be an admin of the QuickBooks
            company. Sign in to the portal and choose <strong>Connect QuickBooks</strong> in Admin, Settings, or use the
            link below.
          </p>
          <p>
            <Link className="btn btn-primary" href="/quickbooks/connect">
              Connect QuickBooks again
            </Link>
          </p>
          <p className="small">
            If Admin, Settings still shows QuickBooks as connected, choose Disconnect QuickBooks there to clear the old
            connection, then connect again.
          </p>
        </div>
        <p className="small legal-links">
          <Link className="link" href="/legal/terms">Terms of Use</Link>
          <span aria-hidden="true"> · </span>
          <Link className="link" href="/legal/privacy">Privacy Policy</Link>
          <span aria-hidden="true"> · </span>
          <Link className="link" href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
