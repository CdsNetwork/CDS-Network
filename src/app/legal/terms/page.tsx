import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { loadLegal } from "@/lib/legal";

// The wording lives in src/content/legal/terms.md.
export const dynamic = "force-static";
export const metadata: Metadata = { title: "Terms of Use | CDS Network Portal" };

export default async function TermsPage() {
  return <LegalPage doc={loadLegal("terms")} />;
}
