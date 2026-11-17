import { cookies } from "next/headers";
import { CdsSidebar } from "@/components/CdsSidebar";
import { requireCds } from "@/lib/auth";
import { isCollapsed, SIDEBAR_COOKIE } from "@/lib/sidebar";

export default async function CdsLayout({ children }: LayoutProps<"/cds">) {
  const profile = await requireCds();
  // Read on the server so the first paint already has the chosen sidebar width (no flash).
  const collapsed = isCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <div className="cds-shell">
      <CdsSidebar fullName={profile.full_name} initialCollapsed={collapsed} />
      <main className="main cds-main">{children}</main>
    </div>
  );
}
