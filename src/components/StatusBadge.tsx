import { SHOP_STATUS_LABEL, STATUS_LABEL, type WoStatus } from "@/lib/format";

export function StatusBadge({ status, shop = false }: { status: WoStatus; shop?: boolean }) {
  const label = (shop && SHOP_STATUS_LABEL[status]) || STATUS_LABEL[status] || status;
  return <span className={`status ${status}`}>{label}</span>;
}
