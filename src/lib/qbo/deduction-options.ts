import type { SearchOption } from "@/components/SearchSelect";
import type { QboAccount, QboItem } from "./api";

/** Item types a bill line can carry as a plain credit (no stock, no bundle). */
const CREDIT_ITEM_TYPES = new Set(["Service", "NonInventory"]);

/**
 * Choices for "Shipping deductions go to" on Admin > Shop bills: the expense accounts, and the
 * service and non-inventory items (CDS created "Shipping Credit" for this, 2026-11-17). Values
 * are "<kind>::<id>::<name>", read by saveBillSetting.
 */
export function deductionOptions(accounts: QboAccount[], items: QboItem[] | null): SearchOption[] {
  const itemOptions: SearchOption[] = (items ?? [])
    .filter((i) => i.Active !== false && CREDIT_ITEM_TYPES.has(i.Type ?? ""))
    .map((i) => {
      const name = i.FullyQualifiedName ?? i.Name;
      return { value: `item::${i.Id}::${name}`, label: name, hint: `Product or service item - QuickBooks id ${i.Id}` };
    });
  const accountOptions: SearchOption[] = accounts.map((a) => ({
    value: `account::${a.Id}::${a.FullyQualifiedName ?? a.Name}`,
    label: a.FullyQualifiedName ?? a.Name,
    hint: [a.AccountType, a.AcctNum && `No. ${a.AcctNum}`, `QuickBooks id ${a.Id}`].filter(Boolean).join(" - "),
  }));
  return [...itemOptions, ...accountOptions];
}
