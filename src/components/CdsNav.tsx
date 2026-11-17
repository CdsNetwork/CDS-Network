"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/cds", icon: "▦", label: "Dashboard", exact: true },
  { href: "/cds/work-orders/new", icon: "＋", label: "Create Work Order" },
  { href: "/cds/intake", icon: "✉", label: "Email Intake" },
  { href: "/cds/affiliate-view", icon: "⇄", label: "Affiliate View" },
  { href: "/cds/pickup", icon: "🚚", label: "Pickup / Delivery" },
  { href: "/cds/shipping", icon: "📦", label: "Shipping" },
  { href: "/cds/catalog", icon: "▤", label: "Parts & Services" },
  { href: "/cds/pricing", icon: "$", label: "Customer Pricing" },
  { href: "/cds/admin", icon: "⚙", label: "Admin" },
];

// Collapsed shows the icons only; each link keeps its label as the accessible name and tooltip.
export function CdsNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className={`cds-nav${collapsed ? " collapsed" : ""}`} aria-label="Main">
      {NAV.map((item) => {
        const active = item.exact
          ? pathname === item.href || pathname.startsWith("/cds/work-orders/") && !pathname.endsWith("/new") && item.href === "/cds"
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
            aria-current={active ? "page" : undefined}
            className={`navbtn${active ? " active" : ""}`}
          >
            <span aria-hidden>{item.icon}</span>
            {!collapsed && item.label}
          </Link>
        );
      })}
    </nav>
  );
}
