import { Brand } from "@/components/Brand";
import { CdsNav } from "@/components/CdsNav";
import { SignOutButton } from "@/components/SignOutButton";
import { requireCds } from "@/lib/auth";

export default async function CdsLayout({ children }: LayoutProps<"/cds">) {
  const profile = await requireCds();
  return (
    <>
      <header className="top-bar">
        <div className="top">
          <Brand subtitle="CDS Network Portal" />
          <div className="spacer" />
          <span className="chip hide-sm">US operations</span>
          <span className="chip hide-sm">{profile.full_name}</span>
          <SignOutButton />
        </div>
      </header>
      <CdsNav mobile />
      <div className="app">
        <aside className="sidebar">
          <CdsNav />
        </aside>
        <main className="main">{children}</main>
      </div>
    </>
  );
}
