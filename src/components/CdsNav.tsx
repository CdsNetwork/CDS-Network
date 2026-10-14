"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/cds", icon: "▦", label: "Dashboard", exact: true },
  { href: "/cds/work-orders/new", icon: "＋", label: "Create Work Order" },
  { href: "/cds/pickup", icon: "🚚", label: "Pickup / Delivery" },
  { href: "/cds/shipping", icon: "📦", label: "Shipping" },
  { href: "/cds/catalog", icon: "▤", label: "Parts & Services" },
  { href: "/cds/pricing", icon: "$", label: "Customer Pricing" },
  { href: "/cds/admin", icon: "⚙", label: "Admin" },
];

export function CdsNav({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className={mobile ? "mobile-nav" : undefined} aria-label="Main">
      {NAV.map((item) => {
        const active = item.exact
          ? pathname === item.href || pathname.startsWith("/cds/work-orders/") && !pathname.endsWith("/new") && item.href === "/cds"
          : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={`navbtn${active ? " active" : ""}`}>
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
