"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SearchSelect, type SearchOption } from "@/components/SearchSelect";

/** Shop search for the Affiliate View: picking a shop opens its job list. */
export function ShopPicker({ options, value }: { options: SearchOption[]; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <SearchSelect
      id="preview-shop"
      options={options}
      value={value}
      disabled={pending}
      limit={150}
      placeholder="Search shop name, city or state..."
      onChange={(v) => {
        if (!v || v === value) return;
        startTransition(() => router.push(`/cds/affiliate-view?shop=${encodeURIComponent(v)}`));
      }}
    />
  );
}
