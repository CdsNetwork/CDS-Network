import Link from "next/link";
import { Brand } from "@/components/Brand";
import { DRAFT_NOTICE, type Inline, type LegalDoc } from "@/lib/legal";

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "strong") return <strong key={i}>{p.text}</strong>;
        if (p.type === "confirm") return <mark key={i} className="to-confirm">{p.text}</mark>;
        if (p.type === "link") {
          return p.href.startsWith("/") ? (
            <Link key={i} className="link" href={p.href}>{p.text}</Link>
          ) : (
            <a key={i} className="link" href={p.href} rel="noopener noreferrer">{p.text}</a>
          );
        }
        return p.text;
      })}
    </>
  );
}

/** A legal document from src/content/legal, readable without a login. */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <main className="legal-page">
      <div className="legal-card">
        <Brand subtitle="Network Portal" />
        <article className="card legal" style={{ marginTop: 18 }}>
          {doc.draft && (
            <div className="notice warning" role="note">
              <strong>{DRAFT_NOTICE}</strong>
            </div>
          )}
          <h1>{doc.title}</h1>
          {doc.updated && <p className="small">Last updated: {doc.updated}</p>}
          {doc.blocks.map((b, i) => {
            if ("items" in b) {
              const List = b.type;
              return <List key={i}>{b.items.map((it, j) => <li key={j}><Text parts={it} /></li>)}</List>;
            }
            const Tag = b.type;
            return <Tag key={i}><Text parts={b.inline} /></Tag>;
          })}
        </article>
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
