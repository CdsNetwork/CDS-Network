import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { loadLegal } from "@/lib/legal";

// The wording lives in src/content/legal/privacy.md.
export const dynamic = "force-static";
export const metadata: Metadata = { title: "Privacy Policy | CDS Network Portal" };

export default async function PrivacyPage() {
  return <LegalPage doc={loadLegal("privacy")} />;
}
