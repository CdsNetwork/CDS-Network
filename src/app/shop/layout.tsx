import { Brand } from "@/components/Brand";
import { SignOutButton } from "@/components/SignOutButton";
import { requireShop } from "@/lib/auth";

export default async function ShopLayout({ children }: LayoutProps<"/shop">) {
  const profile = await requireShop();
  return (
    <>
      <header className="top-bar">
        <div className="top">
          <Brand subtitle="CDS Affiliate Portal" />
          <div className="spacer" />
          <span className="chip hide-sm">Affiliate: {profile.affiliate_name}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="main">{children}</main>
    </>
  );
}
